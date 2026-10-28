/**
 * DeepSeek pricing table + peak/off-peak schedule.
 *
 * Units: CNY per 1,000,000 tokens.
 * Every table below is `[offPeak, peak]`. Peak = ×2 of off-peak.
 *
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   - 2026-08-17 peak/off-peak pricing went live (09:00-12:00, 14:00-18:00 Beijing time = peak).
 *   - 2026-08-23 weekends are off-peak all day.
 *   - 2026-09-19 Chinese statutory holidays are off-peak all day as well.
 *   - 2026-09-10 DeepSeek-V4.1-Flash price cut: cache hit 0.05 -> 0.02, miss 1.5 -> 1, output 4.5 -> 4.
 *
 * If DeepSeek changes prices again, edit PRICING and (for holidays) HOLIDAY_VALLEY.
 */

/** Peak windows in Beijing local hours, `[start, end)` . */
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/** Flash tier — also the fallback for any unknown model. */
const FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
/** Pro tier — 3× Flash. */
const PRO = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

export const PRICING = {
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
  'deepseek-v4-pro': PRO,
  _default: FLASH,
}

/** Epoch seconds from which weekends are billed off-peak (Beijing 2026-08-23 00:00). */
export const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
/** Epoch seconds from which statutory holidays are billed off-peak (Beijing 2026-09-19 00:00). */
export const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000)

/**
 * Statutory holidays (dates that are days OFF). Make-up workdays all fall on a
 * weekend, and weekends are already off-peak, so only days off need listing.
 * Source: 国办发明电〔2025〕7 号 (2026 arrangement). Extend every November.
 */
export const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}

/** Beijing calendar day key (`YYYY-MM-DD`) for an epoch-millisecond timestamp. */
export function beijingDayKey(ms) {
  return new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Beijing wall clock `{ hour, day }` for an epoch-millisecond timestamp. */
function beijingClock(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000)
  return { hour: d.getUTCHours(), dow: d.getUTCDay() }
}

/** True when `ms` is charged at the peak rate. */
export function isPeakTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return false
  const sec = Math.floor(n / 1000)
  const { hour, dow } = beijingClock(n)
  if (sec >= WEEKEND_VALLEY_FROM_SEC && (dow === 0 || dow === 6)) return false
  if (sec >= HOLIDAY_VALLEY_FROM_SEC && HOLIDAY_VALLEY[beijingDayKey(n)]) return false
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/** Epoch ms of 00:00 Beijing time for a `YYYY-MM-DD` day key. */
export function beijingDayStartMs(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''))
  if (!m) return null
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return utc - 8 * 3600 * 1000
}

/** Price table for a model id (falls back to the Flash tier). */
export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.includes(key)) return PRICING[key]
  }
  return PRICING._default
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Cost of one assistant message.
 *
 * `reasoningTokens` is a subset of `outputTokens` in DSH, so output is billed as
 * reported — never add reasoning on top, that roughly doubles the bill.
 *
 * @param {{ inputTokens?: number, cacheReadTokens?: number, outputTokens?: number }} usage
 * @param {string} model
 * @param {number} atMs epoch milliseconds of the message
 * @returns {{ amount: number, tier: 'peak'|'offpeak', price: { hit: number, miss: number, out: number }, tokens: { input: number, cache: number, output: number } }}
 */
export function costOf(usage, model, atMs) {
  const p = priceFor(model)
  const tier = isPeakTime(atMs) ? 'peak' : 'offpeak'
  const i = tier === 'peak' ? 1 : 0
  const tokens = {
    input: num(usage && usage.inputTokens),
    cache: num(usage && usage.cacheReadTokens),
    output: num(usage && usage.outputTokens),
  }
  const price = { hit: p.hit[i], miss: p.miss[i], out: p.out[i] }
  const amount =
    (tokens.cache / 1e6) * price.hit +
    (tokens.input / 1e6) * price.miss +
    (tokens.output / 1e6) * price.out
  return { amount, tier, price, tokens }
}
