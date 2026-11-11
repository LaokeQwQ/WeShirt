import { createMobileAuth, MOBILE_PACKAGE, MobileError } from '../packages/core/mobile-auth.js'
import { readBoundedJson } from '../packages/core/assistant.js'
import { scopedFavoriteMachines } from '../packages/core/favorites.js'
import { DORM_BUILDINGS, normalizeDormBuilding } from '../packages/core/buildings.js'
import { getUserPermissions } from '../packages/core/permissions.js'
import { applyRegisteredAvailability } from '../packages/core/availability.js'
import { taskLifecycle } from '../packages/core/task-retention.js'

export { createMobileAuth }
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value)
const fail = (code, message, status) => { throw new MobileError(code, message, status) }
const publicInstallation = row => row ? { installationId: row.installationId, provider: row.provider, notificationsEnabled: row.notificationsEnabled, appVersion: row.appVersion, updatedAt: row.updatedAt } : null

export function registerMobileRoutes(app, { store, env = {}, authenticate, getBoard, auth, atomicStore, pushProviders = [], mobilePush }) {
  const providers = [...new Set(pushProviders)].filter(value => ['fcm', 'upush'].includes(value))
  const pushEnabled = auth.atomicReady && env.MOBILE_PUSH_ENABLED === 'true' && providers.length > 0
  const wrap = handler => async c => {
    try { return c.json(await handler(c), 200, { 'Cache-Control': 'private, no-store' }) }
    catch (error) {
      const known = error instanceof MobileError
      return c.json({ error: { code: known ? error.code : error?.code === 'body_too_large' ? 'too_large' : 'mobile_unavailable', message: known ? error.message : '移动服务暂不可用，请稍后重试' } }, known ? error.status : error?.code === 'body_too_large' ? 413 : 503, { 'Cache-Control': 'no-store' })
    }
  }
  const body = async c => {
    try { return await readBoundedJson(c.req.raw, 8192) }
    catch (error) { if (error?.code === 'body_too_large') throw error; fail('bad_param', '请求须为 JSON 对象', 400) }
  }
  const userContext = async c => {
    const actor = await authenticate(c), id = typeof actor === 'string' ? actor : actor?.id
    const user = id ? await store.get('user:' + id, null) : null
    if (!user || user.disabled || user.blocked) fail('unauthorized', '请先登录', 401)
    return user
  }
  app.get('/api/mobile/config', wrap(async () => ({ protocolVersion: 1, packageName: MOBILE_PACKAGE, auth: auth.config(), push: { registrationEnabled: pushEnabled, providers: pushEnabled ? providers : [] }, realtime: { transport: 'http', minRefreshIntervalSeconds: 30 }, widget: { enabled: true } })))
  app.post('/api/mobile/auth/challenge', wrap(async c => auth.challenge(await body(c))))
  app.post('/api/mobile/auth/exchange', wrap(async c => auth.exchange(await body(c))))
  app.post('/api/mobile/auth/refresh', wrap(async c => auth.refresh(await body(c))))
  app.post('/api/mobile/auth/logout', wrap(async c => auth.logout(await body(c))))

  const installationContext = async c => {
    const user = await userContext(c), installationId = c.req.param('installationId')
    if (!idOK(installationId)) fail('bad_param', '设备编号无效', 400)
    const bearer = (c.req.header('authorization') || '').match(/^Bearer\s+(ma1\..+)$/i)
    const mobileSession = bearer ? await auth.verifyAccessContext(bearer[1]) : null
    if (bearer && (!mobileSession || mobileSession.installationId !== installationId)) fail('installation_not_owned', '此登录会话不能修改其他设备', 403)
    if (!auth.atomicReady) fail('mobile_push_not_configured', '原生推送尚未完成配置', 503)
    const key = 'mobile:installation:' + installationId, row = await atomicStore.get(key)
    if (row?.value.userId && row.value.userId !== user.id) fail('installation_not_owned', '此设备绑定不属于当前账号', 403)
    return { user, installationId, key, row, mobileSession }
  }
  app.get('/api/mobile/installations/:installationId', wrap(async c => {
    const { row } = await installationContext(c)
    return { installation: publicInstallation(row?.value) }
  }))
  app.put('/api/mobile/installations/:installationId', wrap(async c => {
    const { user, installationId, key, row, mobileSession } = await installationContext(c), patch = await body(c)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['provider', 'token', 'notificationsEnabled', 'appVersion'].includes(key)) || typeof patch.notificationsEnabled !== 'boolean' || typeof patch.appVersion !== 'string' || !/^[A-Za-z0-9.+_-]{1,40}$/.test(patch.appVersion)) fail('bad_param', '设备设置无效', 400)
    if (patch.notificationsEnabled && (!pushEnabled || !providers.includes(patch.provider))) fail('mobile_push_not_configured', '所选推送通道尚未完成配置', 503)
    if (patch.notificationsEnabled && (typeof patch.token !== 'string' || patch.token.length < 16 || patch.token.length > 4096 || /[\u0000-\u0020\u007f]/.test(patch.token))) fail('bad_param', '推送凭据无效', 400)
    const value = { userId: user.id, installationId, ...(mobileSession ? { sessionId: mobileSession.sessionId } : {}), provider: patch.notificationsEnabled ? patch.provider : null, token: patch.notificationsEnabled ? patch.token : null, notificationsEnabled: patch.notificationsEnabled, appVersion: patch.appVersion, updatedAt: new Date().toISOString() }
    if (patch.notificationsEnabled) await mobilePush?.register(user.id, installationId, mobileSession?.sessionId)
    if (!await atomicStore.compareAndSet(key, row?.version ?? null, value, { expiresAt: Date.now() + 90 * 86400000 })) fail('installation_conflict', '设备设置已更新，请刷新重试', 409)
    if (!patch.notificationsEnabled) await mobilePush?.remove(user.id, installationId, mobileSession?.sessionId)
    return { installation: publicInstallation(value) }
  }))
  app.get('/api/mobile/widget-snapshot', wrap(async c => {
    const user = await userContext(c), site = await store.get('meta:site', {}), catalog = site.buildings || DORM_BUILDINGS
    const dormBuilding = normalizeDormBuilding(user.dormBuilding, catalog), access = await getUserPermissions(store, user, catalog)
    const allowed = key => access.permissions[key]?.view && (access.permissions[key].viewBuildings === null || access.permissions[key].viewBuildings.includes(dormBuilding))
    let result = allowed('board') && dormBuilding ? await getBoard({ userId: user.id, dormBuilding }) : null
    if (result?.board) {
      const visible = new Set(scopedFavoriteMachines(result, user, catalog).map(machine => machine.id))
      const saved = await store.get('occupancy:' + (env.BUILDING_ID || 'b1'), {})
      const occupancy = Object.fromEntries(Object.entries(saved || {}).filter(([id]) => visible.has(String(id))))
      const owners = [...new Set(Object.values(occupancy).map(row => row?.userId).filter(id => typeof id === 'string'))]
      const tasksByUser = new Map(await Promise.all(owners.map(async id => [id, await store.get('tasks:' + id, [])])))
      result = { ...result, board: applyRegisteredAvailability(result.board, { occupancy, tasksByUser }) }
    }
    const machines = result ? scopedFavoriteMachines(result, user, catalog).map(machine => ({ ...machine, status: machine.state })) : []
    const ids = new Set(machines.map(machine => machine.id))
    const rows = allowed('tasks') ? await store.get('tasks:' + user.id, []) : []
    const tasks = (Array.isArray(rows) ? rows : []).filter(task => !taskLifecycle(task).archived && !task.done && !task.cancelled && !task.cancelledAt && (allowed('board') ? ids.has(String(task.machineId)) : false)).slice(0, 20).map(task => ({ id: task.id, machineId: String(task.machineId), kind: task.kind === 'dryer' ? 'dryer' : 'washer', status: Date.parse(task.endAt) <= Date.now() ? 'pending' : 'waiting', finishAt: task.endAt || null, note: typeof task.note === 'string' ? task.note.slice(0, 200) : '', useDisinfectant: task.useDisinfectant === true, selfCleaned: task.selfCleaned === true }))
    return { generatedAt: new Date().toISOString(), dormBuilding, tasks, machines, nextRefreshAfterSeconds: 300 }
  }))
}
