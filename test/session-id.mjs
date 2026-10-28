/**
 * The panel asks for "the last turn of *this* session", but the id a slot hands a
 * plugin and the id the ledger is keyed by do not always agree: the host writes
 * both `session-<uuid>` and `<uuid>`, and a slot may inject nothing at all. This
 * test pins the resolution rules, so "last turn" degrades to the active session
 * (or the newest turn) instead of sitting on a dash forever.
 *
 *   node test/session-id.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-session-'))
const ledgerFile = path.join(dir, 'ledger.json')
const diagFile = path.join(dir, 'diag.json')

const listeners = new Map()
const fetchRoutes = new Map()
const connection = {
  requestRejection() {
    return null
  },
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
    listeners.set(event, fn)
    return () => listeners.delete(event)
  },
  get(service) {
    return service === 'connection' ? connection : undefined
  },
  effect(fn) {
    // Must actually run: a no-op effect silently drops every route registration.
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(services, cb) {
    if (services.includes('connection')) {
      cb({
        connection,
        effect: rootCtx.effect,
        get: (name) => (name === 'connection' ? connection : undefined),
      })
      return
    }
    // No webServer in this harness: the raw HTTP alias is optional.
    throw new Error(`unexpected inject(${JSON.stringify(services)})`)
  },
}

plugin.apply(rootCtx, {
  ledgerFile,
  credentialsFile: path.join(dir, 'no-such-credentials.yaml'),
  sessionsRoot: path.join(dir, 'sessions'),
  transcriptSyncMs: 600_000,
  balanceTtlMs: 60_000,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (event, session) => {
  const fn = listeners.get('session/event')
  if (fn) fn(session, event)
}
const state = async (session) => {
  const handler = fetchRoutes.get('/api/dsh-spend/state')
  assert.ok(handler, 'state route was not registered')
  const req = new Request('http://127.0.0.1:1/api/dsh-spend/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session }),
  })
  return (await handler(req)).json()
}

const usage = { inputTokens: 1_000, cacheReadTokens: 0, outputTokens: 100 }
const model = 'deepseek-flash'
const step = (session, turn) =>
  emit({ type: 'assistant/message', data: { turn, usage, message: { source: { model } } } }, session)

await sleep(200)
assert.equal((await state('')).lastTurn, null, 'an empty meter starts with no last turn')

// ---- session A finishes a turn ---------------------------------------------
const a = { id: 'session-aaaa1111' }
step(a, 1)
emit({ type: 'turn/end', data: { turn: 1 } }, a)

for (const [label, id] of [
  ['session-prefixed', 'session-aaaa1111'],
  ['bare uuid', 'aaaa1111'],
]) {
  const json = await state(id)
  assert.ok(json.lastTurn, `${label}: the finished turn must be found`)
  assert.equal(json.lastTurn.turn, 1, label)
  assert.equal(json.lastTurn.scope, 'session', `${label}: an exact match is not a fallback`)
}

// ---- ids the ledger cannot know fall back to the active session ------------
for (const [label, id] of [
  ['empty id', ''],
  ['object-ish id', '[object Object]'],
  ['stale id', 'deadbeef'],
]) {
  const json = await state(id)
  assert.ok(json.lastTurn, `${label}: should fall back, not show a dash`)
  assert.equal(json.lastTurn.turn, 1, label)
  assert.equal(json.lastTurn.scope, 'active', `${label}: the live session is the best guess`)
}

// The id the panel sent is kept for diagnosis.
const diag = JSON.parse(fs.readFileSync(diagFile, 'utf8'))
assert.ok(diag.lastSession, 'diag must record what the panel asked for')
assert.equal(diag.lastSession.raw, 'deadbeef')
assert.equal(diag.lastSession.scope, 'active')

// ---- when the active session has not finished a turn, use the newest turn --
const c = { id: 'session-cccc3333' }
step(c, 1) // in flight: nothing committed for C yet, and C is now the active session
let json = await state('')
assert.equal(json.live.turn, 1, 'the in-flight turn belongs to the active session')
assert.ok(json.lastTurn, 'a finished turn exists from another session')
assert.equal(json.lastTurn.scope, 'recent', 'no committed turn for the active session yet')

// ---- a newer session does not hijack an exact match ------------------------
const b = { id: 'session-bbbb2222' }
step(b, 1)
emit({ type: 'turn/end', data: { turn: 1 } }, b)
await sleep(1_500) // debounced ledger write

const stillA = await state('session-aaaa1111')
assert.equal(stillA.lastTurn.scope, 'session', 'an exact id still wins over the active session')
const activeNow = await state('unknown-id')
assert.equal(activeNow.lastTurn.scope, 'active', 'the newest active session is B now')
assert.ok(activeNow.lastTurn.at >= stillA.lastTurn.at, 'B ran after A')

const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
assert.ok(ledger.sessions['aaaa1111'], 'sessions are keyed by the bare id')
assert.ok(ledger.sessions['bbbb2222'], 'sessions are keyed by the bare id')

fs.rmSync(dir, { recursive: true, force: true })
console.log('session-id: ok')
