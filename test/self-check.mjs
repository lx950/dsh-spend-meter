/**
 * Self-check for dsh-spend-panel: pure-function pricing, ledger persistence,
 * and a smoke test that the browser bundle actually materializes, registers the
 * dock slot, and renders through React.
 *
 *   node test/self-check.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PKG = (name) => pathToFileURL(path.join(root, 'lib', name)).href

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  FAIL ${name}\n       ${err && err.message}`)
  }
}

const pricing = await import(PKG('pricing.js'))
const ledgerMod = await import(PKG('ledger.js'))
const transcriptsMod = await import(PKG('transcripts.js'))
const credentialsMod = await import(PKG('credentials.js'))
const server = await import(PKG('index.js'))

// Beijing wall clock: 2026-10-28 is a Wednesday, one day inside the
// post-2026-08-23 weekend-valley era, so weekday peak hours apply.
const PEAK_MS = Date.UTC(2026, 9, 28, 2, 30) // 10:30 Beijing
const VALLEY_MS = Date.UTC(2026, 9, 28, 12, 0) // 20:00 Beijing
const HOLIDAY_MS = Date.UTC(2026, 9, 1, 4, 0) // 12:00 Beijing, 国庆

console.log('\npricing')

test('beijingDayKey rolls over at Beijing midnight, not UTC', () => {
  assert.equal(pricing.beijingDayKey(Date.UTC(2026, 9, 28, 15, 59)), '2026-10-28')
  assert.equal(pricing.beijingDayKey(Date.UTC(2026, 9, 28, 16, 0)), '2026-10-29')
})

test('peak / off-peak by Beijing hour', () => {
  assert.equal(pricing.isPeakTime(PEAK_MS), true)
  assert.equal(pricing.isPeakTime(VALLEY_MS), false)
  // lunch gap is off-peak
  assert.equal(pricing.isPeakTime(Date.UTC(2026, 9, 28, 4, 30)), false)
})

test('weekend and statutory holiday are off-peak all day', () => {
  assert.equal(pricing.isPeakTime(Date.UTC(2026, 9, 31, 2, 30)), false) // Saturday 10:30
  assert.equal(pricing.isPeakTime(HOLIDAY_MS), false) // 国庆 12:00
})

test('price card: flash vs pro, peak vs off-peak', () => {
  const zero = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  assert.deepEqual(pricing.costOf(zero, 'deepseek-flash', PEAK_MS).price, { hit: 0.04, miss: 2, out: 8 })
  assert.deepEqual(pricing.costOf(zero, 'deepseek-flash', VALLEY_MS).price, { hit: 0.02, miss: 1, out: 4 })
  assert.deepEqual(pricing.costOf(zero, 'deepseek-v4-pro', PEAK_MS).price, { hit: 0.3, miss: 9, out: 27 })
})

test('unknown model falls back to the flash card', () => {
  const zero = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  assert.deepEqual(pricing.costOf(zero, 'some-future-model', PEAK_MS).price, { hit: 0.04, miss: 2, out: 8 })
  assert.deepEqual(pricing.costOf(zero, 'deepseek-flash', PEAK_MS).price, pricing.costOf(zero, 'DSH/unknown', PEAK_MS).price)
})

// Hand-computed: 1M cache-miss input at flash off-peak = ¥1
test('costOf: 1M cache-miss input, off-peak = 1.00', () => {
  const r = pricing.costOf({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, 'deepseek-flash', VALLEY_MS)
  assert.equal(r.amount, 1)
  assert.equal(r.tier, 'offpeak')
})

test('costOf: cache hits are priced separately from misses', () => {
  const r = pricing.costOf({ inputTokens: 500_000, cacheReadTokens: 500_000, outputTokens: 0 }, 'deepseek-flash', VALLEY_MS)
  assert.equal(r.amount, 0.5 * 1 + 0.5 * 0.02)
})

test('costOf: output tokens use the output rate', () => {
  const r = pricing.costOf({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 1_000_000 }, 'deepseek-flash', VALLEY_MS)
  assert.equal(r.amount, 4)
})

test('costOf: a real 4.9M-token turn stays in a plausible CNY range', () => {
  const r = pricing.costOf(
    { inputTokens: 4_000_000, cacheReadTokens: 900_000, outputTokens: 48_046 },
    'deepseek-flash',
    PEAK_MS
  )
  assert.ok(r.amount > 0.5 && r.amount < 30, `unexpected amount ${r.amount}`)
  assert.equal(r.tokens.input + r.tokens.cache + r.tokens.output, 4_948_046)
})

console.log('\nledger')

test('add / getDay / setSession persist through a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-'))
  const file = path.join(dir, 'ledger.json')
  const a = ledgerMod.createLedger({ file, flushMs: 0 })
  a.add({ dayKey: '2026-10-29', model: 'deepseek-flash', amount: 0.25, tokens: 1000 })
  a.add({ dayKey: '2026-10-29', model: 'deepseek-flash', amount: 0.75, tokens: 2000 })
  a.setSession('sess-1', { turn: 4, amount: 0.75, tokens: 3000, at: 1, model: 'deepseek-flash' })
  a.flush()
  a.dispose()

  const b = ledgerMod.createLedger({ file, flushMs: 0 })
  const day = b.getDay('2026-10-29')
  assert.equal(day.amount, 1)
  assert.equal(day.tokens, 3000)
  assert.equal(day.turns, 2)
  assert.equal(b.getSession('sess-1').turn, 4)
  assert.equal(b.allDays().length, 1)
  b.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ledger keeps day keys sorted oldest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-'))
  const file = path.join(dir, 'ledger.json')
  const l = ledgerMod.createLedger({ file, flushMs: 0 })
  for (const day of ['2026-10-29', '2026-09-01', '2026-10-01']) {
    l.add({ dayKey: day, model: 'deepseek-flash', amount: 0.1, tokens: 10 })
  }
  assert.deepEqual(l.allDays().map((d) => d.day ?? d.key), ['2026-09-01', '2026-10-01', '2026-10-29'])
  l.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\ntranscripts')

test('beijingDayStartMs is Beijing midnight, not UTC midnight', () => {
  assert.equal(pricing.beijingDayStartMs('2026-10-29'), Date.UTC(2026, 9, 28, 16, 0))
  assert.equal(pricing.beijingDayStartMs('nope'), null)
})

/** Write a synthetic multi-frame zstd transcript: `frames` is one JSONL blob per frame. */
function writeTranscript(dir, sessionId, frames) {
  // Real layout: <sessionsRoot>/<workspace>/<session-id>/session.v4.jsonl.zstd
  const folder = path.join(dir, '--ws--', sessionId)
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, 'session.v4.jsonl.zstd')
  const parts = frames.map((text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
  fs.writeFileSync(file, Buffer.concat(parts))
  return file
}

const assistantLine = (at, turn, usage, model = 'deepseek-flash') =>
  JSON.stringify({
    type: 'assistant/message',
    seq: turn,
    time: at,
    data: { turn, step: 1, usage, message: { role: 'assistant', source: { kind: 'model', model } } },
  })

test('multi-frame transcripts are read to the last frame, not just the first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-tx-'))
  const today = '2026-10-29'
  const at = Date.UTC(2026, 9, 28, 20, 0) // 04:00 Beijing on the 29th
  // Three frames: a header frame, then two billed messages in later frames.
  // Node's zstdDecompressSync decodes only the first frame and reports success,
  // which used to truncate the whole file to one record.
  writeTranscript(dir, 'session-aaaa', [
    JSON.stringify({ type: 'session', version: 4, id: 'aaaa' }) + '\n',
    assistantLine(at, 1, { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }) + '\n',
    assistantLine(at + 60_000, 2, { inputTokens: 0, cacheReadTokens: 0, outputTokens: 1_000_000 }) + '\n',
  ])
  const res = transcriptsMod.readDayUsage({ sessionsRoot: dir, dayKey: today, cache: new Map() })
  // Off-peak flash: ¥1 for the miss input + ¥4 for the output.
  assert.equal(res.day.amount, 5)
  assert.equal(res.day.turns, 2)
  assert.equal(res.day.tokens, 2_000_000)
  assert.equal(res.files, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('only the requested Beijing day is counted, and last turn is recovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-tx-'))
  const at = Date.UTC(2026, 9, 28, 20, 0) // 04:00 Beijing 2026-10-29
  const yesterday = Date.UTC(2026, 9, 27, 20, 0)
  writeTranscript(dir, 'session-bbbb', [
    assistantLine(yesterday, 1, { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }) + '\n',
    assistantLine(at, 2, { inputTokens: 0, cacheReadTokens: 0, outputTokens: 1_000_000 }) + '\n',
    assistantLine(at + 60_000, 3, { inputTokens: 0, cacheReadTokens: 0, outputTokens: 250_000 }) + '\n',
  ])
  const res = transcriptsMod.readDayUsage({ sessionsRoot: dir, dayKey: '2026-10-29', cache: new Map() })
  assert.equal(res.day.turns, 2, 'yesterday must not leak into today')
  assert.equal(res.day.amount, 4 + 1)
  const sess = res.sessions.bbbb
  assert.ok(sess, 'per-session last turn should be recovered')
  assert.equal(sess.turn, 3)
  assert.equal(sess.amount, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the transcript decoder reports itself available on the test runtime', () => {
  // The CI matrix is `node: [22]` because of this: the backfill decodes
  // multi-frame zstd through node:zlib, which older runtimes do not ship. If this
  // ever fails, either the matrix or the graceful-degradation path regressed.
  assert.equal(transcriptsMod.zstdAvailable, true)
  const NL = String.fromCharCode(10)
  const buf = zlib.zstdCompressSync(Buffer.from('hello' + NL))
  assert.equal(transcriptsMod.decodeFrames(buf, transcriptsMod.frameStarts(buf)), 'hello' + NL)
})

