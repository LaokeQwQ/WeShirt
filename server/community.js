import { json, apiErr } from '../packages/core/util.js'
import { normalizeAvatar, normalizeAvatarUrl } from '../packages/core/profile.js'
import { withOperationLock } from '../packages/core/operations.js'
import { getUserIdentity, canModerate } from '../packages/core/identity.js'
import { getSiteConfig } from './site.js'
import { resolveMachineDorm } from '../packages/core/buildings.js'
import { getUserPermissions } from '../packages/core/permissions.js'
import { issueTicket, verifyTicket } from '../packages/core/auth.js'
import { enqueueCommunityNotices, ensureCommunityNoticeCapacity, readCommunityNotices, markCommunityNoticesRead, processCommunityNotices } from '../packages/core/community-notices.js'
import { createCommunityMedia, publicMedia } from './community-media.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'
import { registerCommunityReportRoutes } from './community-reports.js'
import { communitySnapshot } from './community-snapshot.js'
import { communityMessageDigest, readCommunityReadState, acknowledgeCommunityMessages } from '../packages/core/community-reads.js'

const MINUTE = 60000
const MUTES_KEY = 'moderation:mutes'
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const maskNick = (value) => Array.from(String(value || '同学'))[0] + '**'
const text = (value) => value.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim()
const array = (value) => Array.isArray(value) ? value : []
const permittedAt = (row, code, mode = 'operate') => !row || row[mode] === true && (row[mode + 'Buildings'] === null || row[mode + 'Buildings']?.includes(code))
const fail = (code, message, status = 400) => { const error = new Error(message); Object.assign(error, { code, status }); throw error }

