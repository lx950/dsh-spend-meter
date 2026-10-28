/**
 * The host can inject a credentials service that answers "nothing stored" even
 * though the store on disk is fine. That silently turned every number into
 * "not configured", so the plugin reads `$DSH_HOME/.credentials.yaml` itself as a
 * fallback. This test boots `apply()` with **no** credentials service at all and
 * proves both secrets are still found: the Platform grant (8-decimal summary +
 * spend counter) and the API key (the 2-decimal fallback).
 *
 *   node test/credentials-e2e.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entryUrl = pathToFileURL(path.join(root, 'lib', 'index.js')).href
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const GRANT_YAML = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-synthetic-key',
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      token: synthetic-token',
  '      issuer: https://platform.deepseek.com',
  '',
].join('\n')

const KEY_ONLY_YAML = ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-synthetic-key', 'records: {}', ''].join('\n')

/**
 * Boot one isolated plugin instance (a query string gives a fresh module) with no
 * credentials service, and return handles for polling its routes.
 */
async function boot(credentialText, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-credentials-'))
  const credentialsFile = path.join(dir, '.credentials.yaml')
  fs.writeFileSync(credentialsFile, credentialText)

  const calls = { platform: 0, apiKey: 0 }
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('get_user_summary')) {
      calls.platform += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          msg: '',
          data: {
            biz_code: 0,
            biz_msg: '',
            biz_data: {
              normal_wallets: [{ currency: 'CNY', balance: '12.5000000000' }],
              bonus_wallets: [],
              total_costs: [{ currency: 'CNY', amount: '80.2500000000' }],
            },
          },
        }),
      }
    }
    if (href.includes('api.deepseek.com/user/balance')) {
      calls.apiKey += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] }),
      }
    }
    return { status: 404, json: async () => ({}) }
  }

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
    // Deliberately no `credentials`: the file fallback is what is under test.
    get(service) {
      return service === 'connection' ? connection : undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services, cb) {
      if (services.includes('connection')) {
        cb({ connection, effect: rootCtx.effect, get: (name) => (name === 'connection' ? connection : undefined) })
        return
      }
      throw new Error(`unexpected inject(${JSON.stringify(services)})`)
    },
  }

  const module = await import(`${entryUrl}?scenario=${encodeURIComponent(extra.label || 'a')}`)
  module.apply(rootCtx, {
    ledgerFile: path.join(dir, 'ledger.json'),
    credentialsFile,
    sessionsRoot: path.join(dir, 'sessions'),
    balanceTtlMs: 60_000,
    balanceRefreshMs: 600_000,
    transcriptSyncMs: 600_000,
  })
  await sleep(extra.waitMs || 500)

  const health = async () => {
    const handler = fetchRoutes.get('/api/dsh-spend/health')
    assert.ok(handler, 'health route was not registered')
    const req = new Request('http://127.0.0.1:1/api/dsh-spend/health', { method: 'POST', body: '{}' })
    return (await handler(req)).json()
  }

  return { dir, calls, health }
}

// ---- with a Platform grant: the 8-decimal summary + spend counter ------------
const granted = await boot(GRANT_YAML, { label: 'grant' })
let state = await granted.health()
assert.ok(granted.calls.platform >= 1, 'the Platform summary must be attempted from the file grant')
assert.equal(state.platform.credentialSource, 'file', `expected the file grant, got ${state.platform.credentialSource}`)
assert.equal(state.platform.ok, true, `platform read failed: ${state.platform.error}`)
assert.ok(Math.abs(state.platform.balance - 12.5) < 1e-9)
assert.ok(Math.abs(state.platform.totalCosts - 80.25) < 1e-9)
assert.equal(state.balanceSource, 'platform')
assert.ok(Math.abs(state.balanceValue - 12.5) < 1e-9)
assert.equal(granted.calls.apiKey, 0, 'the cents-only API-key path must not be needed')
fs.rmSync(granted.dir, { recursive: true, force: true })

// ---- grant missing: the API key from the same file is the fallback -----------
const keyed = await boot(KEY_ONLY_YAML, { label: 'key' })
// The boot refresh may still be landing; give it a moment before judging.
for (let i = 0; i < 20; i += 1) {
  state = await keyed.health()
  if (state.balanceSource) break
  await sleep(100)
}
assert.equal(keyed.calls.platform, 0, 'without a grant there is nothing to send to the Platform')
assert.equal(state.platform.ok, false, 'no grant must not look like a successful read')
assert.equal(state.platform.credentialSource, null)
assert.ok(keyed.calls.apiKey >= 1, 'the API key must be read from the credential file')
assert.equal(state.balanceSource, 'api-key')
assert.ok(Math.abs(state.balanceValue - 12.5) < 1e-9)
fs.rmSync(keyed.dir, { recursive: true, force: true })

console.log('credentials-e2e: ok', {
  granted: { platform: granted.calls.platform, apiKey: granted.calls.apiKey },
  keyed: { platform: keyed.calls.platform, apiKey: keyed.calls.apiKey },
})
process.exit(0)
