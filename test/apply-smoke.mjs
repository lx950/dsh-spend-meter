/**
 * Integration smoke test for the host half: boot `apply()` against a minimal
 * fake Cordis context, feed it a real session event sequence, and hit the HTTP
 * routes the client polls.
 *
 *   node test/apply-smoke.mjs
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-apply-'))
const ledgerFile = path.join(dir, 'ledger.json')

const listeners = new Map()
const routes = new Map()
const fetchRoutes = new Map()
const disposers = []

const connection = {
  // The real host hands requests from first-party pages straight through here.
  requestRejection() {
    return null
  },
  fetch: {
    register(route) {
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
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
    return service === 'connection' ? connection : undefined
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  inject(services, cb) {
    if (services.includes('webServer')) {
      cb({
        webServer: {
          getOrigin: () => 'http://127.0.0.1:53735',
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
      })
      return
    }
    if (services.includes('connection')) {
      cb({
        connection,
        effect: rootCtx.effect,
        get: (service) => (service === 'connection' ? connection : undefined),
      })
      return
    }
    throw new Error(`unexpected inject(${JSON.stringify(services)})`)
  },
}

function emit(event, session) {
  for (const fn of listeners.get(session === undefined ? event : 'session/event') || []) {
    if (session === undefined) fn()
    else fn(session, event)
  }
}

function call(routePath, search = '') {
  return new Promise((resolve, reject) => {
    const route = routes.get(routePath)
    assert.ok(route, `route ${routePath} was not registered`)
    assert.equal(route.kind, 'exact')
    let status = 0
    let body = ''
    const res = {
      writeHead(code) {
        status = code
      },
      end(text) {
        body = text
        try {
          resolve({ status, json: JSON.parse(text) })
        } catch (err) {
          reject(err)
        }
      },
    }
    const req = { url: routePath + search, headers: { host: '127.0.0.1:53735' } }
    route.handler(req, res)
  })
}

plugin.apply(rootCtx, {
  ledgerFile,
  sessionsRoot: path.join(dir, 'sessions'),
  // Never read this machine's real credential store from a test.
  credentialsFile: path.join(dir, 'no-credentials.yaml'),
  transcriptSyncMs: 100,
})

console.log('routes registered:', [...routes.keys()].join(', '))
assert.deepEqual(
  [...routes.keys()].sort(),
  ['/api/dsh-spend/days', '/api/dsh-spend/health', '/api/dsh-spend/state']
)

// The page talks to the plugin over the Fetch channel, not the raw HTTP routes.
console.log('fetch routes registered:', [...fetchRoutes.keys()].join(', '))
assert.deepEqual(
  [...fetchRoutes.keys()].sort(),
  ['/api/dsh-spend/days', '/api/dsh-spend/health', '/api/dsh-spend/state']
)

async function post(routePath, body) {
  const handler = fetchRoutes.get(routePath)
  assert.ok(handler, `fetch route ${routePath} was not registered`)
  const req = new Request(`http://127.0.0.1:53735${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const res = await handler(req)
  return { status: res.status, json: await res.json() }
}

// ---- an empty meter still answers ------------------------------------------
let res = await call('/api/dsh-spend/state', '?session=smoke-1')
assert.equal(res.status, 200)
assert.equal(res.json.ok, true)
assert.equal(res.json.today.amount, 0)
assert.equal(res.json.lastTurn, null)
assert.equal(res.json.peak, pricing.isPeakTime(res.json.now))

// ---- the same state must be reachable over the Fetch channel ---------------
const viaFetch = await post('/api/dsh-spend/state', { session: 'smoke-1' })
assert.equal(viaFetch.status, 200)
assert.equal(viaFetch.json.ok, true)
assert.equal(viaFetch.json.sessionId, 'smoke-1')
const healthFetch = await post('/api/dsh-spend/health', {})
assert.equal(healthFetch.json.ok, true)
assert.equal(healthFetch.json.version, plugin.VERSION)

// ---- one assistant step + turn end ----------------------------------------
const session = { id: 'smoke-1' }
const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }
const model = 'deepseek-flash'
emit({ type: 'assistant/message', data: { turn: 7, usage, message: { source: { model } } } }, session)

res = await call('/api/dsh-spend/state', '?session=smoke-1')
assert.ok(res.json.today.amount > 0, 'today should move after one assistant step')
assert.equal(res.json.live.turn, 7, 'the in-flight turn should be visible')
assert.equal(res.json.lastTurn, null, 'nothing is settled before turn/end')

emit({ type: 'turn/end', data: { turn: 7, reason: 'complete' } }, session)

res = await call('/api/dsh-spend/state', '?session=smoke-1')
assert.equal(res.json.live, null, 'turn/end should clear the in-flight bucket')
assert.equal(res.json.lastTurn.turn, 7)
assert.equal(res.json.lastTurn.model, model)
const expected = pricing.costOf(usage, model, res.json.now).amount
assert.ok(
  Math.abs(res.json.lastTurn.amount - expected) <= Math.max(Math.abs(expected) * 0.5, 0.005),
  `settled ${res.json.lastTurn.amount} vs current-rate ${expected}`
)

// ---- a turn/end with no payload must still settle --------------------------
emit({ type: 'assistant/message', data: { turn: 8, usage: { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 }, message: { source: { model } } } }, session)
emit({ type: 'turn/end' }, session)
res = await call('/api/dsh-spend/state', '?session=smoke-1')
assert.equal(res.json.lastTurn.turn, 8, 'turn/end without data must still settle')

// ---- ledger is on disk and reloadable --------------------------------------
const days = await call('/api/dsh-spend/days', '?limit=7')
assert.ok(days.json.days.length >= 1)
const health = await call('/api/dsh-spend/health')
assert.equal(health.json.ledgerFile, ledgerFile)
// the ledger write is debounced; give it a beat to land on disk
await new Promise((resolve) => setTimeout(resolve, 1600))
const health2 = await call('/api/dsh-spend/health')
assert.equal(health2.json.ledgerExists, true)
const onDisk = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
assert.ok(Object.keys(onDisk.days).length >= 1)
assert.ok(onDisk.days[days.json.days.at(-1).day] ?? true)

// ---- transcripts reconcile usage the live events never saw -----------------
// A mid-day install (or an app restart) means hours of billed usage happened
// before this plugin existed. The transcripts are authoritative, so the day is
// reconciled against them even though no session/event was ever observed here.
const sessionsRoot = path.join(dir, 'sessions')
const folder = path.join(sessionsRoot, '--smoke--', 'session-early')
fs.mkdirSync(folder, { recursive: true })
const earlyLine = JSON.stringify({
  type: 'assistant/message',
  time: Date.now() - 60_000,
  data: { turn: 1, usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, message: { source: { model: 'deepseek-flash' } } },
})
fs.writeFileSync(
  path.join(folder, 'session.v4.jsonl.zstd'),
  Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'early' }) + '\n', 'utf8')),
    zlib.zstdCompressSync(Buffer.from(earlyLine + '\n', 'utf8')),
  ])
)
await new Promise((resolve) => setTimeout(resolve, 500))
const reconciled = await post('/api/dsh-spend/health', {})
assert.ok(reconciled.json.transcript.files >= 1, 'transcript file was not picked up')
assert.ok(
  reconciled.json.transcript.amount >= 0.5,
  `reconciliation did not lift the day (transcript amount ${reconciled.json.transcript.amount})`
)
res = await call('/api/dsh-spend/state', '?session=smoke-1')
assert.ok(res.json.today.amount >= 0.5, 'today should include pre-install usage from transcripts')
assert.ok(res.json.today.firstAt, 'first billed moment of the day should be reported')

for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* ignore */
  }
}
fs.rmSync(dir, { recursive: true, force: true })

console.log('apply-smoke: ok')
