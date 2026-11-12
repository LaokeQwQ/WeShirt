import { matchedRoutes } from 'hono/route'
import { logEvent } from '../packages/core/auditlog.js'

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const READS = new Set(['GET', 'HEAD'])
const QUIET_ADMIN_READS = new Set(['/api/admin/status', '/api/admin/session', '/api/admin/machines', '/api/admin/operations', '/api/admin/telemetry', '/api/admin/audit-summary', '/api/admin/audit-logs'])
const TARGET_NAMES = new Set(['id', 'uid', 'userId', 'machineId', 'taskId', 'auditId', 'threadId', 'requestId', 'noticeId', 'buildingId', 'buildingCode', 'skillId'])
const ID = /^[A-Za-z0-9_-]{1,80}$/
const safeLabel = (value, limit = 24) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim()).slice(0, limit).join('') : ''

function requestRoute(c) {
  // 只采用开发者注册的路由模板，未知路径不把任意 URL 片段带入日志。
  const routes = matchedRoutes(c)
  const methods = ['ALL', c.req.method, ...(c.req.method === 'HEAD' ? ['GET'] : [])]
  return routes.slice().reverse().find((route) => route.path.startsWith('/api/') && !route.path.includes('*') && methods.includes(route.method))?.path || '/api/:unmatched'
}
function shouldAudit(path, method) {
  // 遥测自身已有匿名聚合，不能额外把用户身份关联到遥测批次。
  if (path === '/api/telemetry' || method === 'OPTIONS') return false
  if (WRITES.has(method)) return true
  if (!READS.has(method)) return false
  if (path.startsWith('/api/admin/')) return !QUIET_ADMIN_READS.has(path)
  return path.startsWith('/api/debug/') || path === '/api/upstream-info' || path === '/api/moderation/mutes' || /^\/api\/inspections\/[^/]+\/photo$/.test(path) || path === '/api/cron/sync'
}
function requestTarget(c, route) {
  const schema = route.split('/'), actual = c.req.path.split('/')
  for (let index = 0; index < schema.length; index++) {
    const name = schema[index].match(/^:([A-Za-z][A-Za-z0-9_]*)$/)?.[1]
    if (!name || !TARGET_NAMES.has(name)) continue
    let value
    try { value = decodeURIComponent(actual[index] || '') } catch { return { target: '[redacted]', targetType: name } }
    // JWT、URL、data、转义分隔符及长票据不符合实体 ID。绝不记录凭据形参。
    if (!ID.test(value) || /token|secret|bearer/i.test(value) || value.length > 64 && !/^[A-Za-z]+_[0-9a-f-]{36}$/i.test(value)) return { target: '[redacted]', targetType: name }
    return { target: value, targetType: name }
  }
  return { target: '', targetType: '' }
}
async function requestActor(c, store, authenticate, checkSuperAdmin) {
  let authenticated, bootstrap = false
  try { authenticated = await authenticate?.(c) } catch { /* 失败仍记录匿名请求 */ }
  try { bootstrap = Boolean(await checkSuperAdmin?.(c)) } catch { /* 同上 */ }
  const uid = typeof authenticated === 'string' ? authenticated : authenticated?.id
  let user = null
  if (typeof uid === 'string' && ID.test(uid)) {
    try { user = await store.get('user:' + uid, null) } catch { /* 不信请求字段或用户快照 */ }
  }
  if (user?.id !== uid || user?.disabled || user?.blocked) user = null
  return {
    actorId: user?.id || (bootstrap ? 'bootstrap' : ''),
    actorNick: user ? safeLabel(user.nick) || '已登录用户' : bootstrap ? '最高管理员会话' : '未登录请求',
    actorKind: bootstrap ? 'bootstrap' : user ? 'user' : 'anonymous',
  }
}

/** Register before request-safety and permission middleware so replays/denials also audit. */
export function registerAuditMiddleware(app, { store, env = {}, authenticate, checkSuperAdmin }) {
  app.use('/api/*', async (c, next) => {
    const method = c.req.method.toUpperCase(), path = c.req.path
    if (!shouldAudit(path, method)) return next()
    const route = requestRoute(c)
    const actor = await requestActor(c, store, authenticate, checkSuperAdmin)
    const started = Date.now()
    let failed = false
    try { await next() }
    catch (error) { failed = true; throw error }
    finally {
      try {
        const suppliedId = c.get('eventId')
        const eventId = typeof suppliedId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(suppliedId) ? suppliedId : crypto.randomUUID()
        const status = failed ? 500 : c.res.status
        const { target, targetType } = requestTarget(c, route)
        const temporary=c.get('temporaryAdminAccess')
        const effectiveActor=temporary?{actorId:temporary.id,actorNick:'临时管理员',actorKind:'temporaryAdmin'}:actor
        await logEvent(store, {
          type: 'operation', action: method + ' ' + route,
          actorId: effectiveActor.actorId, actorNick: effectiveActor.actorNick, target,
          level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
          detail: { method, route, status, outcome: status >= 200 && status < 400 ? 'success' : 'failure', actorKind: effectiveActor.actorKind, eventId, targetType, replayed: c.get('idempotencyReplay') === true, durationMs: Math.max(0, Math.min(3600000, Date.now() - started)) },
        })
      } catch { /* 审计失败不改变业务结果，不打印请求内容或凭据。 */ }
    }
  })
}
