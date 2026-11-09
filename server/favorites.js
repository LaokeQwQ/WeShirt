import { DORM_BUILDINGS, normalizeDormBuilding } from '../packages/core/buildings.js'
import { withOperationLock } from '../packages/core/operations.js'
import { readBoundedJson } from '../packages/core/assistant.js'
import { FavoriteError, defaultLaundryPreferences, laundryPreferencesKey, visibleLaundryPreferences, scopedFavoriteMachines, validateLaundryPreferences, syncFavoriteReminderIndex } from '../packages/core/favorites.js'

export function registerFavoriteRoutes(app, { store, env = {}, authenticate, getBoard }) {
  async function context(c) {
    const auth = await authenticate(c)
    const id = typeof auth === 'string' ? auth : auth?.id || auth?.userId
    const user = id ? await store.get(`user:${id}`, null) : null
    if (!user || user.disabled || user.blocked) throw new FavoriteError('unauthorized', '请先登录', 401)
    const site = await store.get('meta:site', {})
    const catalog = Array.isArray(site?.buildings) && site.buildings.length ? site.buildings : DORM_BUILDINGS
    const result = await getBoard({ userId: id, dormBuilding: user.dormBuilding })
    return { user: { ...user, id }, machines: scopedFavoriteMachines(result, user, catalog), catalog }
  }
  const wrap = (fn) => async (c) => {
    try { return c.json(await fn(c), 200, { 'Cache-Control': 'no-store' }) }
    catch (error) { return c.json({ error: { code: error instanceof FavoriteError ? error.code : error?.code === 'body_too_large' ? 'too_large' : 'unavailable', message: error instanceof FavoriteError ? error.message : error?.code === 'body_too_large' ? '设置内容过长' : '洗衣偏好暂不可用，请稍后再试' } }, error instanceof FavoriteError ? error.status : error?.code === 'body_too_large' ? 413 : 503) }
  }
  async function body(c) {
    try { return await readBoundedJson(c.req.raw, 8192) }
    catch (error) { if (error?.code === 'body_too_large') throw error; throw new FavoriteError('bad_param', '请求须为 JSON 对象') }
  }
  function currentVisible(raw, machines) {
    const preferences = visibleLaundryPreferences(raw)
    const allowed = new Set(machines.map((machine) => machine.id))
    return { ...preferences, favorites: preferences.favorites.filter((id) => allowed.has(id)) }
  }
  async function view(c) {
    const { user, machines } = await context(c)
    return { preferences: currentVisible(await store.get(laundryPreferencesKey(user.id), defaultLaundryPreferences()), machines), machines }
  }
  app.get('/api/user/laundry-preferences', wrap(view))
  app.get('/api/user/favorites', wrap(view))
  app.patch('/api/user/laundry-preferences', wrap(async (c) => {
    const patch = await body(c)
    const { user, machines, catalog } = await context(c)
    if (!normalizeDormBuilding(user.dormBuilding, catalog)) throw new FavoriteError('building_required', '请先绑定住宿楼', 409)
    return withOperationLock(store, `favorite-user:${user.id}`, async () => {
      const current = currentVisible(await store.get(laundryPreferencesKey(user.id), defaultLaundryPreferences()), machines)
      const preferences = validateLaundryPreferences(current, patch, machines)
      await store.put(laundryPreferencesKey(user.id), preferences)
      await syncFavoriteReminderIndex(store, user.id, preferences.enabled)
      return { preferences, machines }
    })
  }))
  app.post('/api/user/favorites/toggle', wrap(async (c) => {
    const patch = await body(c)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => key !== 'machineId') || typeof patch.machineId !== 'string') throw new FavoriteError('bad_param', '请选择有效机器')
    const { user, machines, catalog } = await context(c)
    if (!normalizeDormBuilding(user.dormBuilding, catalog)) throw new FavoriteError('building_required', '请先绑定住宿楼', 409)
    if (!machines.some((machine) => machine.id === patch.machineId)) throw new FavoriteError('machine_not_allowed', '只能收藏当前住宿楼中的机器')
    return withOperationLock(store, `favorite-user:${user.id}`, async () => {
      const current = currentVisible(await store.get(laundryPreferencesKey(user.id), defaultLaundryPreferences()), machines)
      const favorites = current.favorites.includes(patch.machineId) ? current.favorites.filter((id) => id !== patch.machineId) : [...current.favorites, patch.machineId]
      const preferences = validateLaundryPreferences(current, { favorites, ...(!favorites.length ? { enabled: false } : {}) }, machines)
      await store.put(laundryPreferencesKey(user.id), preferences)
      await syncFavoriteReminderIndex(store, user.id, preferences.enabled)
      return { preferences, machines }
    })
  }))
}
