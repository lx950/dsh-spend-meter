/**
 * dsh-spend-panel — server half.
 *
 * Watches every `assistant/message` event on the host, prices it with the real
 * DeepSeek rate card (cache hit / cache miss / output, peak vs off-peak, Beijing
 * time), keeps a per-day ledger in `$DSH_HOME/spend-meter/ledger.json`, and
 * serves it over the host's Fetch route channel (`connection.fetch.register`),
 * with a plain `webServer` GET route as a debugging fallback.
 *
 * Routes (POST, JSON body — Fetch style):
 *   /api/dsh-spend/state   { session } -> live state for one conversation
 *   /api/dsh-spend/days    { limit }   -> recent days, oldest first
 *   /api/dsh-spend/health  {}          -> liveness + diagnostics
 *
 * Read-only fallbacks (GET, for curl / external tooling):
 *   /api/dsh-spend/state?session=<id>, /api/dsh-spend/days?limit=30,
 *   /api/dsh-spend/health
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  HOLIDAY_VALLEY_FROM_SEC,
  PEAK_HOURS,
  WEEKEND_VALLEY_FROM_SEC,
  beijingDayKey,
  costOf,
  isPeakTime,
} from './pricing.js'
import { advanceCostDay, spentOfDay } from './attribution.js'
import { apiKeyFrom, credentialsPath, grantFrom, readCredentialsFile } from './credentials.js'
import { createLedger, dshHome } from './ledger.js'
import { readPlatformGrant, readPlatformSummary } from './platform.js'
import { calibrationOf, readDayUsage, sessionKey, trackBalanceDay } from './transcripts.js'

export const name = 'dsh-spend-panel'
export const inject = []

export const VERSION = '0.4.4'

const BALANCE_TTL_MS = 45_000
const BALANCE_REFRESH_MS = 60_000
const BALANCE_CALL_TIMEOUT_MS = 8_000
const BALANCE_INFLIGHT_STALE_MS = 20_000
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
/**
 * After a turn finishes the Platform charges it a moment later, so the panel polls
 * the spend counter quickly for a short while instead of waiting for the slow tick.
 */
const COST_FAST_POLL_MS = 2_000
/** While the charge is fresh, poll this tightly; after this burst, back off. */
const COST_FAST_POLL_BURST_MS = 20_000
const COST_FAST_POLL_SLOW_MS = 6_000
const COST_FAST_POLL_WINDOW_MS = 120_000
/** How often the live ledger is reconciled against the host's transcripts. */
const TRANSCRIPT_SYNC_MS = 30_000
/** Model id used when an event carries no model name. */
const DEFAULT_MODEL = 'deepseek-flash'

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const short = (err) => String((err && err.message) || err || '').slice(0, 160)

/** Epoch ms of the next peak/off-peak switch, or null when unknown. */
export function nextPeakChangeAt(ms) {
  const n = Math.floor(Number(ms) / 1000)
  if (!Number.isFinite(n)) return null
  const cur = isPeakTime(ms)
  const day0 = Math.floor((n + 8 * 3600) / 86400) * 86400
  for (let d = 0; d <= 12; d += 1) {
    for (const edge of [0, ...PEAK_HOURS.map((h) => h[0]), ...PEAK_HOURS.map((h) => h[1]), 18]) {
      const cand = day0 + d * 86400 + edge * 3600 - 8 * 3600
      if (cand <= n + 1) continue
      if (isPeakTime(cand * 1000) !== cur) return cand * 1000
    }
  }
  return null
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

function hostOf(headers) {
  try {
    return new URL(`http://${String((headers && headers.host) || '')}`).hostname
  } catch {
    return ''
  }
}

/** Reject anything that is not a first-party, same-origin page request. */
function rejected(root, req) {
  const conn = safeGet(root, 'connection')
  if (conn && typeof conn.requestRejection === 'function') {
    try {
      // Hand the host the real IncomingMessage: it inspects origin/sec-fetch
      // headers, so a synthetic object could be fenced off by mistake.
      const code = conn.requestRejection(req)
      if (code) return typeof code === 'number' ? code : 403
      return null
    } catch {
      return 403
    }
  }
  if (String(process.env.DSH_SPEND_METER_ALLOW_REMOTE || '') === '1') return null
  const headers = (req && req.headers) || {}
  return LOOPBACK.has(hostOf(headers)) ? null : 403
}

/**
 * Read an optional service under every mechanism this host offers.
 *
 * `ctx.get(name)` resolves through the root isolation map, which a host that
 * scopes services per plugin can leave empty — the symptom is a service the
 * host clearly runs (its settings page works) reading back as `undefined`.
 * Property access `ctx[name]` goes through the fiber chain instead and works
 * inside an `inject(...)` callback, so try that first when we have one.
 */
function safeGet(ctx, service, { property = false } = {}) {
  if (!ctx) return undefined
  if (property) {
    try {
      const value = ctx[service]
      if (value !== undefined && value !== null) return value
    } catch {
      /* property reads outside inject() throw: "cannot get property ... without inject" */
    }
  }
  if (typeof ctx.get === 'function') {
    for (const strict of [true, false]) {
      try {
        const value = ctx.get(service, strict)
        if (value !== undefined && value !== null) return value
      } catch {
        /* service missing or not ready */
      }
    }
  }
  return undefined
}

function jsonHeaders(origin) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  if (origin) headers['access-control-allow-origin'] = origin
  return headers
}