test('a warm transcript cache does not leak yesterday into today', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-tx-'))
  const dayAt = Date.UTC(2026, 9, 28, 20, 0) // 04:00 Beijing 2026-10-29
  const file = writeTranscript(dir, 'session-cccc', [
    assistantLine(dayAt, 1, { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }) + String.fromCharCode(10),
  ])
  // Keep the file looking freshly touched so the day filter cannot skip it.
  const now = Date.now()
  fs.utimesSync(file, new Date(now), new Date(now))
  const cache = new Map()
  const onTheDay = transcriptsMod.readDayUsage({ sessionsRoot: dir, dayKey: '2026-10-29', cache })
  assert.equal(onTheDay.day.amount, 1, 'the day itself is counted')
  // Same cache, next day: records are day-filtered when parsed, so a cached entry
  // must not be reused across midnight.
  const nextDay = transcriptsMod.readDayUsage({ sessionsRoot: dir, dayKey: '2026-10-30', cache })
  assert.equal(nextDay.day.turns, 0, 'yesterday must not come back through the cache')
  assert.equal(nextDay.day.amount, 0)
  const again = transcriptsMod.readDayUsage({ sessionsRoot: dir, dayKey: '2026-10-29', cache })
  assert.equal(again.day.amount, 1, 'switching back still counts the right day')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\nbalance delta book')

test('balance delta = opening + credits - last, with recharges excluded', () => {
  let book = null
  book = transcriptsMod.trackBalanceDay(book, 13.53, '2026-10-29', 1)
  assert.equal(book.spent, 0)
  book = transcriptsMod.trackBalanceDay(book, 12.5, '2026-10-29', 2)
  assert.equal(book.spent, 1.03)
  // A recharge must not read as negative spending, and must not inflate spend.
  book = transcriptsMod.trackBalanceDay(book, 22.5, '2026-10-29', 3)
  assert.equal(book.credits, 10)
  assert.equal(book.spent, 1.03)
  book = transcriptsMod.trackBalanceDay(book, 20.0, '2026-10-29', 4)
  assert.equal(book.spent, 3.53)
  // A new day resets the baseline to the first reading.
  const next = transcriptsMod.trackBalanceDay(book, 20.0, '2026-10-30', 5)
  assert.equal(next.day, '2026-10-30')
  assert.equal(next.spent, 0)
})

test('calibration learns the invoice-vs-chart ratio and refuses noise', () => {
  // 0.35 charged where the rate card priced 0.31 → the backfill is scaled by ~1.129
  const learned = transcriptsMod.calibrationOf(0.35, 0.31)
  assert.ok(learned && Math.abs(learned.factor - 1.129) < 0.001, 'factor')
  assert.equal(learned.measured, 0.35)
  // Too little evidence: keep whatever we had.
  const previous = { factor: 1.2, at: 1 }
  assert.equal(transcriptsMod.calibrationOf(0.01, 0.30, previous), previous, 'tiny measured')
  assert.equal(transcriptsMod.calibrationOf(0.30, 0.001, previous), previous, 'tiny estimate')
  // Wild ratios are clamped, not trusted.
  const wild = transcriptsMod.calibrationOf(9, 0.3)
  assert.equal(wild.factor, 1.8)
  assert.equal(transcriptsMod.calibrationOf(0.3, 9).factor, 0.8)
})

test('reconcileDay never lowers a day that live events already counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-'))
  const file = path.join(dir, 'ledger.json')
  const l = ledgerMod.createLedger({ file, flushMs: 0 })
  l.add({ dayKey: '2026-10-29', model: 'deepseek-flash', amount: 0.9, tokens: 900 })
  const merged = l.reconcileDay('2026-10-29', {
    amount: 0.5,
    tokens: 500,
    turns: 1,
    byModel: { 'deepseek-flash': { amount: 0.5, tokens: 500 } },
  })
  assert.equal(merged.amount, 0.9)
  assert.equal(merged.tokens, 900)
  const grown = l.reconcileDay('2026-10-29', {
    amount: 2.26,
    tokens: 34_000_000,
    turns: 2,
    byModel: { 'deepseek-flash': { amount: 2.26, tokens: 34_000_000 } },
  })
  assert.equal(grown.amount, 2.26)
  assert.equal(grown.tokens, 34_000_000)
  // The split halves must survive: `after` is the sample that teaches the plugin
  // how the rate card compares with the invoice, so losing it silently disables
  // the calibration for the rest of the day.
  const split = l.reconcileDay('2026-10-29', {
    amount: 2.26,
    tokens: 34_000_000,
    turns: 2,
    before: 1.5,
    after: 0.76,
    byModel: { 'deepseek-flash': { amount: 2.26, tokens: 34_000_000 } },
  })
  assert.equal(split.before, 1.5)
  assert.equal(split.after, 0.76)
  l.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\nserver half')