export function registerCommunityRoutes(app, { store, env = {}, authenticate, checkSuperAdmin, notify, now = () => Date.now() }) {
  const bid = env.BUILDING_ID || 'b1'
  const mediaService = createCommunityMedia({ store, now })
  const revisionKey = (channel) => 'community:revision:' + channel
  const bump = (channel) => store.put(revisionKey(channel), crypto.randomUUID())
  const respond = (value) => json(value, 200, { 'Cache-Control': 'no-store' })
  const wrap = (action) => async (c) => {
    try {
      const result = await action(c)
      if (notify && c.req.method === 'POST' && c.req.path === '/api/messages') {
        try { c.executionCtx.waitUntil(processCommunityNotices({ store, env, notify, now: now() })) } catch { /* 无后台任务宿主由定时同步统一投递 */ }
      }
      return respond(result)
    }
    catch (error) { return apiErr(error.code || 'unavailable', error.status ? error.message : '留言暂不可用，请稍后再试', error.status || 503) }
  }
  async function body(c) {
    if (Number(c.req.header('content-length')) > 8192) fail('too_large', '请求内容过长', 413)
    const bytes = await readStreamBytes(c.req.raw.body, 8192)
    if (!bytes) fail('too_large', '请求内容过长', 413)
    const raw = new TextDecoder().decode(bytes)
    let value
    try { value = JSON.parse(raw) } catch { fail('bad_param', '请求须为 JSON 对象') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('bad_param', '请求须为 JSON 对象')
    return value
  }
  async function actor(c, required = false, moderator = false, freshRules = false) {
    const source = freshRules ? store : communitySnapshot(c, store).store
    const authenticated = await authenticate?.(c)
    const uid = typeof authenticated === 'string' ? authenticated : authenticated?.id
    const found = uid ? await source.get('user:' + uid, null) : null
    const user = found?.disabled || found?.blocked ? null : found
    const temporary=c.get('temporaryAdminAccess')
    const identity = temporary?.identity || (await checkSuperAdmin?.(c) ? { role: 'super', label: '总管', buildings: [] } : await getUserIdentity(source, user?.id))
    const site = !freshRules && c.get('communitySiteSnapshot') || await getSiteConfig(source)
    const rules = temporary?.permissions || (!freshRules && c.get('userAccess')?.permissions) || (user ? (await getUserPermissions(source, user, site.buildings)).permissions : undefined)
    const moderationRules = rules?.adminMessages
    const canManage = canModerate(identity) && (!moderationRules || moderationRules.operate && (moderationRules.operateBuildings === null || moderationRules.operateBuildings?.length > 0))
    if (required && !user?.id) fail('unauthorized', '请先登录', 401)
    if (moderator && !canManage) fail(user?.id ? 'forbidden' : 'unauthorized', '需要总管或管理员权限', user?.id ? 403 : 401)
    return { user, identity, moderator: canManage, rules }
  }
  async function context(c) {
    const source=c?communitySnapshot(c,store).store:store
    const [site, cached, mapping] = await Promise.all([c?.get('communitySiteSnapshot') || getSiteConfig(source), source.get(`machines:${bid}`, null), source.get(`mapping:${bid}`, null)])
    const buildings = site.buildings.filter((building) => building.code !== 'public' && building.enabled !== false)
    const historyCatalog = site.buildings.map((building) => ({ ...building, enabled: true }))
    const machines = (cached?.board?.floors || []).flatMap((floor) => floor.machines || []).map((machine) => ({ ...machine, id: String(machine.id), dormBuilding: resolveMachineDorm(machine, mapping?.mapping || {}, historyCatalog) }))
    return { buildings, machines, byId: new Map(machines.map((machine) => [machine.id, machine])), codes: new Set(['public', ...buildings.map((building) => building.code)]) }
  }
  function messageChannel(message, ctx) {
    if (typeof message.channel === 'string' && message.channel) return message.channel
    if (typeof message.dormBuilding === 'string' && message.dormBuilding) return message.dormBuilding
    return ctx.byId.get(String(message.machineId))?.dormBuilding || ctx.buildings[0]?.code || 'guiyuan'
  }
  function selectChannel(channel, dorm, ctx) {
    if (channel != null && (typeof channel !== 'string' || !ctx.codes.has(channel))) fail('bad_param', '留言频道无效')
    if (dorm != null && dorm !== '' && (typeof dorm !== 'string' || !ctx.codes.has(dorm) || dorm === 'public')) fail('bad_param', '住宿楼无效')
    if (channel && dorm && channel !== dorm) fail('bad_param', '频道与住宿楼不一致')
    return channel || dorm || null
  }
  function allowed(requester, channel, mode = 'view') {
    if (!requester.user?.id && !canModerate(requester.identity)) return mode === 'view' && channel === 'public'
    if (!permittedAt(requester.rules?.messages, channel, mode)) return false
    return ['super', 'admin'].includes(requester.identity.role) || channel === 'public' || channel === requester.user?.dormBuilding
  }
  function requireChannel(requester, channel, ctx, mode = 'view') {
    if (!ctx.codes.has(channel) || !allowed(requester, channel, mode)) fail('forbidden', '你没有此频道的访问权限，或该楼栋已停用', 403)
  }
  function channelManager(requester, channel) {
    if (!allowed(requester, channel, 'operate')) return false
    if (['super', 'admin'].includes(requester.identity.role)) return permittedAt(requester.rules?.adminMessages, channel)
    return requester.identity.role === 'volunteer' && (channel === 'public' || requester.identity.buildings?.includes(channel))
  }
  async function requesterForUser(user, snapshot = null) {
    const site = snapshot?.site || await getSiteConfig(store)
    const access = await getUserPermissions(snapshot?.store || store, user, site.buildings)
    return { user, identity: access.identity, rules: access.permissions }
  }
  async function recipientSnapshot(users = []) {
    const [site, roles] = await Promise.all([getSiteConfig(store), store.get('meta:siteAdmins', [])])
    const known = new Map(users.map((user) => ['user:' + user.id, user]))
    const snapshotStore = { get(key, fallback) { if (key === 'meta:siteAdmins') return Promise.resolve(roles); if (known.has(key)) return Promise.resolve(known.get(key)); return store.get(key, fallback) } }
    return { site, store: snapshotStore }
  }
  async function limitedMap(items, visit, concurrency = 6) {
    const result = new Array(items.length); let next = 0
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; result[index] = await visit(items[index]) } }))
    return result
  }
  async function mentionReference(uid, channel) {
    const key = `community:mention-ref:${channel}:${uid}`
    return withOperationLock(store, key, async () => {
      let ref = await store.get(key, null)
      if (!ref) { ref = 'mention_' + crypto.randomUUID(); await store.put('community:mention-target:' + ref, { uid, channel }); await store.put(key, ref) }
      return ref
    })
  }
  function cachedMentionReference(c,uid,channel) {
    if(!c)return mentionReference(uid,channel)
    const cache=communitySnapshot(c,store).references,key=channel+'|'+uid
    if(!cache.has(key))cache.set(key,mentionReference(uid,channel))
    return cache.get(key)
  }
  async function recipients(input, requester, channel) {
    if (input.mentionAll != null && typeof input.mentionAll !== 'boolean') fail('bad_param', '@全体状态无效')
    if (input.mentions != null && (!Array.isArray(input.mentions) || input.mentions.length > 5 || input.mentions.some((ref) => typeof ref !== 'string' || !/^mention_[a-f0-9-]{36}$/.test(ref)))) fail('bad_param', '每条最多@五位频道成员，请从成员列表选择')
    const targets = new Set()
    for (const ref of new Set(input.mentions || [])) {
      const target = await store.get('community:mention-target:' + ref, null)
      if (!target || target.channel !== channel) fail('forbidden', '不能跨频道@成员', 403)
      const user = await store.get('user:' + target.uid, null)
      if (!user || user.disabled || user.blocked || !allowed(await requesterForUser(user), channel)) fail('forbidden', '这位成员已无法访问该频道', 403)
      if (target.uid !== requester.user.id) targets.add(target.uid)
    }
    if (input.mentionAll) {
      if (!channelManager(requester, channel)) fail('forbidden', '仅管理员或获授权的宿管志愿者可@全体', 403)
      await mentionAllRate(requester, channel)
      const users = await store.list('user:')
      if (users.length > 500) fail('too_many', '频道成员较多，请联系总管安排通知', 429)
      const profiles = users.map((row) => row.value).filter((user) => user?.id && user.id !== requester.user.id && !user.disabled && !user.blocked)
      const snapshot = await recipientSnapshot(profiles)
      for (const uid of await limitedMap(profiles, async (user) => allowed(await requesterForUser(user, snapshot), channel) ? user.id : null)) if (uid) targets.add(uid)
    }
    return [...targets]
  }
  async function mentionAllRate(requester, channel, reserve = false) {
    const check = async () => {
      const limitKey = 'community:all-rate:' + channel, actorKey = 'community:all-user:' + requester.user.id
      const [last, daily] = await Promise.all([store.get(limitKey, null), store.get(actorKey, [])])
      const recent = array(daily).filter((at) => now() - at < 86400000)
      if (last != null && now() - last < 3600000 || recent.length >= 3) fail('too_many', '@全体每频道每小时一次、每人每天最多三次', 429)
      if (reserve) { await store.put(limitKey, now()); await store.put(actorKey, [...recent, now()]) }
    }
    // 预检不占额度；只有目标/正文/回复/附件/配额验证通过后才原子保留。
    return reserve ? withOperationLock(store, 'community:all-rate', check) : check()
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
  async function enrich(messages, all, ctx, requester, c) {
    const source=c?communitySnapshot(c,store).store:store, byId=new Map(all.filter(entry=>!entry.deleted).map(entry=>[entry.id,entry]))
    const parents = messages.map((message) => byId.get(message.replyTo)).filter((entry,index)=>entry&&messageChannel(entry,ctx)===messageChannel(messages[index],ctx))
    const ids = [...new Set([...messages, ...parents].map((message) => message.userId).filter(Boolean))]
    const authors = new Map(await limitedMap(ids,async uid=>[uid,{user:await source.get('user:'+uid,null),identity:await getUserIdentity(source,uid)}]))
    function authorFields(message) {
      const current = authors.get(message.userId)
      const user = current?.user
      const identity = current?.identity || { role: 'user', label: '同学' }
      const building = ctx.buildings.find((entry) => entry.code === user?.dormBuilding)
      return { nick: maskNick(user?.nick || message.nick), avatar: normalizeAvatar(user?.avatar || message.avatar), avatarUrl: normalizeAvatarUrl(user?.avatarUrl), authorBuilding: building?.code || null, authorBuildingName: building?.name || '', identity: { role: identity.role, label: identity.label }, identityInternal: identity }
    }
    return Promise.all(messages.map(async (message) => {
      const fields = authorFields(message)
      const { identityInternal, ...publicAuthor } = fields
      const channel = messageChannel(message, ctx)
      const mine = Boolean(requester.user?.id && requester.user.id === message.userId)
      const parent = parents.find((entry) => entry.id === message.replyTo)
      const parentAuthor = parent && authorFields(parent)
      return { id: message.id, ...publicAuthor, text: message.text, at: message.at, channel, dormBuilding: channel === 'public' ? null : channel,
        type: message.type === 'announcement' ? 'announcement' : 'message', media: message.media ? publicMedia(message.media) : null,
        mentionRef: requester.user?.id && message.userId ? await cachedMentionReference(c,message.userId,channel) : null,
        mentionAll: message.mentionAll === true, mentionedMe: Boolean(requester.user?.id && array(message.mentionUserIds).includes(requester.user.id)),
        machineId: message.machineId || null, machineName: ctx.byId.get(String(message.machineId))?.name || message.machineName || null,
        mine, pinned: message.pinned === true, pinnedAt: message.pinnedAt || null,
        permissions: { canDelete: mine ? permittedAt(requester.rules?.messages, channel) : requester.moderator && permittedAt(requester.rules?.adminMessages, channel), canPin: channelManager(requester, channel), canMute: Boolean(message.userId) && canMuteTarget(requester, identityInternal, message.userId) && permittedAt(requester.rules?.adminMessages, publicAuthor.authorBuilding) },
        ...(requester.moderator && permittedAt(requester.rules?.adminMessages, channel, 'view') ? { authorId: message.userId || null } : {}), replyTo: message.replyTo || null,
        reply: parent ? { id: parent.id, nick: parentAuthor.nick, text: String(parent.text || '').slice(0, 80), identity: parentAuthor.identity, authorBuilding: parentAuthor.authorBuilding, authorBuildingName: parentAuthor.authorBuildingName } : null }
    }))
  }

  registerCommunityReportRoutes(app, { store, bid, actor, context, messageChannel, requireChannel, now })

  app.get('/api/messages/channels', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c), context(c)]),source=communitySnapshot(c,store).store
    const current = ctx.buildings.find((building) => building.code === requester.user?.dormBuilding)
    const rows = [{ code: 'public', name: '公共频道' }, ...(current ? [current] : []), ...ctx.buildings.filter((building) => building.code !== current?.code)]
    const visible=rows.filter(channel=>allowed(requester,channel.code)),codes=new Set(visible.map(row=>row.code))
    const [all,seen]=await Promise.all([source.get(`messages:${bid}`,[]),requester.user?.id?readCommunityReadState(store,bid,requester.user.id):new Set()])
    const summaries=new Map(),unread=new Map()
    // Read the collection once. Neither pins nor timestamp collisions change
    // chronological insertion order, and unauthorized channels are never enriched.
    const readable=array(all).filter(message=>!message.deleted&&codes.has(messageChannel(message,ctx)))
    const digests=requester.user?.id?await limitedMap(readable,message=>communityMessageDigest(messageChannel(message,ctx),message.id),32):[]
    for(const [index,message] of readable.entries()){
      const channel=messageChannel(message,ctx)
      summaries.set(channel,message)
      if(requester.user?.id&&message.userId!==requester.user.id&&!seen.has(digests[index]))unread.set(channel,(unread.get(channel)||0)+1)
    }
    const profiles=new Map(await limitedMap([...new Set([...summaries.values()].map(row=>row.userId).filter(Boolean))],async uid=>[uid,await source.get('user:'+uid,null)]))
    const channels = await limitedMap(visible,async ({ code, name }) => {
      const message=summaries.get(code),media=message?.media?.kind
      const summary=message?{messageId:message.id,nick:maskNick(profiles.get(message.userId)?.nick||message.nick)+'同学',
        text:media==='image'?'[图片]':media==='video'?'[视频]':Array.from(text(String(message.text||''))).slice(0,80).join(''),
        kind:media==='image'?'image':media==='video'?'video':message.type==='announcement'?'announcement':'text',at:message.at||null}:null
      return {code,name,summary,unreadCount:unread.get(code)||0,avatarData:await source.get('community:avatar:'+code,null),
        permissions:{canAnnounce:channelManager(requester,code),canMentionAll:channelManager(requester,code),canManageAvatar:channelManager(requester,code)}}
    })
    return { channels, currentBuilding: current?.code || null, ...await metadata(requester) }
  }))
  app.post('/api/messages/read',wrap(async c=>{
    const input=await body(c)
    if(Object.keys(input).some(key=>!['channel','messageIds','throughMessageId'].includes(key))||typeof input.channel!=='string')fail('bad_param','请选择频道及实际显示的消息')
    if(input.messageIds!=null&&input.throughMessageId!=null)fail('bad_param','请只提交一种消息标识')
    const ids=input.messageIds??(input.throughMessageId!=null?[input.throughMessageId]:null)
    if(!Array.isArray(ids)||ids.length<1||ids.length>50||ids.some(id=>!validId(id)))fail('bad_param','每次可确认1至50条已显示消息')
    const uid=(await actor(c,true,false,true)).user.id
    let latest
    // Every retry checks current view rights, building enablement and message
    // existence again. Muted and read-only members may acknowledge what they see.
    const seen=await acknowledgeCommunityMessages({store,buildingId:bid,userId:uid,validate:async()=>{
      const [requester,ctx,all]=await Promise.all([actor(c,true,false,true),context(),store.get(`messages:${bid}`,[])])
      if(requester.user.id!==uid)fail('unauthorized','账号已变化，请重新打开频道',401)
      requireChannel(requester,input.channel,ctx)
      const messages=array(all),byId=new Map(messages.filter(row=>!row.deleted&&messageChannel(row,ctx)===input.channel).map(row=>[row.id,row]))
      if(ids.some(id=>!byId.has(id)))fail('not_found','消息已删除、已移出当前频道或不可见，请刷新后重试',404)
      latest={requester,ctx,messages}
      return {acknowledged:await limitedMap([...new Set(ids)],id=>communityMessageDigest(input.channel,id),32),retained:new Set(await limitedMap(messages.filter(row=>!row.deleted),row=>communityMessageDigest(messageChannel(row,ctx),row.id),32))}
    }})
    const unread=latest.messages.filter(message=>!message.deleted&&message.userId!==uid&&messageChannel(message,latest.ctx)===input.channel)
    const unreadCount=(await limitedMap(unread,message=>communityMessageDigest(input.channel,message.id),32)).filter(id=>!seen.has(id)).length
    const acknowledged=new Set(ids)
    await markCommunityNoticesRead(store,uid,entry=>entry.channel===input.channel&&acknowledged.has(entry.messageId),now())
    return {ok:true,channel:input.channel,unreadCount}
  }))
  app.get('/api/messages', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c), context(c)])
    const machineId = c.req.query('machineId') || ''
    let channel = selectChannel(c.req.query('channel'), c.req.query('dorm'), ctx)
    if (channel) requireChannel(requester, channel, ctx)
    if (machineId && channel === 'public') fail('bad_param', '公共频道不关联机器')
    const machineChannel = ctx.byId.get(machineId)?.dormBuilding
    if (machineId && machineChannel && channel && channel !== machineChannel) fail('bad_param', '机器不在所选频道')
    if (!channel && machineId) channel = machineChannel || null
    if (channel) requireChannel(requester, channel, ctx)
    const count = Number(c.req.query('limit') || 20), pageValue = Number(c.req.query('page') || 1)
    const limit = Number.isFinite(count) ? Math.min(50, Math.max(1, Math.floor(count))) : 20
    const page = Number.isFinite(pageValue) ? Math.min(100, Math.max(1, Math.floor(pageValue))) : 1
    const all = array(await communitySnapshot(c,store).store.get(`messages:${bid}`, []))
    const filtered = all.filter((message) => !message.deleted && ctx.codes.has(messageChannel(message, ctx)) && allowed(requester, messageChannel(message, ctx)) && (!channel || messageChannel(message, ctx) === channel) && (!machineId || String(message.machineId) === machineId))
      .map((message, order) => ({ message, order })).sort((a, b) => Number(b.message.pinned === true) - Number(a.message.pinned === true) || b.order - a.order).map(({ message }) => message)
    return { messages: await enrich(filtered.slice((page - 1) * limit, page * limit), all, ctx, requester,c), pagination: { page, limit, total: filtered.length, hasMore: page * limit < filtered.length }, channel, ...await metadata(requester) }
  }))
  app.get('/api/messages/participants', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c, true), context(c)]), channel = c.req.query('channel'),source=communitySnapshot(c,store).store
    requireChannel(requester, channel, ctx)
    const rows = array(await source.get(`messages:${bid}`, [])).filter((entry) => !entry.deleted && messageChannel(entry, ctx) === channel)
    const ids = [...new Set(rows.slice().reverse().map((entry) => entry.userId))].slice(0, 30)
    const site=c.get('communitySiteSnapshot')||await getSiteConfig(source),snapshot={site,store:source}
    const participants = (await limitedMap(ids,async uid=>{
      const user=await source.get('user:'+uid,null)
      if(!user||user.disabled||user.blocked)return null
      const member=await requesterForUser(user,snapshot)
      if(!allowed(member,channel))return null
      return {ref:await cachedMentionReference(c,uid,channel),nick:maskNick(user.nick),avatarUrl:normalizeAvatarUrl(user.avatarUrl),identity:{role:member.identity.role,label:member.identity.label}}
    })).filter(Boolean)
    return { participants, canMentionAll: channelManager(requester, channel) }
  }))
  app.post('/api/messages/media', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c, true), context()]), channel = c.req.query('channel')
    requireChannel(requester, channel, ctx, 'operate')
    if (await muteFor(requester.user.id)) fail('muted', '禁言期间不能上传附件', 403)
    return { media: await mediaService.upload(c.req.raw, requester.user.id, channel) }
  }))
  app.get('/api/messages/media/:id', async (c) => {
    try {
      const [requester, ctx] = await Promise.all([actor(c, true), context(c)])
      const entry = await mediaService.get(c.req.param('id'))
      if (!entry) fail('not_found', '附件不存在或已过期', 404)
      requireChannel(requester, entry.channel, ctx)
      const list = array(await store.get(`messages:${bid}`, []))
      if (entry.messageId ? !list.some((message) => !message.deleted && message.id === entry.messageId && message.media?.id === entry.id && messageChannel(message, ctx) === entry.channel) : entry.ownerId !== requester.user.id) fail('forbidden', '无法访问此附件', 403)
      const bytes = await mediaService.bytes(entry)
      const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return new Response(payload, { headers: { 'Content-Type': entry.mime, 'Content-Length': String(entry.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline; filename="attachment.' + (entry.kind === 'video' ? 'mp4' : entry.mime.split('/')[1]) + '"' } })
    } catch (error) { return apiErr(error.code || 'unavailable', error.status ? error.message : '附件暂不可用', error.status || 503) }
  })
  app.post('/api/messages/channels/:channel/avatar', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c, true), context()]), channel = c.req.param('channel')
    requireChannel(requester, channel, ctx, 'operate')
    if (c.req.query('channel') && c.req.query('channel') !== channel || !channelManager(requester, channel)) fail('forbidden', '需要此频道的管理权限', 403)
    const avatar = await mediaService.upload(c.req.raw, requester.user.id, channel, true)
    await store.put('community:avatar:' + channel, avatar.dataUrl); await bump(channel)
    return { ok: true, avatarData: avatar.dataUrl }
  }))
  app.get('/api/messages/notices', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c, true), context(c)])
    const rows = await readCommunityNotices(store, requester.user.id)
    const notices = rows.filter((entry) => ctx.codes.has(entry.channel) && allowed(requester, entry.channel)).map(({ id, messageId, channel, title, text, url, at, readAt }) => ({ id, messageId, channel, title, text, url, at, readAt }))
    return { notices, unread: notices.filter((entry) => !entry.readAt).length }
  }))
  app.post('/api/messages/notices/read', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c, true), context()]), input = await body(c)
    requireChannel(requester, input.channel, ctx)
    return { ok: true, count: await markCommunityNoticesRead(store, requester.user.id, (entry) => entry.channel === input.channel, now()) }
  }))
  app.post('/api/messages/notices/:id/read', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c, true), context()])
    const entry = (await readCommunityNotices(store, requester.user.id)).find((entry) => entry.id === c.req.param('id'))
    if (!entry) fail('not_found', '提醒不存在', 404)
    requireChannel(requester, entry.channel, ctx)
    await markCommunityNoticesRead(store, requester.user.id, (item) => item.id === entry.id, now())
    return { ok: true }
  }))
  const wsSecret = () => String(env.COMMUNITY_WS_GATEWAY_SECRET || '')
  async function wsClaim(c) {
    const token = /^Bearer (\S+)$/.exec(c.req.header('authorization') || '')?.[1]
    const claim = wsSecret().length >= 32 ? await verifyTicket(token, wsSecret()).catch(() => null) : null
    if (!claim || claim.role !== 'community_ws' || !validId(claim.uid) || !validId(claim.nonce) || typeof claim.channel !== 'string' || claim.exp <= now() || claim.exp - now() > 120000) fail('unauthorized', '连接凭证已失效，请重新连接', 401)
    const connection = c.req.header('X-Community-WS-Connection')
    if (!/^[a-f0-9]{24}$/.test(connection || '')) fail('bad_param', '连接标识无效')
    return { claim, connection }
  }
  app.get('/api/messages/realtime', wrap(async (c) => {
    const [requester, ctx] = await Promise.all([actor(c, true), context(c)]), channel = c.req.query('channel')
    requireChannel(requester, channel, ctx)
    let url
    try { url = new URL(env.COMMUNITY_WS_GATEWAY_URL); if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || wsSecret().length < 32) throw new Error() } catch { return { enabled: false, fallbackIntervalMs: 45000 } }
    const expiresAt = now() + 120000
    const ticket = await issueTicket({ role: 'community_ws', uid: requester.user.id, channel, exp: expiresAt, nonce: 'rt_' + crypto.randomUUID() }, wsSecret())
    return { enabled: true, url: url.href, protocol: 'weshirt.channel.v1', ticket, expiresAt }
  }))
  app.get('/api/messages/realtime/state', wrap(async (c) => {
    const { claim, connection } = await wsClaim(c)
    const user = await store.get('user:' + claim.uid, null)
    if (!user || user.disabled || user.blocked) fail('forbidden', '当前账号无法连接频道', 403)
    const requester = await requesterForUser(user), site = await getSiteConfig(store)
    const codes = new Set(['public', ...site.buildings.filter((building) => building.enabled !== false).map((building) => building.code)])
    if (!codes.has(claim.channel) || !allowed(requester, claim.channel)) fail('forbidden', '频道访问权限已变化', 403)
    await withOperationLock(store, 'community:ws-lease:' + user.id, async () => {
      const key = 'community:ws-lease:' + user.id, leases = array(await store.get(key, [])).filter((entry) => entry.expiresAt > now())
      const current = leases.find((entry) => entry.connection === connection && entry.nonce === claim.nonce)
      if (current?.closed) fail('unauthorized', '此连接已关闭，请重新连接', 401)
      if ((current && now() - current.lastAt < 3000) || (!current && (leases.filter((entry) => !entry.closed).length >= 2 || leases.length >= 64))) fail('too_many', '连接过多或刷新太快，请稍后重连', 429)
      if (current) current.lastAt = now(); else leases.push({ nonce: claim.nonce, connection, expiresAt: claim.exp, lastAt: now() })
      await store.put(key, leases)
    })
    const notices = await readCommunityNotices(store, user.id)
    return { channel: claim.channel, revision: await store.get(revisionKey(claim.channel), '0'), inboxCount: notices.filter((entry) => !entry.readAt && codes.has(entry.channel) && allowed(requester, entry.channel)).length }
  }))
  app.post('/api/messages/realtime/release', wrap(async (c) => {
    const { claim, connection } = await wsClaim(c)
    await withOperationLock(store, 'community:ws-lease:' + claim.uid, async () => {
      const key = 'community:ws-lease:' + claim.uid
      const leases = array(await store.get(key, [])).filter((entry) => entry.expiresAt > now())
      const current = leases.find((entry) => entry.nonce === claim.nonce && entry.connection === connection)
      if (current) current.closed = true
      else if (leases.length < 64) leases.push({ nonce: claim.nonce, connection, expiresAt: claim.exp, closed: true })
      await store.put(key, leases)
    })
    return { ok: true }
  }))
  app.post('/api/messages', wrap(async (c) => {
    let requester = await actor(c, true)
    const input = await body(c)
    if (input.text != null && typeof input.text !== 'string') fail('bad_param', '留言须为文字')
    const content = text(input.text || '')
    if ((!content && !input.mediaId) || Array.from(content).length > 200) fail('bad_param', '请输入最多200字或选择一个附件')
    if (input.mediaId && !/^media_[a-f0-9-]{36}$/.test(input.mediaId)) fail('bad_param', '附件无效')
    if (input.type != null && !['message', 'announcement'].includes(input.type)) fail('bad_param', '消息类型无效')
    if (input.pinned != null && typeof input.pinned !== 'boolean') fail('bad_param', '置顶状态须为布尔值')
    if (input.pinned && input.type !== 'announcement') fail('bad_param', '普通消息请使用置顶入口')
    if (input.machineId && !validId(input.machineId)) fail('bad_param', '机器 ID 无效')
    if (input.replyTo && !validId(input.replyTo)) fail('bad_param', '回复目标无效')
    if (await muteFor(requester.user.id)) fail('muted', '你当前被禁言，暂时不能留言或回复', 403)
    const initialContext = await context()
    const initialChannel = selectChannel(input.channel, input.dorm, initialContext) || initialContext.byId.get(input.machineId)?.dormBuilding || initialContext.buildings.find((building) => building.code === requester.user.dormBuilding)?.code || initialContext.buildings[0]?.code || 'guiyuan'
    requireChannel(requester, initialChannel, initialContext, 'operate')
    const targets = await recipients(input, requester, initialChannel)
    requester = await actor(c, true, false, true)
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
        requireChannel(requester, channel, ctx, 'operate')
        if (channel !== initialChannel) fail('conflict', '频道配置已变化，请重新发送', 409)
        if (input.mentionAll && !channelManager(requester, channel)) fail('forbidden', '频道管理权限已变化，请重新发送', 403)
        if (input.type === 'announcement' && !channelManager(requester, channel)) fail('forbidden', '仅管理员或获授权宿管可发布频道公告', 403)
        const pinned = input.type === 'announcement' && input.pinned !== false
        if (pinned && list.filter((message) => !message.deleted && message.pinned && messageChannel(message, ctx) === channel).length >= 5) fail('pin_limit', '每个频道最多置顶 5 条留言', 409)
        if (machine && machine.dormBuilding !== channel) fail('bad_param', '机器不在所选频道')
        if (parent && messageChannel(parent, ctx) !== channel) fail('bad_param', '请在同一频道回复')
        const rateKey = `operations:messageRate:${requester.user.id}`
        const recent = array((await store.get(rateKey, null)) || list.filter((entry) => entry.userId === requester.user.id).map((entry) => Date.parse(entry.at))).filter((at) => Number.isFinite(at) && now() - at < MINUTE)
        if (recent.length >= 30 || recent.some((at) => now() - at < 2000)) fail('too_many', '发送较快，请稍等两秒再发；每分钟最多30条', 429)
        await ensureCommunityNoticeCapacity(store, targets)
        const attachment = input.mediaId ? await mediaService.get(input.mediaId) : null
        if (input.mediaId && (!attachment || attachment.ownerId !== requester.user.id || attachment.channel !== channel || attachment.messageId || attachment.expiresAt <= now())) fail('bad_media', '附件已失效、已被使用或不属于当前频道', 403)
        if (input.mentionAll) await mentionAllRate(requester, channel, true)
        const entry = { id: 'm_' + crypto.randomUUID(), userId: requester.user.id, nick: requester.user.nick, avatar: requester.user.avatar, text: content, at: new Date(now()).toISOString(), machineId: machine?.id || (channel !== 'public' ? parent?.machineId : null) || null, machineName: machine?.name || (channel !== 'public' ? parent?.machineName : null) || null, channel, dormBuilding: channel === 'public' ? null : channel, replyTo: parent?.id || null,
          type: input.type === 'announcement' ? 'announcement' : 'message', pinned, pinnedAt: pinned ? new Date(now()).toISOString() : null, mentionUserIds: targets, mentionAll: input.mentionAll === true }
        if (input.mediaId) entry.media = await mediaService.link(attachment, requester.user.id, channel, entry.id)
        const next = [...list, entry]
        // 置顶不因普通发帖被挤掉，整体最多300条。
        while (next.length > 300) { const index = next.findIndex((message) => !message.pinned); const [removed] = next.splice(index < 0 ? 0 : index, 1); if (removed.media?.id) await mediaService.remove(removed.media.id) }
        await store.put(`messages:${bid}`, next)
        await store.put(rateKey, [...recent, now()])
        await bump(channel)
        const channelName = channel === 'public' ? '公共频道' : ctx.buildings.find((building) => building.code === channel)?.name || '楼栋频道'
        await enqueueCommunityNotices(store, targets, { messageId: entry.id, channel, title: '有人@你', text: `${maskNick(requester.user.nick)}在${channelName}提到了你。打开频道查看消息。`, url: '/#/board?channel=' + encodeURIComponent(channel) + '&message=' + encodeURIComponent(entry.id) }, now())
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
      const ctx = await context(), channel = messageChannel(entry, ctx)
      requireChannel(requester, channel, ctx, 'operate')
      if (entry.userId !== requester.user?.id && !requester.moderator) fail('forbidden', '只能删除自己的留言', 403)
      await store.put(`messages:${bid}`, list.filter((message) => message.id !== entry.id))
      if (entry.media?.id) await mediaService.remove(entry.media.id)
      await bump(channel)
      return { ok: true }
    })
  }))
  const pin = wrap(async (c) => {
    const requester = await actor(c)
    if (!requester.user?.id && !requester.moderator) fail('unauthorized', '置顶需要先登录', 401)
    const input = await body(c)
    if (typeof input.pinned !== 'boolean') fail('bad_param', '置顶状态须为布尔值')
    return withOperationLock(store, `messages:${bid}`, async () => {
      const list = array(await store.get(`messages:${bid}`, []))
      const entry = list.find((message) => message.id === c.req.param('id') && !message.deleted)
      if (!entry) fail('not_found', '留言已不存在', 404)
      const ctx = await context(), channel = messageChannel(entry, ctx)
      requireChannel(requester, channel, ctx, 'operate')
      if (!channelManager(requester, channel)) fail('forbidden', '需要频道管理权限', 403)
      if (input.pinned && !entry.pinned && list.filter((message) => !message.deleted && message.pinned && messageChannel(message, ctx) === channel).length >= 5) fail('pin_limit', '每个频道最多置顶 5 条留言', 409)
      entry.pinned = input.pinned
      entry.pinnedAt = input.pinned ? entry.pinnedAt || new Date(now()).toISOString() : null
      await store.put(`messages:${bid}`, list)
      await bump(channel)
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
