import { json, apiErr } from '../packages/core/util.js'
import { normalizeAvatar } from '../packages/core/profile.js'
import { normalizeDormBuilding, resolveMachineDorm } from '../packages/core/buildings.js'
import { DEFAULT_OPERATIONS_CONFIG, normalizeOperationsConfig, buildQueueSchedule, applyMachineHealth, withOperationLock } from '../packages/core/operations.js'
import { getSiteConfig } from './site.js'
import { registerCommunityRoutes } from './community.js'

const maskNick = (value) => String(value || '同学').slice(0, 1) + '**'
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)

export function registerOperationsRoutes(app, { store, env = {}, authenticate, checkAdmin, checkSuperAdmin, now = () => Date.now() }) {
  const bid = env.BUILDING_ID || 'b1'
  const resolveUser = async (c) => {
    const value = await authenticate?.(c)
    return typeof value === 'string' ? store.get('user:' + value, null) : value
  }
  const ensureUser = async (c) => {
    const user = await resolveUser(c)
    return user?.id ? user : null
  }
  const readBody = async (c) => {
    const length = Number(c.req.header('content-length'))
    if (length > 4096) return null
    const text = await c.req.text()
    if (text.length > 4096) return null
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null }
  }
  const context = async () => {
    const [entry, mapping, health, site] = await Promise.all([store.get(`machines:${bid}`, null), store.get(`mapping:${bid}`, null), store.get(`operations:health:${bid}`, {}), getSiteConfig(store)])
    const slotMap = mapping?.mapping || {}
    const board = entry?.board ? applyMachineHealth(entry.board, health, now()) : null
    const machines = (board?.floors || []).flatMap((f) => f.machines || []).map((m) => {
      const slots = Object.entries(slotMap).filter(([, id]) => id != null && String(id) === String(m.id)).map(([slot]) => slot)
      const kind = slots.some((s) => /^D/i.test(s)) ? 'dryer' : slots.some((s) => /^\d+$/.test(s)) ? 'washer'
        : ['washer', 'dryer'].includes(m.kind) ? m.kind : String(m.name || '').includes('烘干') ? 'dryer' : 'washer'
      return { ...m, id: String(m.id), kind, dormBuilding: resolveMachineDorm(m, slotMap, site.buildings) }
    })
    return { board, machines, slotMap, buildings: site.buildings }
  }
  const dormFilter = async (value) => !value || Boolean(normalizeDormBuilding(value, (await getSiteConfig(store)).buildings))
  const queuePublic = (entry, user) => ({ id: entry.id, machineId: entry.machineId, nick: maskNick(entry.nick), avatar: normalizeAvatar(entry.avatar), at: entry.at, position: entry.position,
    mine: Boolean(user?.id && entry.userId === user.id), durationMin: entry.durationMin, startAt: entry.startAt, eta: entry.eta, endAt: entry.endAt, waitMin: entry.waitMin, estimated: true, uncertain: entry.uncertain })
  const scheduled = async (user, filter = {}) => {
    const { machines } = await context()
    const list = (await store.get(`queue:${bid}`, [])) || []
    const byId = new Map(machines.map((m) => [m.id, m]))
    return buildQueueSchedule(list, machines, now()).filter((q) => (!filter.machineId || String(q.machineId) === filter.machineId) && (!filter.dorm || byId.get(String(q.machineId))?.dormBuilding === filter.dorm)).map((q) => queuePublic(q, user))
  }

  app.get('/api/queue', async (c) => {
    const dorm = c.req.query('dorm') || ''
    if (!(await dormFilter(dorm))) return apiErr('bad_param', '住宿楼无效')
    const user = await resolveUser(c)
    return json({ queue: await scheduled(user, { machineId: c.req.query('machineId') || '', dorm }), updatedAt: new Date(now()).toISOString() })
  })

  app.post('/api/queue', async (c) => {
    const user = await ensureUser(c)
    if (!user) return apiErr('unauthorized', '排队需要先登录', 401)
    const body = await readBody(c)
    if (!body || !validId(body.machineId) || !(await dormFilter(body.dorm))) return apiErr('bad_param', '请选择有效机器和住宿楼')
    return withOperationLock(store, `queue:${bid}`, async () => {
      const { machines } = await context()
      const machine = machines.find((m) => m.id === body.machineId && (!body.dorm || body.dorm === m.dormBuilding))
      if (!machine) return apiErr('not_found', '未找到这台机器，请刷新看板', 404)
      if (machine.health?.confirmedFault) return apiErr('unavailable', '设备故障已确认，暂不能预约', 409)
      const list = (await store.get(`queue:${bid}`, [])) || []
      if (list.some((q) => q.userId === user.id)) return apiErr('already_queued', '你已在队列中，请先取消当前预约', 409)
      if (list.length >= 500) return apiErr('queue_full', '预约队列已满，请稍后再试', 409)
      const durationMin = body.durationMin == null ? (machine.kind === 'dryer' ? 60 : 30) : Number(body.durationMin)
      if (!(machine.kind === 'dryer' ? Number.isInteger(durationMin) && durationMin >= 10 && durationMin <= 180 && durationMin % 10 === 0 : [30, 42, 50, 70].includes(durationMin))) return apiErr('bad_param', '预约时长无效')
      const rate = `operations:queueRate:${user.id}`
      if (Number(await store.get(rate, 0)) > now() - 5000) return apiErr('too_many', '操作太快，请稍等几秒', 429)
      const entry = { id: 'q_' + crypto.randomUUID(), userId: user.id, machineId: machine.id, nick: user.nick, avatar: user.avatar, at: new Date(now()).toISOString(), durationMin, dormBuilding: machine.dormBuilding }
      list.push(entry)
      await store.put(`queue:${bid}`, list)
      await store.put(rate, now())
      const queue = await scheduled(user, { machineId: machine.id })
      return json({ entry: queue.find((q) => q.id === entry.id), queue })
    })
  })

  app.delete('/api/queue', async (c) => {
    const user = await ensureUser(c)
    if (!user) return apiErr('unauthorized', '取消排队需要先登录', 401)
    return withOperationLock(store, `queue:${bid}`, async () => {
      const list = (await store.get(`queue:${bid}`, [])) || []
      const machineId = c.req.query('machineId') || ''
      const next = list.filter((q) => !(q.userId === user.id && (!machineId || String(q.machineId) === machineId)))
      await store.put(`queue:${bid}`, next)
      return json({ ok: true, removed: list.length - next.length, queue: await scheduled(user, { machineId }) })
    })
  })

  registerCommunityRoutes(app, { store, env, authenticate, checkSuperAdmin, now })

  app.get('/api/admin/operations', async (c) => {
    if (!await checkAdmin?.(c)) return apiErr('unauthorized', '需要管理员登录', 401)
    const [config, alerts] = await Promise.all([store.get('operations:config', DEFAULT_OPERATIONS_CONFIG), store.get('operations:alerts', [])])
    return json({ config: normalizeOperationsConfig(config), alerts })
  })
  app.patch('/api/admin/operations', async (c) => {
    if (!await checkAdmin?.(c)) return apiErr('unauthorized', '需要管理员登录', 401)
    const body = await readBody(c)
    if (!body) return apiErr('bad_param', '需要有效配置')
    return withOperationLock(store, 'config', async () => {
      const current = (await store.get('operations:config', DEFAULT_OPERATIONS_CONFIG)) || DEFAULT_OPERATIONS_CONFIG
      let config
      try { config = normalizeOperationsConfig({ broadcast: { ...current.broadcast, ...body.broadcast } }) }
      catch (e) { return apiErr('bad_param', e.message) }
      await store.put('operations:config', config)
      return json({ ok: true, config })
    })
  })
  app.patch('/api/admin/operations/alerts/:id', async (c) => {
    if (!await checkAdmin?.(c)) return apiErr('unauthorized', '需要管理员登录', 401)
    const body = await readBody(c)
    if (!body || (!['read', 'resolved'].some((key) => typeof body[key] === 'boolean'))) return apiErr('bad_param', '需要已读或解决状态')
    return withOperationLock(store, 'alerts', async () => {
      const list = (await store.get('operations:alerts', [])) || []
      const entry = list.find((a) => a.id === c.req.param('id'))
      if (!entry) return apiErr('not_found', '告警不存在', 404)
      if (typeof body.read === 'boolean') entry.readAt = body.read ? new Date(now()).toISOString() : null
      if (typeof body.resolved === 'boolean') { entry.resolvedAt = body.resolved ? new Date(now()).toISOString() : null; if (body.resolved) entry.readAt ||= new Date(now()).toISOString() }
      await store.put('operations:alerts', list)
      return json({ ok: true, alert: entry })
    })
  })
}