test('module shape: name / inject / apply', () => {
  assert.equal(server.name, 'dsh-spend-panel')
  assert.deepEqual(server.inject, [])
  assert.equal(typeof server.apply, 'function')
  assert.equal(server.default.name, 'dsh-spend-panel')
})

test('nextPeakChangeAt returns a future instant with the opposite tier', () => {
  for (const now of [VALLEY_MS, PEAK_MS, HOLIDAY_MS]) {
    const next = server.nextPeakChangeAt(now)
    assert.ok(next > now, `no switch found after ${new Date(now).toISOString()}`)
    assert.notEqual(pricing.isPeakTime(next), pricing.isPeakTime(now))
  }
})

console.log('\nbrowser half')

test('bundle registers the composer status line', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
  let def = null
  const styles = []
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => Promise.reject(new Error('no network in self-check')),
    window: { __ModuleLoader__: { load: (d) => { def = d } } },
    globalThis: {},
    document: {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, appendChild() {} }),
      head: { appendChild: (n) => styles.push(n) },
      documentElement: { appendChild: (n) => styles.push(n) },
      addEventListener() {},
      removeEventListener() {},
      visibilityState: 'visible',
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)

  assert.ok(def, '__ModuleLoader__.load was never called')
  assert.equal(def.id, 'dsh-spend-panel')

  const requireShim = (id) => {
    if (id === 'react') {
      return {
        createElement: (type, props, ...kids) => ({ type, props: { ...(props || {}), children: kids.length ? kids : undefined } }),
        useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
        useRef: (value) => ({ current: value }),
        useEffect() {},
        useCallback: (fn) => fn,
      }
    }
    throw new Error(`unexpected require(${id})`)
  }
  const exported = def.factory(requireShim)
  assert.equal(exported.name, 'dsh-spend-panel')
  assert.equal(JSON.stringify(exported.inject), '["slots"]')
  assert.equal(typeof exported.apply, 'function')

  let registered = null
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'conversation.input.dock')
        return fn()
      },
      register: (options, component) => {
        registered = { options, component }
        return () => {}
      },
    },
  }
  exported.apply(ctx)
  assert.ok(registered, 'no slot registration happened')
  assert.equal(registered.options.name, 'conversation.input.dock')
  assert.equal(registered.options.id, 'spend-meter')
  assert.equal(registered.options.order, 30)
  // An empty injected value must not be forwarded, otherwise it would blank out a
  // `sessionId` supplied by the standard props.
  assert.equal(JSON.stringify(registered.options.inject(undefined)), '{}')
  assert.equal(JSON.stringify(registered.options.inject('abc')), '{"injectedSessionId":"abc"}')
  assert.equal(JSON.stringify(registered.options.inject({ id: 'abc' })), '{"injectedSessionId":"abc"}')
  assert.ok(styles.length > 0, 'CSS was not injected')

  const tree = registered.component({ sessionId: 'abc' })
  const text = JSON.stringify(tree)
  assert.ok(text.includes('dsm-panel'), 'panel root class missing')
  assert.ok(text.includes('会话花费'), 'panel title missing')
  // A dock child also gets `{ session, input }` from the conversation root, which
  // is the only source of the id when the binding key is missing.
  assert.ok(JSON.stringify(registered.component({ session: { id: 'abc' } })).includes('dsm-panel'))
  if (!text.includes('余额') || !text.includes('—')) {
    console.error(text)
    throw new Error('placeholder values should render before the first poll')
  }
})

