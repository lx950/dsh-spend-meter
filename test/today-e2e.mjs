/**
 * "Today" is the number users argue about, so it gets its own end-to-end test.
 *
 * Scenario: the plugin starts at 09:00 with a Platform charge counter, but the
 * account was already spending from 07:00. Today must show
 *   counter delta (measured) + transcript backfill (priced) * calibration
 * and it must keep following the counter while no turn is running.
 *
 *   node test/today-e2e.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
const pricing = await import(pathToFileURL(path.join(root, 'lib', 'pricing.js')).href)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-today-'))
const ledgerFile = path.join(dir, 'ledger.json')
const sessionsRoot = path.join(dir, 'sessions')

// Usage from before the plugin existed: 1M cache-miss tokens, two hours ago.
const earlyUsage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }
const earlyAt = Date.now() - 2 * 3600_000
const expectedBackfill = pricing.costOf(earlyUsage, 'deepseek-flash', earlyAt).amount
const folder = path.join(sessionsRoot, '--today--', 'session-early')
fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(
  path.join(folder, 'session.v4.jsonl.zstd'),
  Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'early' }) + '\n', 'utf8')),
    zlib.zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          type: 'assistant/message',
          time: earlyAt,
          data: { turn: 1, usage: earlyUsage, message: { source: { model: 'deepseek-flash' } } },
        }) + '\n',
        'utf8',
      ),
    ),
  ]),
)

const money = { counter: 100.0, balance: 50.0, calls: 0 }
globalThis.fetch = async (url) => {
  if (String(url).includes('get_user_summary')) {
    money.calls += 1
    return {
      status: 200,
      json: async () => ({
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            normal_wallets: [{ currency: 'CNY', balance: money.balance.toFixed(10) }],
            bonus_wallets: [],
            total_costs: [{ currency: 'CNY', amount: money.counter.toFixed(10) }],
          },
        },
      }),
    }
  }
  return { status: 500, json: async () => ({}) }
}

const credentials = {
  async readRecord(key) {
    if (key !== 'deepseek-account-platform/default') return undefined
    return { kind: 'grant', payload: { token: 'synthetic', issuer: 'https://platform.deepseek.com' } }
  },
  async resolve() {
    return undefined
  },
}

const listeners = new Map()
const fetchRoutes = new Map()
const connection = {
  requestRejection: () => null,
  fetch: {
    register(route) {
      fetchRoutes.set(route.path, route.fetch)
      return () => fetchRoutes.delete(route.path)
    },
  },
}

const rootCtx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
    return () => {
      const list = listeners.get(event) || []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    }
  },
  get(service) {
    if (service === 'credentials') return credentials
    if (service === 'connection') return connection
    return undefined
  },
  effect() {
    return () => {}
  },
  inject(services, cb) {
    if (services.includes('webServer')) {
      cb({ webServer: { getOrigin: () => 'http://127.0.0.1:53735', register: () => () => {} }, effect: runEffect })
      return
    }
    if (services.includes('connection')) {
      cb({ connection, effect: runEffect, get: (name) => (name === 'connection' ? connection : undefined) })
      return
    }
    throw new Error(`unexpected inject(${JSON.stringify(services)})`)
  },
}

function runEffect(fn) {
  const dispose = fn()
  return typeof dispose === 'function' ? dispose : () => {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const state = async () => {
  const handler = fetchRoutes.get('/api/dsh-spend/state')
  assert.ok(handler, 'state route missing')
  const res = await handler(
    new Request('http://127.0.0.1:53735/api/dsh-spend/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'today-1' }),
    }),
  )
  return res.json()
}

plugin.apply(rootCtx, {
  ledgerFile,
  sessionsRoot,
  // Never read this machine's real credential store from a test.
  credentialsFile: path.join(path.dirname(ledgerFile), 'no-credentials.yaml'),
  balanceTtlMs: 1_000,
  balanceRefreshMs: 400,
  transcriptSyncMs: 200,
})
await sleep(1_200)

let s = await state()
console.log('after start:', JSON.stringify({ actual: s.today.actual, measured: s.today.actualMeasured, before: s.today.actualBefore, source: s.today.actualSource }))
assert.equal(s.today.actualSource, 'counter', 'the charge counter should be the primary book')
assert.ok(Math.abs(s.today.actualMeasured) < 1e-6, 'nothing was charged since the first reading')
assert.ok(
  Math.abs(s.today.actualBefore - expectedBackfill) <= Math.max(expectedBackfill * 0.02, 1e-6),
  `backfill ${s.today.actualBefore} vs priced transcript ${expectedBackfill}`,
)
assert.ok(
  Math.abs(s.today.actual - (expectedBackfill * (s.today.actualFactor || 1))) <= 1e-6,
  `today.actual ${s.today.actual} should be the backfill alone right after start`,
)

// The account keeps spending while no turn is running: the counter moves.
money.counter = 100.2
money.balance = 49.8
await sleep(2_400)

s = await state()
console.log('after charge:', JSON.stringify({ actual: s.today.actual, measured: s.today.actualMeasured, unattributed: s.costs.unattributed }))
assert.ok(Math.abs(s.today.actualMeasured - 0.2) < 1e-6, `measured ${s.today.actualMeasured} should be 0.2`)
assert.ok(Math.abs(s.costs.unattributed - 0.2) < 1e-6, 'money with no waiting turn is unattributed')
assert.ok(
  Math.abs(s.today.actual - (expectedBackfill * (s.today.actualFactor || 1) + 0.2)) < 1e-6,
  `today.actual ${s.today.actual} should be backfill + 0.2`,
)
assert.ok(Math.abs(s.balance.value - 49.8) < 1e-6, 'the 8-decimal wallet balance comes from the same call')

console.log('today-e2e: ok', { backfill: Number(expectedBackfill.toFixed(6)), calls: money.calls })
process.exit(0)
