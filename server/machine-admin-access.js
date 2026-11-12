import { verifyAdminSession, verifyRequestUser } from '../packages/core/auth.js'
import { getUserPermissions } from '../packages/core/permissions.js'
import { getSiteConfig } from './site.js'

const deny = (message, status = 403, code = 'forbidden') => { throw Object.assign(new Error(message), { code, status }) }

/** Re-read inside each write lock: request middleware is an initial ceiling, not a durable grant. */
export async function machineAdminRules(c, { store, env = {}, authorize, mode }) {
  const site = await getSiteConfig(store)
  let access = c.get('temporaryAdminAccess')
  if (access) {
    const service = c.get('adminAccessCodes')
    if (!service) deny('临时管理权限暂不可用', 503, 'unavailable')
    access = await service.verifyRequest(c, site.buildings)
    c.set('temporaryAdminAccess', access)
  } else {
    if (!await authorize(c)) deny('需要机器管理权限')
    const expected = String(env.ADMIN_TOKEN || '').trim(), token = c.req.header('x-admin-token') || c.req.query('token')
    if (expected.length >= 8 && token) {
      if (token === expected) return null
      const payload = await verifyAdminSession(token, env.AUTH_SECRET || '').catch(() => null)
      if (payload && !payload.accessCodeId) return null
    }
    const id = await verifyRequestUser(c, env.AUTH_SECRET || '').catch(() => null)
    const user = id ? await store.get('user:' + id, null) : null
    if (!user || user.disabled || user.blocked) deny('管理账号已失效', 401, 'unauthorized')
    access = await getUserPermissions(store, user, site.buildings)
  }
  const rules = access?.permissions?.adminMachines
  if (rules?.[mode] !== true) deny('没有机器管理的' + (mode === 'view' ? '查看' : '操作') + '权限')
  c.set('userAccess', access)
  return rules
}
