/**
 * Minimal read-only client for the DeepSeek *Platform* account API.
 *
 * The public API-key endpoint (`https://api.deepseek.com/user/balance`) rounds to
 * cents, which makes it useless for measuring a single turn. The Platform account
 * summary — the same request the desktop app makes when you sign in with an account —
 * returns the wallet balance with eight decimals and, more useful still, a lifetime
 * spend counter (`total_costs`).
 *
 * That counter only ever grows, so a difference of two readings is money actually
 * charged in between: top-ups and bonus credits cannot distort it. That is the number
 * this plugin reports as "today".
 *
 * Nothing here writes: one GET, one JSON parse.
 */

export const PLATFORM_CREDENTIAL_KEY = 'deepseek-account-platform/default'
export const PLATFORM_ORIGIN = 'https://platform.deepseek.com'
export const SUMMARY_PATH = '/api/v0/users/get_user_summary'
export const PLATFORM_TIMEOUT_MS = 8_000

/** The Platform accepts its stored grant in this header; `Authorization: Bearer` answers 40003. */
export const PLATFORM_TOKEN_HEADER = 'x-dsh-auth-token'

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function wallets(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((wallet) => ({
      currency: String((wallet && wallet.currency) || ''),
      balance: num(wallet && wallet.balance),
    }))
    .filter((wallet) => wallet.balance !== null)
}

/** Sum one currency across wallets, preferring CNY; returns `{ amount, currency }`. */
export function sumWallets(list) {
  const parsed = wallets(list)
  if (parsed.length === 0) return { amount: 0, currency: 'CNY' }
  const cny = parsed.filter((wallet) => wallet.currency === 'CNY')
  const chosen = cny.length > 0 ? cny : parsed
  return {
    amount: chosen.reduce((sum, wallet) => sum + wallet.balance, 0),
    currency: chosen[0].currency || 'CNY',
  }
}

/** Parse the summary envelope. Returns `null` when it is not a successful payload. */
export function parseSummary(body) {
  if (!body || typeof body !== 'object') return null
  if (Number(body.code) !== 0) return null
  const data = body.data
  if (!data || typeof data !== 'object') return null
  if (Number(data.biz_code) !== 0) return null
  const biz = data.biz_data
  if (!biz || typeof biz !== 'object') return null
  const recharge = sumWallets(biz.normal_wallets)
  const bonus = sumWallets(biz.bonus_wallets)
  const costs = Array.isArray(biz.total_costs) ? biz.total_costs : []
  const costEntry = costs.find((entry) => entry && entry.currency === (recharge.currency || 'CNY')) || costs[0]
  const totalCosts = num(costEntry && costEntry.amount)
  return {
    currency: recharge.currency || bonus.currency || 'CNY',
    balance: recharge.amount,
    bonus: bonus.amount,
    totalCosts,
  }
}

/** Read the stored Platform grant through the host credentials service. */
export async function readPlatformGrant(credentials) {
  if (!credentials || typeof credentials.readRecord !== 'function') {
    return { grant: null, error: '当前 DSH 没有凭据服务' }
  }
  let record
  try {
    record = await credentials.readRecord(PLATFORM_CREDENTIAL_KEY)
  } catch (err) {
    return { grant: null, error: `读取账号凭据失败: ${String((err && err.message) || err).slice(0, 120)}` }
  }
  if (!record || record.kind !== 'grant') {
    return { grant: null, error: '未登录 DeepSeek 账号（无账号授权凭据）' }
  }
  const payload = record.payload || {}
  const token = payload.token
  if (!token) return { grant: null, error: '账号凭据里没有 token' }
  const origin = String(payload.issuer || PLATFORM_ORIGIN).replace(/\/+$/, '') || PLATFORM_ORIGIN
  return { grant: { token: String(token), origin }, error: null }
}

/**
 * One Platform account summary read.
 * Resolves `{ ok: true, at, balance, bonus, totalCosts, currency }` or `{ ok: false, error }`;
 * never throws, so callers can keep serving the panel while the network wobbles.
 */
export async function readPlatformSummary(options = {}) {
  const {
    token,
    origin = PLATFORM_ORIGIN,
    fetchImpl = fetch,
    timeoutMs = PLATFORM_TIMEOUT_MS,
    at = Date.now(),
  } = options
  if (!token) return { ok: false, at, error: '缺少账号 token' }
  const url = `${String(origin).replace(/\/+$/, '')}${SUMMARY_PATH}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { [PLATFORM_TOKEN_HEADER]: token, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, at, error: `账号接口请求失败: ${String((err && err.message) || err).slice(0, 120)}` }
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    return { ok: false, at, error: `账号接口返回非 JSON（HTTP ${response.status}）` }
  }
  const parsed = parseSummary(body)
  if (!parsed) {
    const code = body && body.code
    const msg = body && (body.msg || body.message)
    return {
      ok: false,
      at,
      error: code === 40003 || response.status === 401
        ? '账号登录已失效（请重新登录 DeepSeek 账号）'
        : `账号接口返回异常: ${code !== undefined ? code : response.status}${msg ? ` ${String(msg).slice(0, 80)}` : ''}`,
    }
  }
  return { ok: true, at, ...parsed }
}
