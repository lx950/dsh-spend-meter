/**
 * End-to-end check of the Platform accounting path against a *synthetic* billing
 * counter, so the whole chain (credentials -> summary -> cost day -> turn
 * attribution -> ledger) is verified without spending real money.
 *
 *   node test/platform-e2e.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-platform-'))
const ledgerFile = path.join(tmp, 'spend-meter', 'ledger.json')

const state = { counter: 100.0, balance: 50.0, summaryCalls: 0 }

globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('get_user_summary')) {
    state.summaryCalls += 1
    return {
      status: 200,
      json: async () => ({
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            normal_wallets: [{ currency: 'CNY', balance: state.balance.toFixed(10) }],
            bonus_wallets: [],
            total_costs: [{ currency: 'CNY', amount: state.counter.toFixed(10) }],
          },
        },
      }),
    }
  }
  // The API-key endpoint must not be needed in this scenario.
  return { status: 500, json: async () => ({}) }
}

const listeners = new Map()
const credentials = {
  async readRecord(key) {
    if (key !== 'deepseek-account-platform/default') return undefined
    return { kind: 'grant', payload: { version: 1, token: 'synthetic-token', issuer: 'https://platform.deepseek.com' } }
  },
  async resolve() {
    return undefined
  },
}

const rootCtx = {
  logger: { info: () => {} },
  on(event, fn) {
    listeners.set(event, fn)
    return () => listeners.delete(event)
  },
  get(service) {
    return service === 'credentials' ? credentials : undefined
  },
  effect() {
    return () => {}
  },
  inject() {
    throw new Error('unexpected inject')
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (type, data, session = { id: 'session-abc' }) => {
  const fn = listeners.get('session/event')
  if (fn) fn(session, { type, data })
}
const beijingDayKey = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)

plugin.apply(rootCtx, {
  ledgerFile,
  sessionsRoot: path.join(tmp, 'sessions'),
  credentialsFile: path.join(tmp, 'no-credentials.yaml'),
  balanceTtlMs: 30_000,
  balanceRefreshMs: 60_000,
  transcriptSyncMs: 600_000,
})
await sleep(400)

// A turn arrives: one billed step, then the Platform charges it a moment later.
emit('assistant/message', {
  turn: 1,
  usage: { inputTokens: 100_000, cacheReadTokens: 0, outputTokens: 1_000 },
  message: { source: { model: 'deepseek-flash' } },
})
state.counter = 100.05
state.balance = 49.95
await sleep(3_200) // the fast poll fires every 2s after a turn appears

// The next turn starts, which settles the previous one as "last turn".
emit('assistant/message', {
  turn: 2,
  usage: { inputTokens: 1_000, cacheReadTokens: 0, outputTokens: 100 },
  message: { source: { model: 'deepseek-flash' } },
})
await sleep(1_600) // let the debounced ledger write land

assert.ok(state.summaryCalls >= 2, `expected the counter to be polled, saw ${state.summaryCalls} calls`)

const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
assert.ok(ledger.costDay, 'the spend-counter book must be persisted')
assert.equal(ledger.costDay.day, beijingDayKey())
assert.equal(ledger.costDay.opening, 100)
assert.ok(Math.abs(ledger.costDay.last - 100.05) < 1e-9, 'the counter should have been read after the charge')

const session = ledger.sessions['abc'] || ledger.sessions['session-abc']
assert.ok(session, 'the finished turn must be remembered')
assert.equal(session.turn, 1, 'the previous turn is the finished one')
assert.ok(Math.abs(Number(session.actual) - 0.05) < 1e-9, `turn 1 should carry the charged 0.05, got ${session.actual}`)
assert.ok(Number(session.amount) > 0, 'the rate-card estimate is still recorded')

console.log('platform-e2e: ok', { charged: session.actual, estimate: session.amount, calls: state.summaryCalls })
process.exit(0)
