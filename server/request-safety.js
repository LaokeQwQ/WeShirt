import { json } from '../packages/core/util.js'
import { logEvent } from '../packages/core/auditlog.js'
import { getUserIdentity } from '../packages/core/identity.js'
import { withOperationLock } from '../packages/core/operations.js'
import { readStreamBytes as limitedBytes } from '../packages/core/stream-bytes.js'

const MAX_BODY = 64 * 1024
const MAX_REPLY = 32 * 1024
const CACHE_TTL = 120000
const CACHE_LIMIT = 12
const flights = new WeakMap()
const writes = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
const excluded = /^\/api\/(?:auth(?:\/|$)|mobile(?:\/|$)|dingtalk(?:\/|$)|cron(?:\/|$)|telemetry(?:\/|$)|inspections(?:\/|$)|urge\/reveal(?:\/|$))|\/(?:photos?|uploads?)(?:\/|$)/
const eventId = () => 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value))].map((b) => b.toString(16).padStart(2, '0')).join('')

export function requestRoute(c) {
  // Matched patterns contain parameter names, never values from a URL or body.
  const routes = c.req.matchedRoutes || []
  const path = routes.map((route) => route.path).filter((value) => typeof value === 'string' && value.startsWith('/api/') && !value.includes('*')).at(-1)
  return path && /^\/[A-Za-z0-9_/:.{}?()-]+$/.test(path) ? path.slice(0, 120) : '/api/:unmatched'
}

function responseFrom(snapshot) {
  return snapshot ? new Response(snapshot.body, { status: snapshot.status, headers: snapshot.headers }) : json({ error: { code: 'idempotency_result_unavailable', message: '请求已处理，请刷新确认本次操作结果' } }, 409)
}

async function snapshotResponse(response) {
  const bytes = await limitedBytes(response.clone().body, MAX_REPLY)
  if (!bytes) return null
  let body = new TextDecoder().decode(bytes)
  if (response.status >= 500) {
    let code = 'internal'
    try { const candidate = JSON.parse(body)?.error?.code; if (typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(candidate)) code = candidate } catch { /* discard diagnostic bodies */ }
    body = JSON.stringify({ error: { code, message: '服务暂时不可用，请稍后重试' } })
  }
  return { status: response.status, body, headers: { 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } }
}

async function finalize(c, store) {
  const id = c.get('eventId')
  const response = c.res
  const headers = new Headers(response.headers)
  headers.set('X-Event-ID', id)
  const exposed = new Set((headers.get('Access-Control-Expose-Headers') || '').split(',').map((item) => item.trim()).filter(Boolean))
  exposed.add('X-Event-ID'); exposed.add('Idempotency-Replayed')
  headers.set('Access-Control-Expose-Headers', [...exposed].join(', '))
  if (response.status < 400) { c.res = new Response(response.body, { status: response.status, statusText: response.statusText, headers }); return }
  let original = null
  try { const bytes = await limitedBytes(response.clone().body, MAX_REPLY); if (bytes) original = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* non-JSON errors get a safe envelope */ }
  const existing = original?.error && typeof original.error === 'object' && !Array.isArray(original.error) ? original.error : {}
  const code = typeof existing.code === 'string' || typeof existing.code === 'number' ? existing.code : response.status === 404 ? 'not_found' : 'http_error'
  const message = response.status >= 500 ? '服务暂时不可用，请稍后重试' : typeof existing.message === 'string' ? existing.message : response.status === 404 ? '接口不存在' : '请求未能完成'
  const payload = response.status >= 500 || !original || typeof original !== 'object' || Array.isArray(original) ? {} : original
  payload.error = { code, message, eventId: id, status: response.status }
  for (const key of ['content-length', 'content-encoding', 'etag', 'last-modified']) headers.delete(key)
  headers.set('content-type', 'application/json; charset=utf-8'); headers.set('cache-control', 'no-store')
  c.res = new Response(JSON.stringify(payload), { status: response.status, headers })
  await logEvent(store, { type: 'error', level: response.status >= 500 ? 'error' : 'warn', action: '接口请求失败', target: requestRoute(c), detail: { eventId: id, status: response.status, method: c.req.method, code: typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : typeof code === 'number' ? code : 'http_error' } }).catch(() => {})
}

