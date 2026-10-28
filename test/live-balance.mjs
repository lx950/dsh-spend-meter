/**
 * Manual, opt-in check: run the host half against the credentials already on
 * this machine and confirm the balance route really returns a number.
 *
 *   node test/live-balance.mjs
 *
 * It reads `DEEPSEEK_API_KEY` from `$DSH_HOME/.credentials.yaml` (or
 * `~/.dsh/.credentials.yaml`), performs the same balance call the plugin makes
 * at runtime, and prints exactly what the panel would show. Nothing is written
 * to disk and the key is never printed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const credentialsFile = path.join(dshHome, '.credentials.yaml')

if (!fs.existsSync(credentialsFile)) {
  console.log(`skip: no ${credentialsFile}`)
  process.exit(0)
}

const text = fs.readFileSync(credentialsFile, 'utf8')
const match = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text)
if (match === null) {
  console.log('skip: DEEPSEEK_API_KEY is not stored in the credentials file')
  process.exit(0)
}
const apiKey = match[1].trim()

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
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on() {
    return () => {}
  },
  get(service) {
    if (service === 'connection') return connection
    if (service === 'credentials') {
      return { resolve: async () => ({ value: apiKey, source: 'file' }) }
    }
    // No signed-in account service here: this check is the API-key path alone.
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject(services, cb) {
    if (services.length === 1 && services[0] === 'credentials') {
      cb({
        get: (service) =>
          service === 'credentials' ? { resolve: async () => ({ value: apiKey, source: 'file' }) } : undefined,
      })
      return
    }
    if (services.length === 1 && services[0] === 'deepseekAccount') {
      // Whether this host exposes the account service varies; the plugin has to
      // behave either way, so this check stays silent about it.
      return
    }
    if (services.includes('webServer')) {
      cb({
        webServer: {
          getOrigin: () => 'http://127.0.0.1:0',
          register: () => () => {},
        },
      })
      return
    }
    if (services.includes('connection')) {
      cb({
        connection,
        effect: rootCtx.effect,
        get: (service) => rootCtx.get(service),
      })
      return
    }
    throw new Error(`unexpected inject(${JSON.stringify(services)})`)
  },
}

plugin.apply(rootCtx, { ledgerFile: path.join(os.tmpdir(), 'dsm-live-ledger.json') })

const handler = fetchRoutes.get('/api/dsh-spend/state')
assert.ok(handler, 'state route was not registered')

async function state() {
  const req = new Request('http://127.0.0.1:0/api/dsh-spend/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'live-check' }),
  })
  const res = await handler(req)
  assert.equal(res.status, 200, 'state route must answer 200')
  return res.json()
}

// `apply()` kicks the first refresh without awaiting it, exactly like the host
// does at boot, so poll the way the panel does until the number lands.
let body = await state()
const deadline = Date.now() + 15_000
while (body.balance?.value === null || body.balance?.value === undefined) {
  if (Date.now() > deadline) break
  await new Promise((resolve) => setTimeout(resolve, 300))
  body = await state()
}

console.log('balance:', JSON.stringify(body.balance))
console.log('diag.apiKey:', JSON.stringify(body.balance?.diag?.apiKey ?? null))
console.log('today:', JSON.stringify(body.today))
console.log('lastTurn:', JSON.stringify(body.lastTurn))

if (body.balance?.value === null || body.balance?.value === undefined) {
  console.error('\nFAIL: the balance route returned no number')
  process.exit(1)
}
console.log(`\nok: panel would show 余额 ¥${body.balance.value} (${body.balance.source})`)