// ---- platform account API + attribution -------------------------------------
// The Platform summary is the only source with cents-beating precision, so its
// parser and the charge-splitting maths get their own coverage.
const platformMod = await import(PKG('platform.js'))
const attributionMod = await import(PKG('attribution.js'))

const SUMMARY_FIXTURE = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      normal_wallets: [{ currency: 'CNY', balance: '9.9948816200000000', token_estimation: '0' }],
      bonus_wallets: [{ currency: 'CNY', balance: '0.5000000000000000', token_estimation: '0' }],
      total_costs: [{ currency: 'CNY', amount: '71.6670811400000000' }],
    },
  },
}

test('platform summary parses eight-decimal balance and lifetime spend', () => {
  const parsed = platformMod.parseSummary(SUMMARY_FIXTURE)
  assert.ok(parsed, 'fixture should parse')
  assert.equal(parsed.balance, 9.99488162)
  assert.equal(parsed.bonus, 0.5)
  assert.equal(parsed.totalCosts, 71.66708114)
  assert.equal(parsed.currency, 'CNY')
})

test('platform summary rejects unauthorized envelopes instead of reporting zero', () => {
  assert.equal(platformMod.parseSummary({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null }), null)
  assert.equal(platformMod.parseSummary({ code: 0, data: { biz_code: 1, biz_data: { normal_wallets: [] } } }), null)
  assert.equal(platformMod.sumWallets([{ currency: 'USD', balance: '1.5' }]).currency, 'USD')
  assert.equal(platformMod.sumWallets([]).amount, 0)
})

