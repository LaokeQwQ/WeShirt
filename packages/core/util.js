// WeShirt 公共工具（主控维护，各 agent 直接 import，不要修改本文件）

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export function apiErr(code, message, status = 400) {
  return json({ error: { code, message: status >= 500 ? '服务暂时不可用，请稍后重试' : message } }, status)
}

// Derive fixed categories only; exception text may contain URLs or credentials.
export function safeErrorCategory(error) {
  let text = '', name = ''
  try { text = String(error?.message || error || ''); name = error?.name || '' } catch { return 'request_failed' }
  for (const status of [400, 401, 403, 404, 405, 408, 409, 429, 500, 502, 503, 504]) {
    if (text.includes('HAIER HTTP ' + status)) return 'HAIER HTTP ' + status
  }
  if (name === 'TimeoutError' || name === 'AbortError') return 'request_timeout'
  if (/incomplete|partial/i.test(text)) return 'upstream_incomplete'
  return 'request_failed'
}

export function nowISO() {
  return new Date().toISOString()
}

/** 两个 ISO 时间之间相差多少整分钟（to - from），非法输入返回 null */
export function minutesBetween(fromISO, toISO) {
  const a = new Date(fromISO).getTime()
  const b = new Date(toISO).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 60000)
}

export function safeJson(str, fallback = null) {
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}

/** 生成 len 位纯数字字符串（加密安全随机） */
export function randomCode(len = 6) {
  const arr = new Uint32Array(len)
  crypto.getRandomValues(arr)
  let s = ''
  for (let i = 0; i < len; i++) s += String(arr[i] % 10)
  return s
}

// 去掉了 0/o/1/l/i 这类手打容易认错的字符，剩 31 个
const KEY_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

/**
 * 生成 len 位「字母+数字」密钥（加密安全随机）。
 * 用于绑定码这类必须抗穷举的凭证：31^12 ≈ 7.9e17，
 * 而 6 位纯数字只有 1e6，配合无签名的明文回调可被爆破。
 */
export function randomKey(len = 12) {
  const arr = new Uint32Array(len)
  crypto.getRandomValues(arr)
  let s = ''
  for (let i = 0; i < len; i++) s += KEY_ALPHABET[arr[i] % KEY_ALPHABET.length]
  return s
}

export function pick(obj, keys) {
  const out = {}
  if (!obj) return out
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

/** 稳定哈希（用于订阅 endpoint 去重等），返回 32 位 hex */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function log(...args) {
  console.log('[weshirt]', ...args)
}

export function warn(...args) {
  console.warn('[weshirt]', ...args)
}
