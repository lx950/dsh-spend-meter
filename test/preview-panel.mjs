/**
 * node test/preview-panel.mjs
 *
 * Preview what the panel will show on this machine, host-half only: real
 * credentials, real transcripts, real Platform counter, but a throwaway ledger so
 * nothing the running app owns is touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const plugin = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)

const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
const credText = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')
const token = (credText.match(/token:\s*['"]?([^'"\n]+)/) || [])[1]

const credentials = {
  async readRecord() {
    return { kind: 'grant', payload: { token, issuer: 'https://platform.deepseek.com' } }
  },
  async resolve(ref) {
    if (ref !== 'DEEPSEEK_API_KEY') return undefined
    const key = (credText.match(/DEEPSEEK_API_KEY:\s*['"]?([^'"\n]+)/) || [])[1]
    return key ? { value: key, source: 'file' } : undefined
  },
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-preview-'))
const listeners = new Map()
const fetchRoutes = new Map()
const connection = {
  requestRejection: () => null,
  fetch: { register: (route) => (fetchRoutes.set(route.path, route.fetch), () => fetchRoutes.delete(route.path)) },
}
const runEffect = (fn) => {
  const d = fn()
  return typeof d === 'function' ? d : () => {}
}
const rootCtx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
    return () => {}
  },
  get: (s) => (s === 'credentials' ? credentials : s === 'connection' ? connection : undefined),
  effect: runEffect,
  inject(services, cb) {
    if (services.includes('webServer')) return cb({ webServer: { getOrigin: () => 'http://127.0.0.1', register: () => () => {} }, effect: runEffect })
    if (services.includes('connection')) return cb({ connection, effect: runEffect, get: (n) => (n === 'connection' ? connection : undefined) })
    throw new Error('unexpected inject ' + services)
  },
}

plugin.apply(rootCtx, {
  ledgerFile: path.join(tmp, 'ledger.json'),
  sessionsRoot: path.join(home, 'sessions'),
  balanceTtlMs: 5_000,
  balanceRefreshMs: 60_000,
  transcriptSyncMs: 60_000,
})

await new Promise((r) => setTimeout(r, 3_500))
const state = await (await fetchRoutes.get('/api/dsh-spend/state'))(
  new Request('http://127.0.0.1/api/dsh-spend/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: '' }),
  }),
).then((r) => r.json())

const money = (n) => (typeof n === 'number' ? n.toFixed(6) : String(n))
console.log('version     ', state.version)
console.log('balance     ', money(state.balance.value), state.balance.currency, 'from', state.balance.source)
console.log('counter     ', state.costs && money(state.costs.counter), state.costs && state.costs.available ? '(available)' : '(unavailable)')
console.log('today.actual', money(state.today.actual), '=', 'measured', money(state.today.actualMeasured), '+ before', money(state.today.actualBefore), '× factor', state.today.actualFactor)
console.log('today.est   ', money(state.today.amount), 'tokens', state.today.tokens, 'turns', state.today.turns)
console.log('transcript  ', JSON.stringify(state.meta.transcript))
console.log('errors      ', state.balance.error || 'none')
