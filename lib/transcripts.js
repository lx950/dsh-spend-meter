/**
 * Read billed usage straight out of the host's own session transcripts.
 *
 * Why this exists: live `session/event` hooks only see messages emitted while the
 * plugin is running. Install the plugin at 04:44 and everything billed earlier
 * that day is invisible, which makes "today" wrong by however much the account
 * spent before. The transcripts are the host's authoritative record, are appended
 * for the whole day, and survive restarts — so we reconcile against them.
 *
 * File layout: `$DSH_HOME/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`
 *
 * That file is a **multi-frame** zstd stream. `zlib.zstdDecompressSync` decodes
 * the first frame and returns it without complaining, which silently truncates a
 * 2 MB transcript down to its first record. Every frame must be decoded
 * separately. Files are append-only, so a warm sync only decodes the frames that
 * appeared since the last pass.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Node 22 ships zstd in `node:zlib`; older runtimes do not have it at all. The
 * backfill is an enrichment, never a requirement, so on an older runtime this
 * file reports itself unavailable instead of throwing inside start-up.
 */
const zstdDecompress = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync.bind(zlib) : null

/** True when this runtime can decode zstd (node:zlib >= 22). */
export const zstdAvailable = zstdDecompress !== null
import { beijingDayKey, beijingDayStartMs, costOf } from './pricing.js'

/** zstd frame magic number, little endian. */
const FRAME_MAGIC = 0xfd2fb528

const round = (n) => Math.round((Number(n) || 0) * 1e8) / 1e8
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Session id from a directory name. Hosts differ (`<uuid>`, `session-<uuid>`, and legacy
 * double-prefixed folders have been seen side by side), so prefer the UUID when there is one:
 * the same conversation must not be counted under two ids.
 */
function sessionIdOf(name) {
  return sessionKey(name)
}

/** Canonical session key: the UUID when present, otherwise the bare name without `session-`. */
export function sessionKey(name) {
  const raw = String(name == null ? '' : name).trim()
  const match = raw.match(UUID)
  if (match) return match[0]
  return raw.replace(/^(session-)+/, '')
}
const emptyDay = () => ({
  day: null,
  amount: 0,
  tokens: 0,
  turns: 0,
  byModel: {},
  firstAt: null,
  lastAt: null,
  before: 0,
  after: 0,
})

/** Offsets of every zstd frame in `buf` (empty when the buffer is not zstd). */
export function frameStarts(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === FRAME_MAGIC) starts.push(i)
  }
  return starts
}

/** Decode frames `[from, to)` of `buf` into text (torn frames are skipped). */
export function decodeFrames(buf, starts, from = 0, to = starts.length) {
  if (zstdDecompress === null) return ''
  let text = ''
  for (let i = Math.max(0, from); i < Math.min(to, starts.length); i += 1) {
    const frame = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length)
    try {
      text += zstdDecompress(frame).toString('utf8')
    } catch {
      /* a torn final frame is normal for a file that is still being appended to */
    }
  }
  return text
}

/** Whole transcript as text (used by the audit tooling and the first pass). */
export function readTranscriptText(file) {
  const buf = fs.readFileSync(file)
  const starts = frameStarts(buf)
  if (starts.length === 0) return buf.toString('utf8')
  return decodeFrames(buf, starts)
}

/** Split text into complete lines plus the trailing partial one. */
function completeLines(text) {
  const parts = text.split('\n')
  const tail = parts.pop() || ''
  return { lines: parts, tail }
}