export function registerRequestSafety(app, { store, authenticate, now = () => Date.now() } = {}) {
  if (!store) throw new Error('request safety requires a store')
  let pending = flights.get(store)
  if (!pending) { pending = new Map(); flights.set(store, pending) }
  app.onError((_error, c) => {
    const id = c.get('eventId') || eventId()
    c.set('eventId', id)
    const unavailable=_error?.code==='machine_store_unavailable',status=unavailable?503:500
    return json({ error: { code: unavailable?'machine_store_unavailable':'internal', message: '服务暂时不可用，请稍后重试', eventId: id, status } }, status, { 'X-Event-ID': id, 'Cache-Control': 'no-store' })
  })
  app.use('/api/*', async (c, next) => {
    c.set('eventId', eventId())
    try {
      const key = c.req.header('Idempotency-Key')
      const accessError = c.get('adminAccessError')
      if (accessError) { c.res = json({ error: { code: accessError.code, message: accessError.message } }, accessError.status || 401); return }
      // Creation returns a credential once: never persist or replay that reply.
      // Temporary sessions also cannot replay a cached, more privileged Bearer result.
      const accessCodeRoute = /^\/api\/admin\/(?:access-codes|login)(?:\/|$)/.test(c.req.path)
      const eligible = writes.has(c.req.method) && key && !accessCodeRoute && !c.get('temporaryAdminAccess') && !excluded.test(c.req.path) && (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/json'
      if (!eligible) { await next(); return }
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) { c.res = json({ error: { code: 'bad_idempotency_key', message: '请求标识无效，请重新提交' } }, 400); return }
      const actor = await authenticate?.(c)
      const uid = typeof actor === 'string' ? actor : actor?.id || actor?.userId
      const user = uid ? await store.get('user:' + uid, null) : null
      if (!user || user.disabled || user.blocked) { await next(); return }
      if (Number(c.req.header('content-length')) > MAX_BODY) { c.res = json({ error: { code: 'too_large', message: '此写入请求不能超过 64KB' } }, 413); return }
      const body = await limitedBytes(c.req.raw.clone().body, MAX_BODY)
      if (!body) { c.res = json({ error: { code: 'too_large', message: '此写入请求不能超过 64KB' } }, 413); return }
      const identity = await getUserIdentity(store, uid)
      const overrides = await store.get('access:user:' + uid, null)
      const authHash = await digest(JSON.stringify({ role: identity.role, buildings: identity.buildings, dorm: user.dormBuilding || null, overrides }))
      const bucket = 'request:idempotency:' + await digest(uid)
      const scope = await digest(c.req.method + '\n' + new URL(c.req.url).pathname + new URL(c.req.url).search + '\n' + key)
      const bodyHash = await digest(body)
      const flightKey = bucket + ':' + scope + ':' + authHash
      const decision = await withOperationLock(store, bucket, async () => {
        const saved = await store.get(bucket, [])
        const entries = (Array.isArray(saved) ? saved : []).filter((entry) => entry.expiresAt > now())
        const row = entries.find((entry) => entry.scope === scope)
        if (row && row.bodyHash !== bodyHash) return { conflict: true }
        const running = pending.get(flightKey)
        if (running) return running.bodyHash === bodyHash ? { follower: running.promise } : { conflict: true }
        if (row && row.authHash === authHash) {
          if (row.state === 'complete') return { cached: true, snapshot: row.snapshot }
          return { busy: true }
        }
        let resolve
        const promise = new Promise((done) => { resolve = done })
        const leader = { bodyHash, promise, resolve }
        pending.set(flightKey, leader)
        try {
          await store.put(bucket, [...entries.filter((entry) => entry.scope !== scope), { scope, bodyHash, authHash, state: 'pending', expiresAt: now() + CACHE_TTL }].slice(-CACHE_LIMIT))
        } catch (error) { pending.delete(flightKey); resolve(null); throw error }
        return { leader }
      })
      if (decision.conflict) { c.res = json({ error: { code: 'idempotency_conflict', message: '请求标识已用于不同内容，请重新提交' } }, 409); return }
      if (decision.busy) { c.res = json({ error: { code: 'idempotency_in_progress', message: '相同请求正在处理，请稍后重试' } }, 409, { 'Retry-After': '1' }); return }
      if (decision.cached || decision.follower) {
        c.set('idempotencyReplay', true)
        c.res = responseFrom(decision.cached ? decision.snapshot : await decision.follower)
        c.res.headers.set('Idempotency-Replayed', 'true')
        return
      }
      let snapshot = null
      try {
        await next()
        snapshot = await snapshotResponse(c.res)
        await withOperationLock(store, bucket, async () => {
          const saved = await store.get(bucket, [])
          const entries = (Array.isArray(saved) ? saved : []).filter((entry) => entry.expiresAt > now() && entry.scope !== scope)
          await store.put(bucket, [401, 403].includes(c.res.status) ? entries : [...entries, { scope, bodyHash, authHash, state: 'complete', snapshot, expiresAt: now() + CACHE_TTL }].slice(-CACHE_LIMIT))
        })
      } finally { pending.delete(flightKey); decision.leader.resolve(snapshot) }
    } catch {
      c.res = json({ error: { code: 'internal', message: '服务暂时不可用，请稍后重试' } }, 500)
    } finally { await finalize(c, store) }
  })
}