function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export function apply(root, config = {}) {
  const log = (msg) => {
    try {
      if (root.logger && typeof root.logger.info === 'function') root.logger.info(`[dsh-spend-panel] ${msg}`)
      else console.info(`[dsh-spend-panel] ${msg}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  const ledgerFile = config.ledgerFile || path.join(dshHome(), 'spend-meter', 'ledger.json')
  const diagFile = path.join(path.dirname(ledgerFile), 'diag.json')
  const ledger = createLedger({ file: ledgerFile, log, normalizeSession: sessionKey })
  const disposers = []

  // ---- live per-session state -------------------------------------------------
  /** sessionId -> current turn aggregate */
  const turns = new Map()
  /** sessionId -> committed previous turn */
  const lastTurns = new Map()
  /** sessionId -> the aggregate that is actually in flight right now */
  const live = new Map()
  /**
   * The session that produced the most recent event. A slot does not have to tell
   * the panel which conversation it is rendering, but the events do: this is the
   * best available answer to "which session is the user looking at".
   */
  let activeSessionKey = ''
  let activeSessionAt = 0
  /** transcript reconciliation: file -> parsed records (see lib/transcripts.js) */
  const transcriptCache = new Map()
  const transcript = { at: 0, files: 0, error: null, day: null, amount: 0 }
  const sessionsRoot = config.sessionsRoot || path.join(dshHome(), 'sessions')
  /** Credential store, read directly when the injected service answers "not found". */
  const credentialsFile = config.credentialsFile || credentialsPath()
  /** How long a balance reading is reused before another poll is allowed. */
  const balanceTtlMs = Math.max(1_000, Number(config.balanceTtlMs) || BALANCE_TTL_MS)
  /** Persisted balance-delta book: what the account actually paid today. */
  let balanceDay = ledger.getBalanceDay()
  /** Learned chart-vs-invoice ratio, applied to windows we could not measure. */
  let calibration = ledger.getCalibration()

  const balance = {
    value: null,
    currency: 'CNY',
    source: null,
    at: 0,
    error: null,
    recharge: null,
    bonus: null,
    diag: null,
  }
  const diag = {
    version: VERSION,
    startedAt: Date.now(),
    balance: { at: 0, apiKey: null, account: null },
    platform: null,
    events: 0,
    lastEventAt: 0,
    sessions: 0,
    polls: 0,
    lastPollAt: 0,
    routes: { fetch: null, http: null },
    services: {},
    transcript: { at: 0, files: 0, error: null, amount: 0 },
    transcriptFirstAt: null,
    lastSession: null,
    probe: null,
  }
  let balanceInFlight = null
  let balanceInFlightAt = 0
  let svcCtx = null
  let serverOrigin = ''
  let injectedCredentials = null
  let injectedAccount = null

  // ---- Platform account book --------------------------------------------------
  /**
   * Latest Platform reading. Unlike the public API-key balance (cents), this carries
   * the wallet with eight decimals *and* a lifetime spend counter.
   */
  const platform = { at: 0, ok: false, error: null, balance: null, bonus: null, totalCosts: null, currency: 'CNY', credentialSource: null }
  /** Persisted spend-counter book: today's opening reading is what makes the counter mean "today". */
  let costDay = ledger.getCostDay()
  let platformInFlight = null
  let fastPollUntil = 0
  let fastPollTimer = null
  /** Charges seen while no turn was waiting (subagents, pre-install spend). */
  let unattributed = 0

  const round8 = (n) => Math.round((Number(n) || 0) * 1e8) / 1e8

  function serviceOf(service) {
    const cached = service === 'credentials' ? injectedCredentials : injectedAccount
    if (cached) return cached
    if (svcCtx) {
      const viaInjectCtx = safeGet(svcCtx, service, { property: true })
      if (viaInjectCtx !== undefined) return viaInjectCtx
    }
    const viaRoot = safeGet(root, service)
    if (viaRoot !== undefined) return viaRoot
    const viaRootProperty = safeGet(root, service, { property: true })
    return viaRootProperty
  }

  let diagWriteAt = 0

  /** Persist the diagnostics snapshot; polls call this often, so throttle it. */
  function writeDiag(force = false) {
    const now = Date.now()
    if (!force && now - diagWriteAt < 5_000) return
    diagWriteAt = now
    diag.balance.at = balance.at
    try {
      fs.mkdirSync(path.dirname(diagFile), { recursive: true })
      fs.writeFileSync(diagFile, JSON.stringify(diag, null, 2))
    } catch {
      /* diagnostics are best-effort */
    }
  }

  function commit(sessionId, agg) {
    if (!agg || !(agg.amount > 0)) return
    const entry = trackTurn(sessionId, agg.turn, agg.at || Date.now(), agg.amount)
    // Cash the Platform has already charged for this turn, if any.
    agg.actual = entry.collected > 0 ? round8(entry.collected) : null
    lastTurns.set(sessionId, agg)
    ledger.setSession(sessionId, {
      turn: agg.turn,
      amount: Math.round(agg.amount * 1e8) / 1e8,
      tokens: agg.tokens,
      at: agg.at,
      model: agg.model,
      actual: agg.actual,
    })
  }

  // ---- Platform spend counter -------------------------------------------------
  /**
   * Turns that are in flight or only just finished, newest last. Charges land on the
   * newest one: the Platform debits a step a few seconds after it completes, so the
   * money for a turn arrives while that turn (or its immediate successor) is running.
   */
  const recentTurns = []

  function trackTurn(sessionId, turn, at, estimate) {
    const existing = recentTurns.find((item) => item.sessionId === sessionId && item.turn === turn)
    if (existing) {
      existing.estimate = Math.max(existing.estimate, num(estimate))
      existing.at = at
      return existing
    }
    const entry = { sessionId, turn, at, estimate: num(estimate), collected: 0 }
    recentTurns.push(entry)
    while (recentTurns.length > 4) recentTurns.shift()
    scheduleFastPoll()
    return entry
  }

  let fastPollDisposed = false
  function scheduleFastPoll() {
    const startedAt = Date.now()
    fastPollUntil = Math.max(fastPollUntil, startedAt + COST_FAST_POLL_WINDOW_MS)
    if (fastPollDisposed) return
    if (fastPollTimer !== null) return
    const tick = () => {
      fastPollTimer = null
      if (fastPollDisposed || Date.now() > fastPollUntil) return
      refreshPlatform(true).catch(() => {})
      const burst = Date.now() - startedAt < COST_FAST_POLL_BURST_MS
      fastPollTimer = setTimeout(tick, burst ? COST_FAST_POLL_MS : COST_FAST_POLL_SLOW_MS)
      if (typeof fastPollTimer.unref === 'function') fastPollTimer.unref()
    }
    fastPollTimer = setTimeout(tick, COST_FAST_POLL_MS)
    if (typeof fastPollTimer.unref === 'function') fastPollTimer.unref()
  }
  // Registered once: every turn schedules a poll, so a disposer per call would grow
  // without bound.
  disposers.push(() => {
    fastPollDisposed = true
    if (fastPollTimer !== null) clearTimeout(fastPollTimer)
    fastPollTimer = null
  })

  /** Give one turn the money the counter just grew by. */
  function assignCharge(entry, amount) {
    const value = round8(amount)
    if (!(value > 0)) return
    entry.collected = round8(entry.collected + value)
    const known = lastTurns.get(entry.sessionId)
    if (known && known.turn === entry.turn) {
      known.actual = entry.collected
      ledger.setSession(entry.sessionId, {
        turn: known.turn,
        amount: round8(known.amount),
        tokens: known.tokens,
        at: known.at,
        model: known.model,
        actual: entry.collected,
      })
    }
    writeDiag()
  }

  /**
   * Attribute a newly observed charge. One conversation is normally active at a time,
   * so the newest turn takes it; charges seen while nothing was running (spend from
   * before the plugin loaded, background subagents) are counted as unattributed.
   */
  function attributeCharge(delta) {
    const amount = round8(delta)
    if (!(amount > 0)) return
    const target = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1] : null
    if (!target) {
      unattributed = round8(unattributed + amount)
      return
    }
    assignCharge(target, amount)
  }

  /** Fold one Platform reading into the counter book + turn attribution. */
  function recordPlatform(summary) {
    const now = Date.now()
    const dayKey = beijingDayKey(now)
    const counter = summary && Number.isFinite(summary.totalCosts) ? summary.totalCosts : null
    if (counter !== null) {
      const { book, delta } = advanceCostDay(costDay, { dayKey, counter, now })
      if (delta > 0) attributeCharge(delta)
      costDay = book
      ledger.setCostDay(costDay)
    }
    return costDay
  }

  /**
   * One Platform summary read: wallet balance (8 decimals) + lifetime spend counter.
   * This is the request the desktop app itself makes after account sign-in, so it is
   * the closest thing to the invoice that a plugin can reach.
   */
  function refreshPlatform(force = false) {
    if (platformInFlight) return platformInFlight
    if (!force && platform.at && Date.now() - platform.at < balanceTtlMs) return Promise.resolve(platform)
    platformInFlight = (async () => {
      try {
        return await readPlatform()
      } catch (err) {
        platform.ok = false
        platform.error = `读取平台账单失败: ${short(err)}`
        platform.at = Date.now()
        diag.platform = platformSnapshot()
        writeDiag(true)
        return platform
      }
    })().finally(() => {
      platformInFlight = null
    })
    return platformInFlight
  }

  async function readPlatform() {
    const creds = serviceOf('credentials')
    let grant = null
    let error = null
    let source = null
    if (creds && typeof creds.readRecord === 'function') {
      const viaService = await readPlatformGrant(creds)
      grant = viaService.grant
      error = viaService.error
      if (grant) source = 'service'
    } else {
      error = '当前 DSH 没有凭据服务'
    }
    // The injected credentials service can be scoped such that it answers
    // "nothing stored" while the store on disk is fine; fall back to the file.
    if (!grant) {
      const fromFile = grantFrom(readCredentialsFile(credentialsFile))
      if (fromFile) {
        grant = fromFile
        source = 'file'
        error = null
      }
    }
    platform.credentialSource = source
    if (!grant) {
      platform.ok = false
      platform.error = error
      platform.at = Date.now()
      diag.platform = platformSnapshot()
      writeDiag(true)
      return platform
    }
    const at = Date.now()
    const res = await readPlatformSummary({
      token: grant.token,
      origin: grant.origin,
      fetchImpl: fetch,
      timeoutMs: BALANCE_CALL_TIMEOUT_MS,
      at,
    })
    platform.at = res.at || at
    if (!res.ok) {
      platform.ok = false
      platform.error = res.error
    } else {
      platform.ok = true
      platform.error = null
      platform.balance = res.balance
      platform.bonus = res.bonus
      platform.totalCosts = res.totalCosts
      platform.currency = res.currency
      recordPlatform(res)
      syncFromTranscripts()
    }
    diag.platform = platformSnapshot()
    writeDiag(true)
    return platform
  }

  /** The part of the Platform state worth keeping in `diag.json`. */
  function platformSnapshot() {
    return {
      at: platform.at,
      ok: platform.ok,
      error: platform.error,
      balance: platform.balance,
      bonus: platform.bonus,
      totalCosts: platform.totalCosts,
      credentialSource: platform.credentialSource || null,
    }
  }


  /**
   * Fold the host's own transcripts into the ledger.
   *
   * Live events only cover messages seen while this plugin is running, so a
   * mid-day install (or any restart of the app) leaves a hole in "today". The
   * transcripts are complete and authoritative, so we reconcile against them and
   * also recover the last finished turn of sessions that predate the install.
   */
  let syncing = false
  function syncFromTranscripts() {
    if (syncing) return
    syncing = true
    try {
      const now = Date.now()
      const dayKey = beijingDayKey(now)
      // Whichever money book is live decides where "measured" starts: the charge
      // counter first (exact), the wallet balance as fallback.
      const liveBook = costDay && costDay.day === dayKey ? costDay : balanceDay && balanceDay.day === dayKey ? balanceDay : null
      const splitAt = liveBook ? liveBook.since || null : null
      const res = readDayUsage({
        sessionsRoot,
        dayKey,
        cache: transcriptCache,
        now,
        splitAt,
      })
      const day = ledger.reconcileDay(dayKey, res.day)
      transcript.at = now
      transcript.files = res.files
      transcript.error = res.error
      transcript.day = dayKey
      transcript.amount = day ? day.amount : 0
      transcript.before = (day && day.before) || 0
      transcript.after = (day && day.after) || 0
      transcript.since = splitAt
      // Same window seen two ways: the real charge and the priced transcripts.
      // Their ratio corrects the pre-observation backfill.
      if (liveBook && splitAt) {
        const booked = costDay && costDay.day === dayKey ? spentOfDay(liveBook) : num(liveBook.spent)
        const next = calibrationOf(booked, transcript.after, calibration)
        if (next && next !== calibration) {
          calibration = next
          ledger.setCalibration(next)
        }
      }
      if (res.firstAt) diag.transcriptFirstAt = res.firstAt
      for (const [sessionId, agg] of Object.entries(res.sessions || {})) {
        if (!agg || !(agg.amount > 0)) continue
        if (turns.has(sessionId)) continue // a live turn is authoritative for that session
        const known = lastTurns.get(sessionId) || ledger.getSession(sessionId)
        if (known && num(known.at) >= num(agg.at)) continue
        const value = {
          turn: agg.turn,
          amount: Math.round(agg.amount * 1e8) / 1e8,
          tokens: agg.tokens,
          at: agg.at,
          model: agg.model,
        }
        lastTurns.set(sessionId, value)
        ledger.setSession(sessionId, value)
      }
      diag.transcript = {
        at: transcript.at,
        files: transcript.files,
        error: transcript.error,
        amount: transcript.amount,
        before: transcript.before || 0,
        after: transcript.after || 0,
        factor: calibration && calibration.factor ? calibration.factor : 1,
        since: transcript.since || null,
      }
      writeDiag()
    } catch (err) {
      transcript.error = short(err)
      diag.transcript = {
        at: transcript.at,
        files: transcript.files,
        error: transcript.error,
        amount: transcript.amount,
        before: transcript.before || 0,
        since: transcript.since || null,
      }
    } finally {
      syncing = false
    }
  }

  /** Keep the balance-delta book up to date: this is what the account paid. */
  function recordBalance(value) {
    const v = Number(value)
    if (!Number.isFinite(v)) return
    const dayKey = beijingDayKey(Date.now())
    balanceDay = trackBalanceDay(balanceDay, v, dayKey)
    ledger.setBalanceDay(balanceDay)
    // `since` may just have been established for the day, which changes how much
    // of today's usage predates the first balance reading.
    syncFromTranscripts()
  }


  function onSessionEvent(session, event) {
    try {
      const sessionId = sessionKey((session && (session.id || session.sessionId)) || '')
      if (sessionId) {
        activeSessionKey = sessionId
        activeSessionAt = Date.now()
      }
      const type = event && event.type
      if (!type) return
      if (type === 'turn/end') {
        // Not every host emits `turn/end`; when it does, it settles the turn early.
        if (!sessionId) return
        const agg = turns.get(sessionId)
        turns.delete(sessionId)
        live.delete(sessionId)
        commit(sessionId, agg)
        return
      }
      const data = event && event.data
      if (!data || typeof data !== 'object') return
      diag.events += 1
      diag.lastEventAt = Date.now()
      if (type !== 'assistant/message') return
      const usage = data.usage
      if (!usage || typeof usage !== 'object') return
      const turn = num(data.turn)
      const model = (data.message && data.message.source && data.message.source.model) || DEFAULT_MODEL
      const at = Date.now()
      const { amount, tokens } = costOf(usage, model, at)
      const dayKey = beijingDayKey(at)
      ledger.add({ dayKey, model, amount, tokens: tokens.input + tokens.cache + tokens.output })
      if (!sessionId) return
      const prev = turns.get(sessionId)
      if (prev && prev.turn !== turn) {
        // A new turn started: the previous one is now "last turn".
        commit(sessionId, prev)
        const fresh = { turn, amount: 0, tokens: 0, model, at }
        turns.set(sessionId, fresh)
        live.set(sessionId, fresh)
      } else if (!prev) {
        const fresh = { turn, amount: 0, tokens: 0, model, at }
        turns.set(sessionId, fresh)
        live.set(sessionId, fresh)
      }
      const agg = turns.get(sessionId)
      agg.amount += amount
      agg.tokens += tokens.input + tokens.cache + tokens.output
      agg.model = model
      agg.at = at
      // Track the live turn so charges that settle during it land on it.
      trackTurn(sessionId, turn, at, agg.amount)
      diag.sessions = turns.size
    } catch (err) {
      log(`session event failed: ${short(err)}`)
    }
  }

  try {
    const off = root.on('session/event', onSessionEvent)
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    log(`cannot subscribe to session/event: ${short(err)}`)
  }
  try {
    const off = root.on('session/disposed', (session) => {
      // Keys in `turns`/`live` are canonical, so the host's raw id must be
      // normalised the same way or the in-flight turn of the closing session is
      // lost (it would never be committed as "last turn").
      const id = sessionKey(session && (session.id || session.sessionId))
      if (!id) return
      const agg = turns.get(id)
      turns.delete(id)
      live.delete(id)
      commit(id, agg)
      lastTurns.delete(id)
    })
    if (typeof off === 'function') disposers.push(off)
  } catch {
    /* older hosts */
  }

  // ---- balance ----------------------------------------------------------------
  function accountDiag() {
    return { service: false, status: null, wallets: null, error: null, hasGetBalance: false, userId: null }
  }

  async function balanceFromApiKey() {
    const info = { entry: 'api-key', error: null }
    diag.balance.apiKey = info
    const creds = serviceOf('credentials')
    if (!diag.services.credentials) diag.services.credentials = creds ? 'get' : false
    let cred = null
    if (creds && typeof creds.resolve === 'function') {
      try {
        cred = await withTimeout(Promise.resolve(creds.resolve('DEEPSEEK_API_KEY')), 3_000, 'credentials.resolve')
      } catch (err) {
        info.error = `读取 DEEPSEEK_API_KEY 失败: ${short(err)}`
      }
    } else {
      info.error = '当前 DSH 没有凭据服务'
    }
    let key = cred && (cred.value || cred.secret || cred.token)
    let keySource = cred ? String(cred.source || 'unknown') : null
    // Same scoping trap as the Platform grant: the store on disk may hold the key
    // even when the injected service reports nothing.
    if (!key) {
      const fromFile = apiKeyFrom(readCredentialsFile(credentialsFile))
      if (fromFile) {
        key = fromFile
        keySource = 'file'
        info.error = null
      }
    }
    if (!key) {
      info.error = info.error || '未配置 DEEPSEEK_API_KEY（账号登录用户走账号余额）'
      return null
    }
    info.keySource = keySource
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(BALANCE_CALL_TIMEOUT_MS),
      })
    } catch (err) {
      info.error = `请求余额接口失败: ${short(err)}`
      return null
    }
    if (!res.ok) {
      info.error = `余额接口返回 HTTP ${res.status}`
      return null
    }
    let data = null
    try {
      data = await res.json()
    } catch (err) {
      info.error = `余额接口返回的不是 JSON: ${short(err)}`
      return null
    }
    const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
    const pick =
      infos.find((x) => x && x.currency === 'CNY' && num(x.total_balance) > 0) ||
      infos.find((x) => x && num(x.total_balance) > 0) ||
      infos.find((x) => x && x.currency === 'CNY') ||
      infos[0]
    if (!pick) {
      info.error = '余额接口没有返回钱包'
      return null
    }
    info.ok = true
    return {
      value: num(pick.total_balance),
      currency: String(pick.currency || 'CNY'),
      recharge: num(pick.topped_up_balance),
      bonus: num(pick.granted_balance),
      source: 'api-key',
    }
  }

  async function balanceFromAccount() {
    const info = accountDiag()
    diag.balance.account = info
    const account = serviceOf('deepseekAccount')
    if (!diag.services.deepseekAccount) diag.services.deepseekAccount = account ? 'get' : false
    if (!account || typeof account.getBalance !== 'function') {
      info.error = '当前 DSH 没有账号服务（deepseekAccount）'
      return null
    }
    info.service = true
    info.hasGetBalance = true
    try {
      const state = typeof account.getState === 'function' ? account.getState() : null
      const user = state && (state.userId || (state.profile && state.profile.userId))
      if (user) info.userId = String(user)
    } catch {
      /* identity is optional */
    }
    const client = {
      version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
      locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    let result = null
    try {
      result = await withTimeout(Promise.resolve(account.getBalance(client)), BALANCE_CALL_TIMEOUT_MS, 'account.getBalance')
    } catch (err) {
      info.error = `账号余额接口调用失败: ${short(err)}`
      return null
    }
    if (!result) {
      info.error = '未登录 DeepSeek 账号（账号服务返回空）'
      return null
    }
    info.status = String(result.status || 'unknown')
    if (result.status !== 'ready') {
      info.error = `账号余额接口未就绪（${info.status}）`
      return null
    }
    const accNum = (v) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const normRaw = Array.isArray(result.value) ? result.value : []
    const bonusRaw = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
    const usable = (list) => list.filter((w) => w && accNum(w.balance) !== null)
    const normWallets = usable(normRaw)
    const bonusWallets = usable(bonusRaw)
    const all = normWallets.concat(bonusWallets)
    info.wallets = { normal: normWallets.length, bonus: bonusWallets.length }
    if (all.length === 0) {
      info.error = normRaw.length || bonusRaw.length ? '钱包字段不可用' : '账号没有余额钱包'
      return null
    }
    const currencyOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
    const nonzero = all.filter((w) => Number(w.balance) > 0)
    const pick =
      nonzero.find((w) => currencyOf(w) === 'CNY') ||
      nonzero[0] ||
      all.find((w) => currencyOf(w) === 'CNY') ||
      all[0]
    const currency = currencyOf(pick)
    const sum = (list) =>
      list.filter((w) => w && currencyOf(w) === currency).reduce((s, w) => s + Number(w.balance), 0)
    info.ok = true
    return {
      value: Number((sum(normWallets) + sum(bonusWallets)).toFixed(6)),
      currency,
      recharge: Number(sum(normWallets).toFixed(6)),
      bonus: Number(sum(bonusWallets).toFixed(6)),
      source: 'account',
    }
  }

  function refreshBalance(force = false) {
    const stale = balanceInFlight && Date.now() - balanceInFlightAt > BALANCE_INFLIGHT_STALE_MS
    if (!force && Date.now() - balance.at < balanceTtlMs) return Promise.resolve(balance)
    if (balanceInFlight && !stale) return balanceInFlight
    balanceInFlightAt = Date.now()
    balanceInFlight = (async () => {
      const errors = []
      // The Platform account summary wins: it is the only source with sub-cent
      // precision *and* the lifetime spend counter this plugin bills turns against.
      try {
        const viaPlatform = await refreshPlatform(true)
        if (viaPlatform && viaPlatform.ok) {
          const recharge = round8(viaPlatform.balance)
          const bonus = round8(viaPlatform.bonus || 0)
          Object.assign(balance, {
            value: round8(recharge + bonus),
            currency: viaPlatform.currency || 'CNY',
            recharge,
            bonus,
            source: 'platform',
            at: Date.now(),
            error: null,
            diag: { source: 'platform', totalCosts: viaPlatform.totalCosts },
          })
          recordBalance(balance.value)
          writeDiag(true)
          return balance
        }
        if (viaPlatform && viaPlatform.error) errors.push(`platform: ${viaPlatform.error}`)
      } catch (err) {
        errors.push(`platform: ${short(err)}`)
      }
      try {
        const byKey = await balanceFromApiKey()
        if (byKey) {
          Object.assign(balance, byKey, { at: Date.now(), error: null })
          balance.diag = { source: 'api-key' }
          recordBalance(balance.value)
          writeDiag(true)
          return balance
        }
      } catch (err) {
        errors.push(`api-key: ${short(err)}`)
      }
      try {
        const byAccount = await balanceFromAccount()
        if (byAccount) {
          Object.assign(balance, byAccount, { at: Date.now(), error: null })
          balance.diag = { source: 'account' }
          recordBalance(balance.value)
          writeDiag(true)
          return balance
        }
      } catch (err) {
        errors.push(`account: ${short(err)}`)
      }
      const keyErr = (diag.balance.apiKey && diag.balance.apiKey.error) || null
      const accErr = (diag.balance.account && diag.balance.account.error) || null
      if (keyErr) errors.push(keyErr)
      if (accErr) errors.push(accErr)
      balance.error = errors.join(' / ').slice(0, 300) || '余额不可用'
      balance.value = null
      balance.at = Date.now()
      balance.diag = { source: null, apiKey: diag.balance.apiKey, account: diag.balance.account }
      writeDiag(true)
      return balance
    })()
      .finally(() => {
        balanceInFlight = null
        balanceInFlightAt = 0
      })
    return balanceInFlight
  }

  refreshBalance(true).catch(() => {})
  const balanceTimer = setInterval(() => {
    refreshBalance(true).catch(() => {})
  }, Math.max(balanceTtlMs, Number(config.balanceRefreshMs) || BALANCE_REFRESH_MS))
  if (typeof balanceTimer.unref === 'function') balanceTimer.unref()
  disposers.push(() => clearInterval(balanceTimer))

  // Reconcile against the host's transcripts right away (the app may have been
  // spending for hours before this plugin loaded) and then keep it fresh.
  syncFromTranscripts()
  const transcriptTimer = setInterval(syncFromTranscripts, Math.max(100, Number(config.transcriptSyncMs) || TRANSCRIPT_SYNC_MS))
  if (typeof transcriptTimer.unref === 'function') transcriptTimer.unref()
  disposers.push(() => clearInterval(transcriptTimer))

  // ---- state ------------------------------------------------------------------
  /** Session keys we know about, in no particular order. */
  function knownSessionKeys() {
    const keys = []
    const add = (key) => {
      if (key && !keys.includes(key)) keys.push(key)
    }
    for (const id of live.keys()) add(id)
    for (const [key] of lastTurns) add(key)
    for (const key of ledger.sessionIds()) add(key)
    return keys
  }

  /**
   * Work out which session the panel is asking about.
   *
   * A slot's `inject` need not hand us the id spelling the ledger was written
   * with (the host keys sessions both as `<uuid>` and `session-<uuid>`), and it
   * may hand us nothing at all. Rather than leave "last turn" as a dash forever,
   * fall back to the newest committed turn and mark it `scope: "recent"`.
   */
  function resolveFocus(rawSessionId) {
    const raw = rawSessionId === undefined || rawSessionId === null ? '' : String(rawSessionId)
    const key = sessionKey(raw)
    const keys = knownSessionKeys()
    let matched = key && keys.includes(key) ? key : ''
    if (!matched && key) matched = keys.find((item) => item.endsWith(key) || key.endsWith(item)) || ''
    // A session the host is running but that has not committed a turn yet is still
    // a known session: accept its live bucket as the match.
    if (!matched && key && live.has(key)) matched = key
    let inFlight = (matched && live.get(matched)) || (key && live.get(key)) || null
    let last = (matched && (lastTurns.get(matched) || ledger.getSession(matched))) || null
    let scope = last ? 'session' : null
    // No usable id: trust the session that last produced an event over an arbitrary
    // "newest turn" — in a desktop window that is the conversation on screen.
    if (!matched && activeSessionKey) {
      if (!inFlight) inFlight = live.get(activeSessionKey) || null
      const active = lastTurns.get(activeSessionKey) || ledger.getSession(activeSessionKey) || null
      if (!last && active) {
        last = active
        scope = 'active'
      }
    }
    if (!last) {
      const candidates = []
      for (const [, value] of lastTurns) candidates.push(value)
      for (const sid of keys) {
        const value = ledger.getSession(sid)
        if (value) candidates.push(value)
      }
      candidates.sort((a, b) => num(b.at) - num(a.at))
      if (candidates.length) {
        last = candidates[0]
        scope = 'recent'
      }
    }
    return {
      raw,
      key: matched || key,
      scope,
      last,
      live: inFlight,
      known: keys.length,
      activeSessionKey: activeSessionKey || null,
    }
  }

  function stateFor(rawSessionId, probe) {
    const now = Date.now()
    const dayKey = beijingDayKey(now)
    const sessionId = sessionKey(rawSessionId || '')
    const today = ledger.getDay(dayKey)
    const focus = resolveFocus(rawSessionId)
    const last = focus.last
    const inFlight = focus.live
    // Keep the id the panel actually sent: it is the only way to tell a genuine
    // "no turn yet" apart from an id the ledger spells differently.
    const previousRaw = diag.lastSession ? diag.lastSession.raw : null
    diag.lastSession = {
      at: now,
      raw: focus.raw.slice(0, 160),
      key: focus.key,
      scope: focus.scope,
      known: focus.known,
      source: (probe && typeof probe.source === 'string' && probe.source.slice(0, 40)) || null,
    }
    // The panel sends what it saw in its slot props once per mount. That payload is
    // the only ground truth about what the host actually hands a dock child, so
    // keep it: without it a missing session id can only be guessed at.
    if (probe && typeof probe === 'object') {
      const trim = (list) => (Array.isArray(list) ? list.slice(0, 24).map((item) => String(item).slice(0, 48)) : [])
      diag.probe = {
        at: now,
        source: diag.lastSession.source,
        propsKeys: trim(probe.propsKeys),
        sessionKeys: trim(probe.sessionKeys),
        resolved: typeof probe.resolved === 'string' ? probe.resolved.slice(0, 160) : null,
      }
    }
    // Persist a changed id immediately; the throttled write would hide a
    // one-off pairing until the next poll.
    writeDiag(previousRaw !== diag.lastSession.raw)
    // "What the account actually paid today". Two possible books: the Platform
    // spend counter (exact, from its first reading of the day) and the older
    // balance-delta book. Usage that predates the first reading is added from the
    // transcripts (rate-card estimate for that window only).
    const counterBook = costDay && costDay.day === dayKey ? costDay : null
    const counterSpent = spentOfDay(counterBook)
    const book = balanceDay && balanceDay.day === dayKey ? balanceDay : null
    const balanceSpent = book && Number.isFinite(book.spent) ? book.spent : null
    const measured = counterSpent !== null ? counterSpent : balanceSpent
    const measuredSince = counterSpent !== null ? counterBook.since || null : book ? book.since || null : null
    const measuredSource = counterSpent !== null ? 'counter' : balanceSpent !== null ? 'balance' : null
    const knownSplit = measured !== null && measuredSince && transcript.since === measuredSince
    const factor = calibration && Number(calibration.factor) > 0 ? Number(calibration.factor) : 1
    const preMeasured = knownSplit ? round8(num(transcript.before) * factor) : 0
    const actualSpend = measured === null ? null : round8(measured + preMeasured)
    const actualSince = measuredSince
    return {
      ok: true,
      version: VERSION,
      now,
      dayKey,
      peak: isPeakTime(now),
      nextPeakAt: nextPeakChangeAt(now),
      sessionId,
      balance: {
        value: balance.value,
        currency: balance.currency,
        source: balance.source,
        at: balance.at,
        error: balance.error,
        recharge: balance.recharge,
        bonus: balance.bonus,
        stale: balance.at > 0 && now - balance.at > balanceTtlMs * 3,
        diag: balance.diag || null,
      },
      costs: {
        available: counterBook !== null && platform.ok,
        counter: platform.totalCosts,
        at: platform.at,
        day: counterBook ? counterBook.day : null,
        opening: counterBook ? counterBook.opening : null,
        last: counterBook ? counterBook.last : null,
        spent: counterSpent,
        since: counterBook ? counterBook.since : null,
        pending: recentTurns.filter((item) => !(item.collected > 0)).length,
        unattributed: round8(unattributed),
        error: platform.error,
      },
      today: {
        day: dayKey,
        amount: today.amount,
        tokens: today.tokens,
        turns: today.turns,
        byModel: today.byModel,
        firstAt: today.firstAt || null,
        actual: actualSpend,
        actualSource: measuredSource,
        actualSince: actualSince,
        actualMeasured: measured,
        actualBefore: preMeasured,
        actualBeforeRaw: transcript.before || 0,
        actualFactor: factor,
        actualCredits: balanceDay && balanceDay.day === dayKey ? balanceDay.credits || 0 : 0,
        actualOpening: counterBook
          ? counterBook.opening
          : balanceDay && balanceDay.day === dayKey
            ? balanceDay.opening
            : null,
      },
      lastTurn: last
        ? {
            turn: last.turn,
            amount: last.amount,
            tokens: last.tokens,
            at: last.at,
            model: last.model,
            actual: Number.isFinite(last.actual) ? round8(last.actual) : null,
            scope: focus.scope,
          }
        : null,
      live: inFlight
        ? {
            turn: inFlight.turn,
            amount: inFlight.amount,
            tokens: inFlight.tokens,
            model: inFlight.model,
          }
        : null,
      meta: {
        events: diag.events,
        lastEventAt: diag.lastEventAt,
        polls: diag.polls,
        ledgerFile,
        origin: serverOrigin,
        transcript: { at: transcript.at, files: transcript.files, error: transcript.error, day: transcript.day },
      },
    }
  }

  function daysJson(limit) {
    const days = ledger.allDays().slice(-limit)
    return { ok: true, days }
  }

  function healthJson() {
    return {
      ok: true,
      name,
      version: VERSION,
      ledgerFile,
      diagFile,
      events: diag.events,
      lastEventAt: diag.lastEventAt,
      liveSessions: turns.size,
      polls: diag.polls,
      lastPollAt: diag.lastPollAt,
      peak: isPeakTime(Date.now()),
      balanceSource: balance.source,
      balanceValue: balance.value,
      balanceError: balance.error,
      balanceAt: balance.at,
      routes: diag.routes,
      services: diag.services,
      transcript: { at: transcript.at, files: transcript.files, error: transcript.error, amount: transcript.amount, day: transcript.day },
      balanceDay: balanceDay ? { day: balanceDay.day, opening: balanceDay.opening, last: balanceDay.last, credits: balanceDay.credits, spent: balanceDay.spent, since: balanceDay.since } : null,
      platform: platformSnapshot(),
      costDay: costDay ? { day: costDay.day, opening: costDay.opening, last: costDay.last, since: costDay.since, spent: round8(num(costDay.last) - num(costDay.opening)) } : null,
      pendingTurns: recentTurns.map((item) => ({ sessionId: item.sessionId, turn: item.turn, estimate: item.estimate, collected: item.collected })),
      lastSession: diag.lastSession,
      probe: diag.probe,
      unattributed: round8(unattributed),
      sessionsRoot,
      origin: serverOrigin,
      weekendValleyFrom: WEEKEND_VALLEY_FROM_SEC,
      holidayValleyFrom: HOLIDAY_VALLEY_FROM_SEC,
      ledgerExists: fs.existsSync(ledgerFile),
      diagExists: fs.existsSync(diagFile),
    }
  }

  // ---- Fetch route channel (what the page actually uses) ----------------------
  function bindFetchRoutes(ctx) {
    const conn = ctx.get('connection')
    if (!conn || !conn.fetch || typeof conn.fetch.register !== 'function') {
      diag.routes.fetch = 'unavailable'
      writeDiag()
      return
    }
    const register = conn.fetch.register.bind(conn.fetch)
    const mount = (routePath, handler) => {
      try {
        ctx.effect(
          () =>
            register({
              path: routePath,
              methods: ['POST'],
              requestBody: 'buffered',
              fetch: handler,
            }),
          `dsh-spend-panel: ${routePath}`
        )
      } catch (err) {
        log(`cannot mount ${routePath}: ${short(err)}`)
      }
    }
    const response = (body, status = 200) =>
      Response.json(body, { status, headers: jsonHeaders(serverOrigin) })

    async function bodyOf(req) {
      try {
        if (req && typeof req.json === 'function') {
          const parsed = await req.json()
          if (parsed && typeof parsed === 'object') return parsed
        }
      } catch {
        /* empty or non-JSON body */
      }
      return {}
    }

    mount('/api/dsh-spend/state', async (req) => {
      try {
        const body = await bodyOf(req)
        const sessionId = String(body.session || '')
        diag.polls += 1
        diag.lastPollAt = Date.now()
        if (!balanceInFlight && Date.now() - balance.at > balanceTtlMs) refreshBalance(false).catch(() => {})
        return response(stateFor(sessionId, body.probe))
      } catch (err) {
        return response({ ok: false, error: short(err) }, 500)
      }
    })

    mount('/api/dsh-spend/days', async (req) => {
      try {
        const body = await bodyOf(req)
        const limit = Math.min(Math.max(Number(body.limit) || 30, 1), 400)
        return response(daysJson(limit))
      } catch (err) {
        return response({ ok: false, error: short(err) }, 500)
      }
    })

    mount('/api/dsh-spend/health', async () => {
      diag.polls += 1
      diag.lastPollAt = Date.now()
      return response(healthJson())
    })

    diag.routes.fetch = ['/api/dsh-spend/state', '/api/dsh-spend/days', '/api/dsh-spend/health']
    writeDiag(true)
    log('mounted fetch routes')
  }

  // ---- plain HTTP routes (debugging / curl) -----------------------------------
  function bindHttpRoutes(ctx) {
    try {
      serverOrigin = typeof ctx.webServer.getOrigin === 'function' ? String(ctx.webServer.getOrigin()) : ''
    } catch {
      serverOrigin = ''
    }
    const register = (routePath, handler) => {
      try {
        const dispose = ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: (req, res) => {
            const code = rejected(root, req)
            if (code) {
              const text = JSON.stringify({ ok: false, error: 'forbidden' })
              res.writeHead(code, jsonHeaders(serverOrigin))
              res.end(text)
              return
            }
            try {
              const text = JSON.stringify(handler(req))
              res.writeHead(200, jsonHeaders(serverOrigin))
              res.end(text)
            } catch (err) {
              res.writeHead(500, jsonHeaders(serverOrigin))
              res.end(JSON.stringify({ ok: false, error: short(err) }))
            }
          },
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (err) {
        log(`cannot mount ${routePath} over http: ${short(err)}`)
      }
    }

    register('/api/dsh-spend/state', (req) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      diag.polls += 1
      diag.lastPollAt = Date.now()
      let probe = null
      try {
        const raw = url.searchParams.get('probe')
        if (raw) probe = JSON.parse(raw)
      } catch {
        probe = null
      }
      return stateFor(url.searchParams.get('session') || '', probe)
    })
    register('/api/dsh-spend/days', (req) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 400)
      return daysJson(limit)
    })
    register('/api/dsh-spend/health', () => healthJson())

    diag.routes.http = ['/api/dsh-spend/state', '/api/dsh-spend/days', '/api/dsh-spend/health']
    writeDiag(true)
  }

  try {
    root.inject(['webServer'], (ctx) => {
      svcCtx = ctx
      bindHttpRoutes(ctx)
    })
  } catch (err) {
    log(`webServer unavailable: ${short(err)}`)
  }
  try {
    root.inject(['connection'], (ctx) => {
      svcCtx = svcCtx || ctx
      bindFetchRoutes(ctx)
    })
  } catch (err) {
    diag.routes.fetch = `error: ${short(err)}`
    writeDiag()
  }

  // Optional services. `inject` is the only reliable way to reach them on a host
  // that scopes services per plugin: it waits for the provider to become active
  // and hands back a context where `ctx[name]` resolves. If a host never
  // provides one, the callback never runs — nothing to guard against.
  for (const service of ['credentials', 'deepseekAccount']) {
    try {
      root.inject([service], (ctx) => {
        const found = safeGet(ctx, service, { property: true }) || safeGet(ctx, service)
        if (!found) return
        if (service === 'credentials') injectedCredentials = found
        else injectedAccount = found
        diag.services[service] = 'inject'
        writeDiag(true)
        // The boot refresh may still be in flight (and failing for lack of this
        // very service); retry once it settles instead of waiting out the timer.
        let attempts = 0
        const retry = () => {
          if (balanceInFlight && attempts++ < 25) {
            setTimeout(retry, 400)
            return
          }
          refreshBalance(true).catch(() => {})
        }
        retry()
      })
    } catch (err) {
      diag.services[service] = `inject-error: ${short(err)}`
    }
  }

  root.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    turns.clear()
    live.clear()
    ledger.dispose()
  })

  log(`ready v${VERSION} (ledger: ${ledgerFile})`)
}

export default { name, inject, apply }
