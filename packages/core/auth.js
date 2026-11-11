// WeShirt · 身份与令牌
// 全部使用 Web Crypto（globalThis.crypto.subtle），Node 22 与 EdgeOne 均原生可用。
// 不引入 node:crypto 专属 API，保证双形态同源。

const enc = new TextEncoder()

// ── HMAC-SHA256 十六进制签名 ──
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── 一次性票据（不落库）──
//
// 为什么不存 KV：EdgeOne KV 是**最终一致**的，刚写进去的 state / claim
// 可能几十秒内读不到。登录链路里连着两次这种读，表现就是「有时候登录失败」。
// 把 state 和 claim 做成签名票据，服务端算一下就能验，不依赖存储一致性。

function b64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/**
 * 签发票据：`<base64url(payload)>.<hex sig>`，payload 里必须有 exp（毫秒时间戳）。
 * @param {object} payload
 * @param {string} secret
 */
export async function issueTicket(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const sig = await hmacHex(secret, body)
  return `${body}.${sig}`
}

/** 校验票据：签名对、未过期才返回 payload，否则 null */
export async function verifyTicket(ticket, secret) {
  if (!ticket || typeof ticket !== 'string') return null
  const i = ticket.lastIndexOf('.')
  if (i <= 0) return null
  const body = ticket.slice(0, i)
  const sig = ticket.slice(i + 1)
  const expect = await hmacHex(secret, body)
  if (!timingSafeEqual(expect, sig)) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)))
    if (!payload || typeof payload !== 'object') return null
    if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

// ── 同步密钥（只能触发 /api/cron/sync）──
//
// 提醒是同步时发的，没人打开页面就不会同步 —— 需要一个外部定时器定时打一下。
// 但第三方定时服务会把 URL 存下来，不能把管理员口令给它，
// 所以从 AUTH_SECRET 派生一个只能触发同步的低权限密钥。
export async function deriveSyncKey(secret) {
  const s = String(secret || '').trim()
  if (s.length < 16) return ''
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s + ':cron-sync'))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24)
}

// 短 user id：u_ + 10 位 base36
export function newUserId() {
  const arr = new Uint32Array(10)
  crypto.getRandomValues(arr)
  let s = ''
  for (let i = 0; i < 10; i++) s += (arr[i] % 36).toString(36)
  return 'u_' + s
}

// 签发令牌：<userId>.<ts>.<sig>，签名 "userId.ts"
export async function issueToken(userId, secret) {
  const ts = Date.now()
  const msg = `${userId}.${ts}`
  const sig = await hmacHex(secret, msg)
  return `${userId}.${ts}.${sig}`
}

// 校验令牌：签名正确且签发时间距现在 ≤ 90 天；返回 userId 或 null
export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userId, tsStr, sig] = parts
  if (!userId || !tsStr || !sig) return null
  const ts = Number(tsStr)
  if (!Number.isFinite(ts) || String(ts) !== tsStr) return null

  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000
  const now = Date.now()
  if (now - ts > NINETY_DAYS) return null // 过期
  if (now - ts < -5 * 60 * 1000) return null // 防未来签发过多

  const expect = await hmacHex(secret, `${userId}.${ts}`)
  if (!timingSafeEqual(expect, sig)) return null
  return userId
}

// Native sessions are opaque/revocable and must never be accepted by legacy
// HMAC validation. Every server module uses this request-aware entry point.
export async function verifyRequestUser(c, secret) {
  const match = (c.req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  if (match[1].startsWith('ma1.')) {
    let verification = c.get?.('mobileAccessVerification')
    if (!verification) {
      verification = Promise.resolve(c.get?.('mobileAuthService')?.verifyAccessToken(match[1]) || null)
      c.set?.('mobileAccessVerification', verification)
    }
    return verification
  }
  const key = String(secret || '').trim()
  return key.length >= 16 ? verifyToken(match[1], key) : null
}

// PBKDF2(100k) → "salt:hash"（V2 账号体系用，可 stub 但此处给出真实实现）
export async function hashPassword(pw) {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  )
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const saltHex = [...salt].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${saltHex}:${hashHex}`
}

// 简单常量时间比较（防时序侧信道）
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

// ── 管理后台会话 ──
//
// 以前前端把 ADMIN_TOKEN 原样塞进 localStorage，输一次密码就永久有效 ——
// 手机丢了等于后台丢了。现在改成：口令只用来换一张 12 小时的会话票据，
// 票据带 exp，过期自动失效，也可以主动退出。
//
// 票据用 AUTH_SECRET 签名（和用户 token、同步密钥同一套体系），
// payload 里带 role: 'admin'，不会和用户 token 混淆。
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export async function issueAdminSession(secret, ttlMs = ADMIN_SESSION_TTL_MS) {
  const s = String(secret || '').trim()
  if (s.length < 16) return null
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : ADMIN_SESSION_TTL_MS
  return issueTicket({ role: 'admin', exp: Date.now() + ttl }, s)
}

export async function verifyAdminSession(ticket, secret) {
  const s = String(secret || '').trim()
  if (s.length < 16) return null
  const payload = await verifyTicket(ticket, s)
  if (!payload || payload.role !== 'admin') return null
  return payload
}
