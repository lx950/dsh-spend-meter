// Aggregate today's token usage from the host's own session transcripts, so we
// can tell whether the plugin's ledger is missing events or pricing them wrong.
//
// The transcript is a multi-frame zstd stream of JSONL. Each frame must be
// decompressed separately: Node's zstdDecompressSync happily decodes just the
// first frame and reports success, which silently truncates the file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const pricing = await import(pathToFileURL('E:/deepseek/dsh-spend-meter/lib/pricing.js').href)

const root = path.join(os.homedir(), '.dsh', 'sessions', '--E-deepseek--')
const FRAME_MAGIC = 0xfd2fb528

function readTranscript(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === FRAME_MAGIC) starts.push(i)
  }
  if (starts.length === 0) return ''
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    const frame = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try {
      text += zlib.zstdDecompressSync(frame).toString('utf8')
    } catch {
      /* skip a torn frame */
    }
  }
  return text
}

const dayKey = (ms) => pricing.beijingDayKey(ms)
const today = dayKey(Date.now())

const files = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ dir: e.name, file: path.join(root, e.name, 'session.v4.jsonl.zstd') }))
  .filter((e) => fs.existsSync(e.file))

let totalTokens = 0
let totalCost = 0
const rows = []
const byHour = new Map()
let firstAt = Infinity

for (const { dir, file } of files) {
  const text = readTranscript(file)
  let sessionMeta = null
  let messages = 0
  let tokens = 0
  let cost = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type === 'session') sessionMeta = rec
    const usage = rec.data && rec.data.usage
    if (!usage) continue
    const at = rec.time || 0
    if (!at || dayKey(at) !== today) continue
    const model = (rec.data.message && rec.data.message.source && rec.data.message.source.model) || 'deepseek-flash'
    const c = pricing.costOf(
      {
        inputTokens: usage.inputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        outputTokens: usage.outputTokens || 0,
      },
      model,
      at,
    )
    messages++
    tokens += (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.outputTokens || 0)
    cost += c.amount
    if (at < firstAt) firstAt = at
    const hour = new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 13)
    byHour.set(hour, (byHour.get(hour) || 0) + c.amount)
  }
  if (messages > 0) {
    rows.push({
      id: dir.replace(/^session-/, '').slice(0, 8),
      messages,
      tokens,
      cost,
      parent: sessionMeta && sessionMeta.parentSession ? String(sessionMeta.parentSession).slice(0, 8) : '',
      depth: sessionMeta ? sessionMeta.delegationDepth : '',
      started: sessionMeta ? new Date(sessionMeta.createdAt).toISOString().slice(11, 16) : '',
    })
  }
  totalTokens += tokens
  totalCost += cost
}

console.log('today', today)
console.log('\nsessions with usage today:')
rows.sort((a, b) => b.cost - a.cost)
for (const r of rows) {
  console.log(
    `  ${r.id}  msgs=${String(r.messages).padStart(3)}  tokens=${String(r.tokens).padStart(9)}  ¥${r.cost.toFixed(4)}  started=${r.started}Z  depth=${r.depth} parent=${r.parent || '-'}`,
  )
}
console.log('\nby hour (Beijing):')
for (const [hour, cost] of [...byHour.entries()].sort()) console.log(`  ${hour.slice(11)}:00  ¥${cost.toFixed(4)}`)
console.log('\ntranscript total: ¥' + totalCost.toFixed(4), '| tokens', totalTokens)
console.log('first usage today at', firstAt === Infinity ? '-' : new Date(firstAt + 8 * 3600 * 1000).toISOString().slice(11, 19), 'Beijing')