/** Every `session.v4.jsonl.zstd` under `<dshHome>/sessions`, newest first. */
export function listTranscripts(sessionsRoot) {
  const out = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return out
  }
  for (const ws of workspaces) {
    const wsDir = path.join(sessionsRoot, ws.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = path.join(wsDir, session.name, 'session.v4.jsonl.zstd')
      let stat = null
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      out.push({
        id: sessionIdOf(session.name),
        workspace: ws.name,
        file,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** One JSONL line -> a priced record, or null when it is not billed usage. */
function parseLine(line, dayKey, startMs, now) {
  if (!line) return null
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    return null
  }
  const usage = rec && rec.data && rec.data.usage
  if (!usage || typeof usage !== 'object') return null
  const at = Number(rec.time) || now
  if (beijingDayKey(at) !== dayKey || at < startMs) return null
  const source = (rec.data.message && rec.data.message.source) || null
  const model = (source && source.model) || 'deepseek-flash'
  const priced = costOf(usage, model, at)
  return {
    at,
    turn: Number(rec.data.turn) || 0,
    model,
    amount: priced.amount,
    tokens: priced.tokens.input + priced.tokens.cache + priced.tokens.output,
  }
}

/**
 * Billed records for one transcript.
 *
 * `cache` entry shape: `{ day, size, mtimeMs, frames, tail, records }`. Append-only
 * files reuse it and only decode the frames that arrived since the last pass.
 */
function fileRecords(entry, cache, dayKey, startMs, now) {
  const buf = fs.readFileSync(entry.file)
  const starts = frameStarts(buf)
  const cached = cache.get(entry.file)
  const reusable =
    cached &&
    // Records are filtered to a day when they are parsed, so a cache entry is only
    // valid for the day it was built for. Reusing one across midnight would fold
    // yesterday's usage into today (the file keeps growing, the day does not).
    cached.day === dayKey &&
    cached.frames > 0 &&
    starts.length >= cached.frames &&
    entry.size >= cached.size &&
    Array.isArray(cached.records)

  if (reusable) {
    const text = cached.tail + decodeFrames(buf, starts, cached.frames)
    const { lines, tail } = completeLines(text)
    const records = cached.records.slice()
    for (const line of lines) {
      const rec = parseLine(line, dayKey, startMs, now)
      if (rec) records.push(rec)
    }
    cache.set(entry.file, { day: dayKey, size: entry.size, mtimeMs: entry.mtimeMs, frames: starts.length, tail, records })
    return records
  }

  const text = starts.length === 0 ? buf.toString('utf8') : decodeFrames(buf, starts)
  const { lines, tail } = completeLines(text)
  const records = []
  for (const line of lines) {
    const rec = parseLine(line, dayKey, startMs, now)
    if (rec) records.push(rec)
  }
  cache.set(entry.file, { day: dayKey, size: entry.size, mtimeMs: entry.mtimeMs, frames: starts.length, tail, records })
  return records
}

/**
 * Aggregate one Beijing day of billed usage across every transcript.
 *
 * @param {object} options
 * @param {string} options.sessionsRoot e.g. `~/.dsh/sessions`
 * @param {string} options.dayKey       `YYYY-MM-DD` in Beijing time
 * @param {Map}    [options.cache]      file -> incremental parse state
 * @param {number} [options.splitAt]    mark usage before this instant as `day.before`
 * @returns {{ day: object, sessions: object, files: number, firstAt: number|null, error: string|null }}
 */
export function readDayUsage({ sessionsRoot, dayKey, cache = new Map(), now = Date.now(), splitAt = null }) {
  const day = emptyDay()
  day.day = dayKey
  day.after = 0
  /** sessionId -> { turn, amount, tokens, at, model } (latest turn wins) */
  const sessions = {}
  const startMs = beijingDayStartMs(dayKey)
  const result = { day, sessions, files: 0, firstAt: null, error: null }
  if (startMs === null) {
    result.error = `bad day key: ${dayKey}`
    return result
  }
  if (!zstdAvailable) {
    // Older runtime: the panel keeps working on the balance book alone, the
    // backfill just reports why it is missing instead of silently showing 0.
    result.error = 'transcript backfill needs Node 22+ (node:zlib has no zstd decoder)'
    return result
  }
  const live = new Set()

  for (const entry of listTranscripts(sessionsRoot)) {
    // A file untouched since the day started cannot hold records from this day.
    if (entry.mtimeMs < startMs - 60_000) continue
    live.add(entry.file)
    let records
    try {
      records = fileRecords(entry, cache, dayKey, startMs, now)
    } catch {
      continue
    }
    result.files += 1
    for (const rec of records) {
      day.amount = round(day.amount + rec.amount)
      day.tokens += rec.tokens
      day.turns += 1
      const m = day.byModel[rec.model] || (day.byModel[rec.model] = { amount: 0, tokens: 0 })
      m.amount = round(m.amount + rec.amount)
      m.tokens += rec.tokens
      if (day.firstAt === null || rec.at < day.firstAt) day.firstAt = rec.at
      if (day.lastAt === null || rec.at > day.lastAt) day.lastAt = rec.at
      if (splitAt !== null) {
        if (rec.at < splitAt) day.before = round(day.before + rec.amount)
        else day.after = round(day.after + rec.amount)
      }
      const prev = sessions[entry.id]
      const agg =
        prev && prev.turn === rec.turn ? prev : { turn: rec.turn, amount: 0, tokens: 0, at: rec.at, model: rec.model }
      agg.amount = round(agg.amount + rec.amount)
      agg.tokens += rec.tokens
      agg.model = rec.model
      if (rec.at > agg.at) agg.at = rec.at
      sessions[entry.id] = agg
    }
  }

  // Drop cache entries for transcripts that no longer exist (deleted sessions).
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)
  return result
}

/**
 * Learn how the provider's invoice compares to the rate-card estimate.
 *
 * List prices are not always exactly what is charged (tokenizer differences, cache
 * bookkeeping, account-level rounding). Once we hold both numbers for the same
 * window — what the balance dropped by, and what the transcripts price that window
 * at — their ratio is the correction to apply to windows we could not measure.
 * Deliberately narrow: a wild ratio is ignored rather than trusted.
 */
export function calibrationOf(measured, estimate, previous = null) {
  const m = Number(measured)
  const e = Number(estimate)
  if (!(m >= 0.05) || !(e >= 0.02)) return previous
  const factor = Math.min(1.8, Math.max(0.8, m / e))
  return { factor: Math.round(factor * 1e4) / 1e4, at: Date.now(), measured: round(m), estimate: round(e) }
}

/**
 * Balance-delta accounting: what the account actually paid.
 *
 * The provider only exposes a running balance, so a day's real spend is
 * `opening + credits - last`. Recharges/gifts show up as increases, which must
 * not be mistaken for negative spend.
 */
export function trackBalanceDay(previous, value, dayKey, now = Date.now()) {
  const v = Number(value)
  const state =
    previous && previous.day === dayKey && Number.isFinite(previous.opening)
      ? { ...previous }
      : {
          day: dayKey,
          opening: Number.isFinite(v) ? v : null,
          last: Number.isFinite(v) ? v : null,
          credits: 0,
          since: now,
          at: now,
        }
  if (!Number.isFinite(v)) return state
  if (state.last === null) {
    state.opening = v
    state.last = v
    state.since = state.since || now
  } else if (v > state.last) {
    state.credits = round((state.credits || 0) + (v - state.last))
    state.last = v
  } else {
    state.last = v
  }
  state.at = now
  state.spent = round(Math.max((state.opening ?? v) + (state.credits || 0) - (state.last ?? v), 0))
  return state
}
