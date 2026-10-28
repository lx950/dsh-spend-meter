/**
 * Read-only fallback for the two secrets this plugin needs.
 *
 * The host credentials service is the right way to get them, but the service a
 * plugin is injected with can be scoped so that `resolve` / `readRecord` answer
 * "nothing there" while the store on disk is perfectly fine — which silently
 * turns every number into "not configured". The store is a small YAML file at
 * `$DSH_HOME/.credentials.yaml`, so read it directly when the service comes up
 * empty. Nothing here is ever written, and no secret is ever logged.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `$DSH_HOME`, defaulting to `~/.dsh` like the host does. */
export function dshHome(env = process.env) {
  const explicit = env.DSH_HOME
  if (explicit && String(explicit).trim()) return String(explicit).trim()
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.dsh')
}

/** Path of the credential store (`$DSH_HOME/.credentials.yaml`). */
export function credentialsPath(env = process.env) {
  return path.join(dshHome(env), '.credentials.yaml')
}

const scalar = (value) => {
  const text = String(value).trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith(`'`) && text.endsWith(`'`)))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Parse the flat, two-space-indented YAML the credential store writes:
 *
 *     version: 1
 *     refs:
 *       DEEPSEEK_API_KEY: sk-…
 *     records:
 *       deepseek-account-platform/default:
 *         kind: grant
 *         payload:
 *           token: …
 *
 * Deliberately not a general YAML parser: only mappings and scalars, which is all
 * this file has ever contained.
 */
export function parseCredentials(text) {
  const store = { version: 0, refs: {}, records: {} }
  if (typeof text !== 'string') return store
  const stack = [{ indent: -1, node: store }]
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    const key = scalar(trimmed.slice(0, colon))
    const rest = trimmed.slice(colon + 1).trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].node
    if (!rest) {
      const child = {}
      parent[key] = child
      stack.push({ indent, node: child })
      continue
    }
    parent[key] = scalar(rest)
  }
  store.version = Number(store.version) || 0
  if (!store.refs || typeof store.refs !== 'object') store.refs = {}
  if (!store.records || typeof store.records !== 'object') store.records = {}
  return store
}

/** Read + parse the store. Returns `null` when it is missing or unreadable. */
export function readCredentialsFile(file = credentialsPath()) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    return parseCredentials(text)
  } catch {
    return null
  }
}

/** The API key, from `refs.DEEPSEEK_API_KEY` or any record payload that holds one. */
export function apiKeyFrom(store) {
  if (!store || typeof store !== 'object') return ''
  const ref = store.refs && store.refs.DEEPSEEK_API_KEY
  if (ref) {
    const value = typeof ref === 'string' ? ref : ref.value || ref.secret || ''
    if (value) return String(value)
  }
  const records = store.records && typeof store.records === 'object' ? store.records : {}
  for (const record of Object.values(records)) {
    const payload = record && record.payload
    const value = payload && (payload.value || payload.secret)
    if (value && String(payload.kind || record.kind || '') !== 'grant') return String(value)
  }
  return ''
}

/**
 * The signed-in account grant (`{token, origin}`), or `null`.
 * Same record the host account service reads: `<platform>/default`.
 */
export function grantFrom(store, key = 'deepseek-account-platform/default') {
  if (!store || typeof store !== 'object') return null
  const record = store.records && store.records[key]
  if (!record || typeof record !== 'object') return null
  if (record.kind && String(record.kind) !== 'grant') return null
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {}
  const token = payload.token
  if (!token) return null
  const origin = String(payload.issuer || 'https://platform.deepseek.com').replace(/\/+$/, '')
  return { token: String(token), origin: origin || 'https://platform.deepseek.com' }
}