async function asyncTest(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  FAIL ${name}\n       ${err && err.message}`)
  }
}

await asyncTest('platform request sends x-dsh-auth-token (not Bearer) and parses the summary', async () => {
  let seen = null
  const res = await platformMod.readPlatformSummary({
    token: 'tok-123',
    origin: 'https://platform.deepseek.com',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { status: 200, json: async () => SUMMARY_FIXTURE }
    },
  })
  assert.equal(seen.url, 'https://platform.deepseek.com/api/v0/users/get_user_summary')
  assert.equal(seen.init.headers['x-dsh-auth-token'], 'tok-123')
  assert.equal(seen.init.headers.authorization, undefined, 'Bearer is rejected by the Platform (40003)')
  assert.equal(res.ok, true)
  assert.equal(res.totalCosts, 71.66708114)
  assert.equal(res.balance, 9.99488162)
})

await asyncTest('expired platform grant reports a sign-in problem, not a balance of zero', async () => {
  const res = await platformMod.readPlatformSummary({
    token: 'stale',
    fetchImpl: async () => ({ status: 200, json: async () => ({ code: 40003, msg: 'Authorization Failed', data: null }) }),
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /登录已失效/)
})

test('cost day turns the lifetime counter into today, and a new day re-baselines', () => {
  const first = attributionMod.advanceCostDay(null, { dayKey: '2026-10-29', counter: 71.667, now: 1000 })
  assert.equal(first.delta, 0, 'the first reading cannot know what came before it')
  assert.deepEqual(first.book, { day: '2026-10-29', opening: 71.667, last: 71.667, since: 1000, at: 1000 })

  const charged = attributionMod.advanceCostDay(first.book, { dayKey: '2026-10-29', counter: 71.74296022, now: 2000 })
  assert.equal(charged.delta, 0.07596022)
  assert.equal(attributionMod.spentOfDay(charged.book), 0.07596022)

  const refund = attributionMod.advanceCostDay(charged.book, { dayKey: '2026-10-29', counter: 71.7, now: 3000 })
  assert.equal(refund.delta, 0, 'a lower counter is a refund, never negative spend')
  assert.equal(refund.book.last, 71.7)

  const nextDay = attributionMod.advanceCostDay(charged.book, { dayKey: '2026-10-30', counter: 80, now: 4000 })
  assert.equal(nextDay.delta, 0)
  assert.equal(nextDay.book.opening, 80)
  assert.equal(attributionMod.spentOfDay(nextDay.book), 0)
})

test('a charge lands exactly on the single waiting turn, or is split by estimate', () => {
  assert.deepEqual(attributionMod.splitCharge([], 0.5), [])
  assert.deepEqual(attributionMod.splitCharge([{ estimate: 0.3 }], 0.28891), [0.28891])
  const shares = attributionMod.splitCharge([{ estimate: 0.1 }, { estimate: 0.3 }], 0.4)
  assert.equal(shares.length, 2)
  assert.equal(Math.round((shares[0] + shares[1]) * 1e8) / 1e8, 0.4, 'the split must add back up to the charge')
  assert.ok(shares[0] < shares[1], 'the bigger estimate takes the bigger share')
  const flat = attributionMod.splitCharge([{ estimate: 0 }, { estimate: 0 }, { estimate: 0 }], 0.3)
  assert.equal(Math.round(flat.reduce((a, b) => a + b, 0) * 1e8) / 1e8, 0.3)
})

test('the credential store is read directly when the injected service is scoped away', () => {
  const text = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-test-key-0123456789',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: session-secret',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      token: 2EnMtoken/withslash',
    '      issuer: https://platform.deepseek.com',
    '',
  ].join('\n')
  const store = credentialsMod.parseCredentials(text)
  assert.equal(store.version, 1)
  assert.equal(store.refs.DEEPSEEK_API_KEY, 'sk-test-key-0123456789')
  assert.equal(credentialsMod.apiKeyFrom(store), 'sk-test-key-0123456789')
  const grant = credentialsMod.grantFrom(store)
  assert.equal(grant.token, '2EnMtoken/withslash')
  assert.equal(grant.origin, 'https://platform.deepseek.com')
  // The session grant is not an account grant and must not be mistaken for one.
  assert.equal(credentialsMod.grantFrom(store, 'client-connection/browser-session'), null)
  assert.equal(credentialsMod.grantFrom({ records: {} }), null)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-cred-'))
  const file = path.join(dir, '.credentials.yaml')
  fs.writeFileSync(file, text)
  assert.equal(credentialsMod.apiKeyFrom(credentialsMod.readCredentialsFile(file)), 'sk-test-key-0123456789')
  assert.equal(credentialsMod.readCredentialsFile(path.join(dir, 'nope.yaml')), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err && f.err.stack}`)
  process.exitCode = 1
}
