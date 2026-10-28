/**
 * Attribution math, kept pure so it can be tested without a host.
 *
 * Money arrives from the Platform as a lifetime spend counter (`total_costs`) that
 * only grows. Two questions follow:
 *
 *   1. "How much today?"  -> advanceCostDay() turns the counter plus today's opening
 *      reading into a per-day figure.
 *   2. "How much for *that* turn?" -> splitCharge() hands a newly observed charge to
 *      the turn(s) that are still waiting for settlement.
 */

const round8 = (n) => Math.round((Number(n) || 0) * 1e8) / 1e8

/**
 * Fold one counter reading into the day book.
 *
 * @param previous book for a previous reading, or null/undefined.
 * @param options.dayKey Beijing day key of the reading.
 * @param options.counter lifetime spend counter (CNY).
 * @param options.now reading timestamp (epoch ms).
 * @returns `{ book, delta }` where `delta` is the charge seen since the previous
 *   reading (0 on a new day, since a new day's opening reading defines its baseline).
 */
export function advanceCostDay(previous, { dayKey, counter, now }) {
  const value = Number(counter)
  if (!Number.isFinite(value)) return { book: previous || null, delta: 0 }
  if (!previous || previous.day !== dayKey) {
    // First reading of the day: the counter only measures "today" from here on.
    return {
      book: { day: dayKey, opening: round8(value), last: round8(value), since: now, at: now },
      delta: 0,
    }
  }
  const delta = round8(value - round8(previous.last))
  if (delta < 0) {
    // Refund or a counter reset: trust the new reading, never invent spend.
    return { book: { ...previous, last: round8(value), at: now }, delta: 0 }
  }
  return { book: { ...previous, last: round8(value), at: now }, delta }
}

/**
 * Split `amount` across the turns still waiting for a charge.
 *
 * One waiter takes all of it — that is the common case and it is exact. Several
 * waiters (a background subagent charged alongside yours) split it in proportion to
 * the rate-card estimate each turn already has, which keeps the total exact.
 *
 * @param waiting turns in settlement order, each `{ estimate }`.
 * @param amount charge observed since the previous counter reading.
 * @returns amounts aligned with `waiting`; empty when nothing is waiting.
 */
export function splitCharge(waiting, amount) {
  const items = Array.isArray(waiting) ? waiting : []
  const total = round8(amount)
  if (items.length === 0 || !(total > 0)) return []
  if (items.length === 1) return [total]
  const weights = items.map((item) => Math.max(Number(item && item.estimate) || 0, 0))
  const sum = weights.reduce((acc, w) => acc + w, 0)
  const shares = []
  let rest = total
  for (let i = 0; i < items.length; i += 1) {
    if (i === items.length - 1) {
      shares.push(rest)
      break
    }
    const share = round8((total * (sum > 0 ? weights[i] : 1)) / (sum > 0 ? sum : items.length))
    shares.push(share)
    rest = round8(rest - share)
  }
  return shares
}

/** `last - opening`, clamped at zero: what the day cost so far, from the counter. */
export function spentOfDay(book) {
  if (!book) return null
  const opening = Number(book.opening)
  const last = Number(book.last)
  if (!Number.isFinite(opening) || !Number.isFinite(last)) return null
  return round8(Math.max(last - opening, 0))
}
