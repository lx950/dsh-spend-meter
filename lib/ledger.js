/**
 * Small JSON ledger: per-day spend + last finished turn per session.
 *
 * File: `$DSH_HOME/spend-meter/ledger.json`
 * Shape:
 *   {
 *     v: 1,
 *     days: { "2026-10-29": { amount, tokens, turns, byModel: { [model]: { amount, tokens } } } },
 *     sessions: { [sessionId]: { turn, amount, tokens, at, model } },
 *     updatedAt: "ISO"
 *   }
 *
 * Writes are debounced and atomic (tmp file + rename), so a crash never leaves a
 * half-written ledger behind.
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_SESSIONS = 64
const MAX_DAYS = 400

const emptyDay = () => ({ amount: 0, tokens: 0, turns: 0, byModel: {} })
const round = (n, digits = 8) => {
  const f = 10 ** digits
  return Math.round((Number(n) || 0) * f) / f
}

export function createLedger({ file, flushMs = 1200, log = () => {}, normalizeSession = null }) {
  let state = { v: 1, days: {}, sessions: {}, updatedAt: null }
  let timer = null
  let closed = false

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') {
      state = {
        v: 1,
        days: raw.days && typeof raw.days === 'object' ? raw.days : {},
        sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
        balanceDay: raw.balanceDay && typeof raw.balanceDay === 'object' ? raw.balanceDay : null,
        costDay: raw.costDay && typeof raw.costDay === 'object' ? raw.costDay : null,
        calibration: raw.calibration && typeof raw.calibration === 'object' ? raw.calibration : null,
        updatedAt: raw.updatedAt || null,
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') log(`ledger load failed: ${String(err.message || err)}`)
  }

  // Session ids have more than one spelling in the wild (`<uuid>` vs `session-<uuid>`).
  // Collapse them on load, keeping the freshest entry, so the same conversation is not
  // remembered twice (and its "last turn" cannot flip-flop between two rows).
  if (typeof normalizeSession === 'function' && state.sessions) {
    const merged = {}
    for (const [id, entry] of Object.entries(state.sessions)) {
      const key = normalizeSession(id) || id
      const prev = merged[key]
      if (!prev || Number(entry && entry.at) >= Number(prev.at)) merged[key] = entry
    }
    state.sessions = merged
  }

  function schedule() {
    if (closed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, flushMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function flush() {
    if (closed) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      state.updatedAt = new Date().toISOString()
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      log(`ledger write failed: ${String((err && err.message) || err)}`)
    }
  }

  function day(dayKey) {
    let d = state.days[dayKey]
    if (!d) {
      d = emptyDay()
      state.days[dayKey] = d
      const keys = Object.keys(state.days).sort()
      while (keys.length > MAX_DAYS) {
        const oldest = keys.shift()
        if (oldest !== undefined) delete state.days[oldest]
      }
    }
    return d
  }

  return {
    /** Ratio between what was charged and what the rate card predicted. */
    getCalibration() {
      return state.calibration || null
    },
    setCalibration(value) {
      if (!value || typeof value !== 'object') return
      state.calibration = value
      schedule()
    },
    /** Record one billed assistant message. */
    add({ dayKey, model, amount, tokens }) {
      const d = day(dayKey)
      d.amount = round(d.amount + amount)
      d.tokens += tokens || 0
      d.turns += 1
      const key = String(model || 'unknown')
      const m = d.byModel[key] || (d.byModel[key] = { amount: 0, tokens: 0 })
      m.amount = round(m.amount + amount)
      m.tokens += tokens || 0
      schedule()
      return d
    },
    /** Remember the last finished turn of a session. */
    setSession(sessionId, value) {
      if (!sessionId) return
      state.sessions[String(sessionId)] = value
      const ids = Object.keys(state.sessions)
      if (ids.length > MAX_SESSIONS) delete state.sessions[ids[0]]
      schedule()
    },
    /** Every session id we hold an entry for (used to resolve a panel's id). */
    sessionIds() {
      return Object.keys(state.sessions)
    },
    getSession(sessionId) {
      return state.sessions[String(sessionId || '')] || null
    },
    getDay(dayKey) {
      const d = state.days[dayKey]
      return d ? JSON.parse(JSON.stringify(d)) : emptyDay()
    },
    /** All days, oldest first (for a future history view / README screenshots). */
    allDays() {
      return Object.keys(state.days)
        .sort()
        .map((k) => ({ day: k, ...JSON.parse(JSON.stringify(state.days[k])) }))
    },
    /**
     * Replace a day with an authoritative figure (transcript reconciliation).
     * Never lowers a day: a live event that the transcript has not flushed yet
     * must not make the displayed total jump backwards.
     */
    reconcileDay(dayKey, incoming) {
      if (!dayKey || !incoming) return day(dayKey)
      const cur = state.days[dayKey] || null
      const next = emptyDay()
      next.amount = Math.max(round(cur ? cur.amount : 0), round(incoming.amount))
      next.tokens = Math.max(cur ? cur.tokens : 0, incoming.tokens || 0)
      next.turns = Math.max(cur ? cur.turns : 0, incoming.turns || 0)
      const byModel = {}
      const models = new Set([...Object.keys((cur && cur.byModel) || {}), ...Object.keys(incoming.byModel || {})])
      for (const model of models) {
        const a = (cur && cur.byModel && cur.byModel[model]) || { amount: 0, tokens: 0 }
        const b = (incoming.byModel && incoming.byModel[model]) || { amount: 0, tokens: 0 }
        byModel[model] = {
          amount: Math.max(round(a.amount), round(b.amount)),
          tokens: Math.max(a.tokens || 0, b.tokens || 0),
        }
      }
      next.byModel = byModel
      next.before = Number(incoming.before) || 0
      // `after` is the half of the day the charge counter already covers. It has
      // to survive reconciliation: it is the only sample that lets the plugin
      // learn how the rate card compares with the real invoice.
      next.after = Number(incoming.after) || 0
      if (incoming.firstAt) next.firstAt = incoming.firstAt
      else if (cur && cur.firstAt) next.firstAt = cur.firstAt
      state.days[dayKey] = next
      schedule()
      return next
    },
    /** Persisted balance-delta bookkeeping for "what the account actually paid". */
    getBalanceDay() {
      return state.balanceDay || null
    },
    setBalanceDay(value) {
      state.balanceDay = value || null
      schedule()
      return state.balanceDay
    },
    /**
     * Persisted Platform spend-counter bookkeeping. The counter is a lifetime
     * total, so keeping today's opening reading is what turns it into "today".
     */
    getCostDay() {
      return state.costDay || null
    },
    setCostDay(value) {
      state.costDay = value || null
      schedule()
      return state.costDay
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      flush()
      closed = true
    },
  }
}

/** `$DSH_HOME` (default `~/.dsh`) — the one directory DSH guarantees to be writable. */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim() !== '') return String(env).trim()
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  return path.join(home, '.dsh')
}
