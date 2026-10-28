/**
 * Live check against the real DeepSeek Platform billing summary.
 *
 * Reads the account grant from `$DSH_HOME/.credentials.yaml` (the same record the
 * DSH account service uses) and calls the Platform `get_user_summary` endpoint
 * through the plugin's own code path — no API key, no printing of secrets.
 *
 *   node test/live-platform.mjs [--watch]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const lib = (name) => import(pathToFileURL(path.join(here, '..', 'lib', name)).href)
const { readPlatformGrant, readPlatformSummary } = await lib('platform.js')

const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
const credentialsFile = path.join(home, '.credentials.yaml')

/** Minimal reader for the flat YAML the credentials store writes. */
function readCredentials(file) {
  const text = fs.readFileSync(file, 'utf8')
  const record = { version: 0, refs: {}, records: {} }
  let section = null
  let entry = null
  let field = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const [key, ...rest] = line.trim().split(':')
    const value = rest.join(':').trim().replace(/^['"]|['"]$/g, '')
    if (indent === 0) {
      section = key === 'refs' || key === 'records' ? key : null
      if (key === 'version') record.version = Number(value) || 0
      entry = null
      field = null
      continue
    }
    if (!section) continue
    if (indent === 2) {
      entry = key
      record[section][entry] = {}
      field = null
      continue
    }
    if (!entry) continue
    if (indent === 4) {
      field = key
      if (value) record[section][entry][field] = value
      continue
    }
    if (field && indent >= 6) {
      const current = record[section][entry][field]
      if (typeof current === 'object' && current !== null) current[key] = value
      field = key
      record[section][entry][key] = value
    }
  }
  return record
}

const parsed = readCredentials(credentialsFile)
const raw = parsed.records['deepseek-account-platform/default'] || {}
const grant = {
  kind: raw.token ? 'grant' : raw.kind || 'unknown',
  payload: { token: raw.token || raw.payload_token, issuer: raw.issuer || raw.payload_issuer },
}

const credentials = {
  async readRecord(key) {
    if (key !== 'deepseek-account-platform/default') return undefined
    return grant
  },
}

const resolved = await readPlatformGrant(credentials)
if (!resolved.grant) {
  console.error('✗ no platform grant in', credentialsFile, '—', resolved.error)
  process.exit(1)
}
console.log('grant:', resolved.grant.origin || 'https://platform.deepseek.com', 'token length', String(resolved.grant.token || '').length)

const watch = process.argv.includes('--watch')
const read = () => readPlatformSummary(resolved.grant)

if (!watch) {
  const summary = await read()
  if (!summary.ok) {
    console.error('✗ summary failed:', summary.error)
    process.exit(1)
  }
  console.log('✓ platform summary')
  console.log('  balance      ', summary.balance.toFixed(8), summary.currency)
  console.log('  bonus        ', summary.bonus.toFixed(8))
  console.log('  lifetime cost', summary.totalCosts.toFixed(8))
  process.exit(0)
}

let last = null
for (;;) {
  const summary = await read()
  const at = new Date().toISOString().slice(11, 19)
  if (!summary.ok) {
    console.log(at, '✗', summary.error)
  } else {
    const delta = last === null ? '' : ` Δcounter ${(summary.totalCosts - last).toFixed(8)}`
    console.log(at, 'balance', summary.balance.toFixed(8), '| lifetime', summary.totalCosts.toFixed(8), delta)
    last = summary.totalCosts
  }
  await new Promise((r) => setTimeout(r, 5000))
}
