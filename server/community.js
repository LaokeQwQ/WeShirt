import { json, apiErr } from '../packages/core/util.js'
import { normalizeAvatar, normalizeAvatarUrl } from '../packages/core/profile.js'
import { withOperationLock } from '../packages/core/operations.js'
import { getUserIdentity, canModerate } from '../packages/core/identity.js'
import { getSiteConfig } from './site.js'
import { resolveMachineDorm } from '../packages/core/buildings.js'

const MINUTE = 60000
const MUTES_KEY = 'moderation:mutes'
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const maskNick = (value) => Array.from(String(value || '同学'))[0] + '**'
const text = (value) => value.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim()
const array = (value) => Array.isArray(value) ? value : []
const fail = (code, message, status = 400) => { const error = new Error(message); Object.assign(error, { code, status }); throw error }

export function registerCommunityRoutes(app, { store, env = {}, authenticate, checkSuperAdmin, now = () => Date.now() }) {
  const bid = env.BUILDING_ID || 'b1'
  const respond = (value) => json(value, 200, { 'Cache-Control': 'no-store' })
  const wrap = (action) => async (c) => {
    try { return respond(await action(c)) }
    catch (error) { return apiErr(error.code || 'unavailable', error.status ? error.message : '留言暂不可用，请稍后再试', error.status || 503) }
  }
  async function body(c) {
    if (Number(c.req.header('content-length')) > 8192) fail('too_large', '请求内容过长', 413)
    const raw = await c.req.text()
    if (new TextEncoder().encode(raw).length > 8192) fail('too_large', '请求内容过长', 413)
    let value
    try { value = JSON.parse(raw) } catch { fail('bad_param', '请求须为 JSON 对象') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('bad_param', '请求须为 JSON 对象')
    return value
  }
  async function actor(c, required = false, moderator = false) {
    const authenticated = await authenticate?.(c)
    const uid = typeof authenticated === 'string' ? authenticated : authenticated?.id
    const found = uid ? await store.get('user:' + uid, null) : null
    const user = found?.disabled || found?.blocked ? null : found
    const identity = await checkSuperAdmin?.(c) ? { role: 'super', label: '总管', buildings: [] } : await getUserIdentity(store, user?.id)
    if (required && !user?.id) fail('unauthorized', '请先登录', 401)
    if (moderator && !canModerate(identity)) fail(user?.id ? 'forbidden' : 'unauthorized', '需要总管或管理员权限', user?.id ? 403 : 401)
    return { user, identity, moderator: canModerate(identity) }
  }
  async function context() {
    const [site, cached, mapping] = await Promise.all([getSiteConfig(store), store.get(`machines:${bid}`, null), store.get(`mapping:${bid}`, null)])
    const buildings = site.buildings.filter((building) => building.code !== 'public')
    const machines = (cached?.board?.floors || []).flatMap((floor) => floor.machines || []).map((machine) => ({ ...machine, id: String(machine.id), dormBuilding: resolveMachineDorm(machine, mapping?.mapping || {}, buildings) }))
    return { buildings, machines, byId: new Map(machines.map((machine) => [machine.id, machine])), codes: new Set(['public', ...buildings.map((building) => building.code)]) }
  }
  function messageChannel(message, ctx) {
    if (ctx.codes.has(message.channel)) return message.channel
    if (ctx.codes.has(message.dormBuilding)) return message.dormBuilding
    return ctx.byId.get(String(message.machineId))?.dormBuilding || ctx.buildings[0]?.code || 'guiyuan'
  }
  function selectChannel(channel, dorm, ctx) {
    if (channel != null && (typeof channel !== 'string' || !ctx.codes.has(channel))) fail('bad_param', '留言频道无效')
    if (dorm != null && dorm !== '' && (typeof dorm !== 'string' || !ctx.codes.has(dorm) || dorm === 'public')) fail('bad_param', '住宿楼无效')
    if (channel && dorm && channel !== dorm) fail('bad_param', '频道与住宿楼不一致')
    return channel || dorm || null
  }
  async function muteFor(uid) {
    if (!uid) return null
    const records = await store.get(MUTES_KEY, {})
    const entry = records && typeof records === 'object' && !Array.isArray(records) ? records[uid] : null
    if (!entry || entry.until !== null && (!Number.isFinite(Date.parse(entry.until)) || Date.parse(entry.until) <= now())) return null
    return entry
  }
  const publicMute = (entry) => entry ? { active: true, until: entry.until, reason: entry.reason || '' } : null
  async function metadata(requester) { return { permissions: { canModerate: requester.moderator }, mute: publicMute(await muteFor(requester.user?.id)) } }
  function canMuteTarget(requester, identity, targetId) {
    return requester.moderator && targetId !== requester.user?.id && identity.role !== 'super' && (requester.identity.role === 'super' || identity.role !== 'admin')
  }
  async function enrich(messages, all, ctx, requester) {
    const parents = messages.map((message) => all.find((entry) => !entry.deleted && entry.id === message.replyTo && messageChannel(entry, ctx) === messageChannel(message, ctx))).filter(Boolean)
    const ids = [...new Set([...messages, ...parents].map((message) => message.userId).filter(Boolean))]
    const authors = new Map(await Promise.all(ids.map(async (uid) => [uid, { user: await store.get('user:' + uid, null), identity: await getUserIdentity(store, uid) }])))
    function authorFields(message) {
      const current = authors.get(message.userId)
      const user = current?.user
      const identity = current?.identity || { role: 'user', label: '同学' }
      const building = ctx.buildings.find((entry) => entry.code === user?.dormBuilding)
      return { nick: maskNick(user?.nick || message.nick), avatar: normalizeAvatar(user?.avatar || message.avatar), avatarUrl: normalizeAvatarUrl(user?.avatarUrl), authorBuilding: building?.code || null, authorBuildingName: building?.name || '', identity: { role: identity.role, label: identity.label }, identityInternal: identity }
    }
    return messages.map((message) => {
      const fields = authorFields(message)
      const { identityInternal, ...publicAuthor } = fields
      const channel = messageChannel(message, ctx)
      const mine = Boolean(requester.user?.id && requester.user.id === message.userId)
      const parent = parents.find((entry) => entry.id === message.replyTo)
      const parentAuthor = parent && authorFields(parent)
      return { id: message.id, ...publicAuthor, text: message.text, at: message.at, channel, dormBuilding: channel === 'public' ? null : channel,
        machineId: message.machineId || null, machineName: ctx.byId.get(String(message.machineId))?.name || message.machineName || null,
        mine, pinned: message.pinned === true, pinnedAt: message.pinnedAt || null,
        permissions: { canDelete: mine || requester.moderator, canPin: requester.moderator && (identityInternal.role === 'volunteer' || message.pinned === true), canMute: Boolean(message.userId) && canMuteTarget(requester, identityInternal, message.userId) },
        ...(requester.moderator ? { authorId: message.userId || null } : {}), replyTo: message.replyTo || null,
        reply: parent ? { id: parent.id, nick: parentAuthor.nick, text: String(parent.text || '').slice(0, 80), identity: parentAuthor.identity, authorBuilding: parentAuthor.authorBuilding, authorBuildingName: parentAuthor.authorBuildingName } : null }
    })
  }

  app.get('/api/messages/channels', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c), context()])
    const current = ctx.buildings.find((building) => building.code === requester.user?.dormBuilding)
    return { channels: [{ code: 'public', name: '公共频道' }, ...(current ? [current] : []), ...ctx.buildings.filter((building) => building.code !== current?.code)], currentBuilding: current?.code || null, ...await metadata(requester) }
  }))
  app.get('/api/messages', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c), context()])
    const machineId = c.req.query('machineId') || ''
    let channel = selectChannel(c.req.query('channel'), c.req.query('dorm'), ctx)
    if (machineId && channel === 'public') fail('bad_param', '公共频道不关联机器')
    const machineChannel = ctx.byId.get(machineId)?.dormBuilding
    if (machineId && machineChannel && channel && channel !== machineChannel) fail('bad_param', '机器不在所选频道')
    if (!channel && machineId) channel = machineChannel || null
    const count = Number(c.req.query('limit') || 20), pageValue = Number(c.req.query('page') || 1)
    const limit = Number.isFinite(count) ? Math.min(50, Math.max(1, Math.floor(count))) : 20
    const page = Number.isFinite(pageValue) ? Math.min(100, Math.max(1, Math.floor(pageValue))) : 1
    const all = array(await store.get(`messages:${bid}`, []))
    const filtered = all.filter((message) => !message.deleted && (!channel || messageChannel(message, ctx) === channel) && (!machineId || String(message.machineId) === machineId))
      .map((message, order) => ({ message, order })).sort((a, b) => Number(b.message.pinned === true) - Number(a.message.pinned === true) || b.order - a.order).map(({ message }) => message)
    return { messages: await enrich(filtered.slice((page - 1) * limit, page * limit), all, ctx, requester), pagination: { page, limit, total: filtered.length, hasMore: page * limit < filtered.length }, channel, ...await metadata(requester) }
  }))
  app.post('/api/messages', wrap(async (c) => {
    const requester = await actor(c, true)
    const input = await body(c)
    if (typeof input.text !== 'string') fail('bad_param', '留言须为 1~200 字')
    const content = text(input.text)
    if (!content || Array.from(content).length > 200) fail('bad_param', '留言须为 1~200 字')
    if (input.machineId && !validId(input.machineId)) fail('bad_param', '机器 ID 无效')
    if (input.replyTo && !validId(input.replyTo)) fail('bad_param', '回复目标无效')
    return withOperationLock(store, 'community:moderation', async () => {
      if (await muteFor(requester.user.id)) fail('muted', '你当前被禁言，暂时不能留言或回复', 403)
      return withOperationLock(store, `messages:${bid}`, async () => {
        const ctx = await context()
        const selected = selectChannel(input.channel, input.dorm, ctx)
        if (selected === 'public' && input.machineId) fail('bad_param', '公共频道不关联机器')
        const machine = input.machineId ? ctx.byId.get(input.machineId) : null
        if (input.machineId && !machine) fail('not_found', '机器已下线，请刷新', 404)
        const list = array(await store.get(`messages:${bid}`, []))
        const parent = input.replyTo ? list.find((entry) => !entry.deleted && entry.id === input.replyTo) : null
        if (input.replyTo && !parent) fail('not_found', '回复的留言已不存在', 404)
        const channel = selected || machine?.dormBuilding || ctx.buildings.find((building) => building.code === requester.user.dormBuilding)?.code || ctx.buildings[0]?.code || 'guiyuan'
        if (machine && machine.dormBuilding !== channel) fail('bad_param', '机器不在所选频道')
        if (parent && messageChannel(parent, ctx) !== channel) fail('bad_param', '请在同一频道回复')
        const rateKey = `operations:messageRate:${requester.user.id}`
        const recent = array((await store.get(rateKey, null)) || list.filter((entry) => entry.userId === requester.user.id).map((entry) => Date.parse(entry.at))).filter((at) => Number.isFinite(at) && now() - at < MINUTE)
        if (recent.length >= 5 || recent.some((at) => now() - at < 10000)) fail('too_many', '留言太快，稍等一会儿再发', 429)
        const entry = { id: 'm_' + crypto.randomUUID(), userId: requester.user.id, nick: requester.user.nick, avatar: requester.user.avatar, text: content, at: new Date(now()).toISOString(), machineId: machine?.id || (channel !== 'public' ? parent?.machineId : null) || null, machineName: machine?.name || (channel !== 'public' ? parent?.machineName : null) || null, channel, dormBuilding: channel === 'public' ? null : channel, replyTo: parent?.id || null, pinned: false }
        const next = [...list, entry]
        // 置顶不因普通发帖被挤掉，整体最多300条。
        while (next.length > 300) { const index = next.findIndex((message) => !message.pinned); next.splice(index < 0 ? 0 : index, 1) }
        await store.put(`messages:${bid}`, next)
        await store.put(rateKey, [...recent, now()])
        return { ok: true, message: (await enrich([entry], next, ctx, requester))[0], id: entry.id }
      })
    })
  }))
  app.delete('/api/messages/:id', wrap(async (c) => {
    const requester = await actor(c)
    if (!requester.user?.id && !requester.moderator) fail('unauthorized', '删除留言需要先登录', 401)
    return withOperationLock(store, `messages:${bid}`, async () => {
      const list = array(await store.get(`messages:${bid}`, []))
      const entry = list.find((message) => message.id === c.req.param('id') && !message.deleted)
      if (!entry) fail('not_found', '留言已不存在', 404)
      if (entry.userId !== requester.user?.id && !requester.moderator) fail('forbidden', '只能删除自己的留言', 403)
      await store.put(`messages:${bid}`, list.filter((message) => message.id !== entry.id))
      return { ok: true }
    })
  }))
  const pin = wrap(async (c) => {
    const requester = await actor(c, false, true)
    const input = await body(c)
    if (typeof input.pinned !== 'boolean') fail('bad_param', '置顶状态须为布尔值')
    return withOperationLock(store, `messages:${bid}`, async () => {
      const list = array(await store.get(`messages:${bid}`, []))
      const entry = list.find((message) => message.id === c.req.param('id') && !message.deleted)
      if (!entry) fail('not_found', '留言已不存在', 404)
      const author = await getUserIdentity(store, entry.userId)
      // 离任或账号失效不应让既有置顶无法撤回；新置顶仍仅限当前志愿管理。
      if (author.role !== 'volunteer' && (input.pinned || entry.pinned !== true)) fail('forbidden', '仅可置顶宿管志愿者的留言', 403)
      const ctx = await context(), channel = messageChannel(entry, ctx)
      if (input.pinned && !entry.pinned && list.filter((message) => !message.deleted && message.pinned && messageChannel(message, ctx) === channel).length >= 5) fail('pin_limit', '每个频道最多置顶 5 条留言', 409)
      entry.pinned = input.pinned
      entry.pinnedAt = input.pinned ? entry.pinnedAt || new Date(now()).toISOString() : null
      await store.put(`messages:${bid}`, list)
      return { ok: true, message: (await enrich([entry], list, ctx, requester))[0] }
    })
  })
  app.post('/api/messages/:id/pin', pin)
  app.patch('/api/messages/:id/pin', pin)

  app.get('/api/moderation/mutes', wrap(async (c) => {
    await actor(c, false, true)
    const records = await store.get(MUTES_KEY, {})
    const rows = records && typeof records === 'object' && !Array.isArray(records) ? Object.values(records) : []
    const mutes = await Promise.all(rows.filter((entry) => entry && (entry.until === null || Date.parse(entry.until) > now())).slice(-500).map(async (entry) => {
      const user = await store.get('user:' + entry.userId, null)
      const identity = await getUserIdentity(store, entry.userId)
      return { userId: entry.userId, nick: maskNick(user?.nick), identity: { role: identity.role, label: identity.label }, reason: entry.reason, at: entry.at, until: entry.until }
    }))
    return { mutes }
  }))
  app.post('/api/moderation/mutes', wrap(async (c) => {
    const requester = await actor(c, false, true), input = await body(c)
    if (!validId(input.userId) || !Object.hasOwn(input, 'durationMinutes') || input.durationMinutes !== null && (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 525600)) fail('bad_param', '请选择用户及有效禁言时长')
    if (input.reason != null && typeof input.reason !== 'string') fail('bad_param', '禁言原因须为文字')
    const reason = text(input.reason || '')
    if (Array.from(reason).length > 200) fail('bad_param', '禁言原因最多 200 字')
    return withOperationLock(store, 'community:moderation', async () => {
      const target = await store.get('user:' + input.userId, null)
      if (!target) fail('not_found', '用户不存在', 404)
      if (!canMuteTarget(requester, await getUserIdentity(store, input.userId), input.userId)) fail('forbidden', '不能禁言自己、同级总管或更高权限成员', 403)
      const existing = await store.get(MUTES_KEY, {})
      const records = Object.assign(Object.create(null), existing && !Array.isArray(existing) ? existing : {})
      for (const [uid, entry] of Object.entries(records)) if (!entry || entry.until !== null && Date.parse(entry.until) <= now()) delete records[uid]
      if (!records[input.userId] && Object.keys(records).length >= 500) fail('mute_limit', '禁言记录已满，请先清理', 409)
      const mute = { userId: input.userId, at: new Date(now()).toISOString(), until: input.durationMinutes === null ? null : new Date(now() + input.durationMinutes * MINUTE).toISOString(), reason, byUserId: requester.user?.id || null, byRole: requester.identity.role }
      records[input.userId] = mute
      await store.put(MUTES_KEY, records)
      return { ok: true, mute: { userId: mute.userId, ...publicMute(mute) } }
    })
  }))
  app.delete('/api/moderation/mutes/:uid', wrap(async (c) => {
    const requester = await actor(c, false, true), uid = c.req.param('uid')
    if (!validId(uid)) fail('bad_param', '用户无效')
    return withOperationLock(store, 'community:moderation', async () => {
      if (!canMuteTarget(requester, await getUserIdentity(store, uid), uid)) fail('forbidden', '不能修改同级总管或更高权限成员的禁言', 403)
      const records = Object.assign(Object.create(null), await store.get(MUTES_KEY, {}))
      delete records[uid]
      await store.put(MUTES_KEY, records)
      return { ok: true }
    })
  }))
}
