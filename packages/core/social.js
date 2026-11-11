import { issueTicket, verifyTicket } from './auth.js'

export const CONTACT_TEMPLATES = Object.freeze({
  forgot: '你好，机器里似乎还有你的衣物，方便时请来确认并取走。',
  misplaced: '你好，我的衣物可能放错了位置，想和你核对一下。',
  taken_wrong: '你好，衣物可能被误取了，想和你核对一下。',
  left_behind: '你好，现场发现了可能遗留的物品，方便时请来确认。',
})
const DAY = 24 * 60 * 60 * 1000
const LIMIT = 100
const memory = new WeakMap()

export class SocialError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new SocialError(code, message, status) }
const iso = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${[...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')}`
const array = (value) => Array.isArray(value) ? value : []
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
const mask = (nick) => `${[...String(nick || '同学')][0] || '同'}**`
const textLine = (value, max = 32) => [...String(value || '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('')

function stateFor(store) {
  let state = memory.get(store)
  if (!state) { state = { queue: Promise.resolve(), rates: new Map() }; memory.set(store, state) }
  return state
}

// 仅串行化当前运行实例中的社交写操作；持久冷却同时拦截跨实例重复请求。
function mutate(store, fn) {
  const state = stateFor(store)
  const work = state.queue.catch(() => {}).then(fn)
  state.queue = work.catch(() => {})
  return work
}

export function createSocialService({ store, env = {}, notify = async () => ({ ok: false }) }) {
  const building = env.BUILDING_ID || 'b1'
  const secret = String(env.AUTH_SECRET || '').trim()
  const read = async (key, fallback = null) => clone(await store.get(key, fallback))
  const friends = async (uid) => array(await read(`social:friends:${uid}`, []))
  const isFriend = async (a, b) => (await friends(a)).some((f) => f.userId === b) && (await friends(b)).some((f) => f.userId === a)
  const blockKey = (a, b) => `social:block:${a}:${b}`
  const blocked = async (a, b) => Boolean(await read(blockKey(a, b)) || await read(blockKey(b, a)))

  async function user(uid) {
    const value = uid && await read(`user:${uid}`)
    if (!value || value.transient) fail('user_unavailable', '账号暂不可用，请稍后重试', 404)
    return value
  }
  async function peer(uid, reveal = false) {
    const value = await read(`user:${uid}`)
    return { id: uid, nick: reveal ? textLine(value?.nick || '同学', 16) : mask(value?.nick), avatarUrl: reveal ? value?.avatarUrl || null : null }
  }
  async function appendIndex(key, value) {
    const values = array(await read(key, []))
    if (!values.includes(value)) values.push(value)
    await store.put(key, values.slice(-LIMIT))
  }
  function rate(uid, kind, max, windowMs) {
    const state = stateFor(store)
    const now = Date.now()
    if (state.rates.size > 1000) for (const [key, value] of state.rates) if (now >= value.until) state.rates.delete(key)
    const key = `${uid}:${kind}`
    const prev = state.rates.get(key)
    const rec = prev && now < prev.until ? prev : { count: 0, until: now + windowMs }
    if (++rec.count > max) fail('rate_limited', '操作有些频繁，请稍后再试', 429)
    state.rates.set(key, rec)
  }
  async function deliver(uid, notice) {
    let timer
    try {
      const result = await Promise.race([notify(uid, notice), new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false }), 5000) })])
      return Boolean(result?.ok || result === true)
    } catch { return false } finally { if (timer) clearTimeout(timer) }
  }
  function card(title, content) {
    return { title, text: `【等衣】${title}\n${content}\n打开「等衣」的「好友协作」查看。`, markdown: `### ${title}\n\n${content}\n\n打开「等衣」的「好友协作」查看。` }
  }
  async function getInvite(ticket) {
    if (secret.length < 16) fail('not_configured', '邀请暂不可用', 503)
    const payload = await verifyTicket(ticket, secret).catch(() => null)
    if (!payload || payload.type !== 'social-invite' || !['friend', 'share'].includes(payload.kind) || !/^i_[a-f0-9]{32}$/.test(payload.inviteId)) fail('invalid_invite', '邀请无效或已过期，请让对方重新分享', 400)
    const invite = await read(`social:invite:${payload.inviteId}`)
    if (!invite || invite.kind !== payload.kind || Date.now() > invite.exp) fail('invalid_invite', '邀请无效或已过期，请让对方重新分享', 400)
    return invite
  }
  async function invite(uid, kind = 'friend') {
    return mutate(store, async () => {
      await user(uid)
      rate(uid, 'invite', 10, 60000)
      if (!['friend', 'share'].includes(kind)) fail('bad_param', '请选择好友邀请或分享')
      if (secret.length < 16) fail('not_configured', '邀请暂不可用', 503)
      const inviteId = id('i')
      const exp = Date.now() + DAY
      await store.put(`social:invite:${inviteId}`, { id: inviteId, ownerId: uid, kind, exp })
      const key = `social:invites:${uid}`
      const previous = array(await read(key, []))
      const keep = [...previous, inviteId].slice(-5)
      for (const old of previous.filter((x) => !keep.includes(x))) await store.del(`social:invite:${old}`)
      await store.put(key, keep)
      return { ticket: await issueTicket({ type: 'social-invite', inviteId, kind, exp }, secret), expiresAt: new Date(exp).toISOString(), kind }
    })
  }
  async function preview(ticket) {
    const record = await getInvite(ticket)
    const owner = await user(record.ownerId)
    return { kind: record.kind, nick: mask(owner.nick), expiresAt: new Date(record.exp).toISOString() }
  }
  async function acceptInvite(uid, ticket) {
    return mutate(store, async () => {
      await user(uid)
      rate(uid, 'accept_invite', 20, 60000)
      const record = await getInvite(ticket)
      if (record.kind === 'share') return { ok: true, kind: 'share', added: false }
      if (record.ownerId === uid) fail('self_invite', '这是你自己的邀请，分享给朋友即可')
      await user(record.ownerId)
      if (await blocked(uid, record.ownerId)) fail('blocked', '暂时无法添加这位用户', 403)
      const own = await friends(uid)
      const theirs = await friends(record.ownerId)
      if (!own.some((f) => f.userId === record.ownerId) && own.length >= LIMIT || !theirs.some((f) => f.userId === uid) && theirs.length >= LIMIT) fail('friend_limit', '好友数量已达上限')
      const added = !own.some((f) => f.userId === record.ownerId) || !theirs.some((f) => f.userId === uid)
      const at = iso()
      if (!own.some((f) => f.userId === record.ownerId)) own.push({ userId: record.ownerId, at })
      if (!theirs.some((f) => f.userId === uid)) theirs.push({ userId: uid, at })
      await Promise.all([store.put(`social:friends:${uid}`, own), store.put(`social:friends:${record.ownerId}`, theirs)])
      return { ok: true, kind: 'friend', added, friend: await peer(record.ownerId, true) }
    })
  }
  async function loadThread(uid, threadId) {
    const thread = await read(`social:thread:${threadId}`)
    if (!thread || !array(thread.members).includes(uid)) fail('not_found', '会话不存在', 404)
    return thread
  }
  async function threadView(uid, thread, includeMessages = false) {
    const other = thread.members.find((x) => x !== uid)
    const reveal = thread.state === 'accepted' || await isFriend(uid, other)
    return { id: thread.id, state: thread.state, incoming: thread.recipientId === uid, peer: await peer(other, reveal), template: thread.template, requestText: CONTACT_TEMPLATES[thread.template], createdAt: thread.createdAt, updatedAt: thread.updatedAt, lastMessage: thread.state === 'accepted' ? array(thread.messages).at(-1)?.text || '' : '', ...(includeMessages ? { messages: array(thread.messages).map((m) => ({ id: m.id, sender: m.userId === uid ? 'me' : 'peer', text: m.text, at: m.at })) } : {}) }
  }
  async function contact(uid, { toUserId, template, machineId } = {}) {
    return mutate(store, async () => {
      await user(uid)
      rate(uid, 'contact', 10, 60000)
      if (!toUserId || toUserId === uid || !Object.hasOwn(CONTACT_TEMPLATES, template)) fail('bad_param', '请选择联系对象和提醒模板')
      await user(toUserId)
      if (await blocked(uid, toUserId)) fail('blocked', '暂时无法联系这位用户', 403)
      const friend = await isFriend(uid, toUserId)
      const occupancy = await read(`occupancy:${building}`, {})
      const holds = Object.entries(occupancy || {}).some(([mid, value]) => value?.userId === toUserId && (!machineId || String(mid) === String(machineId)))
      if (!friend && !holds) fail('forbidden', '只能联系好友或当前登记使用机器的人', 403)
      const pair = [uid, toUserId].sort().join(':')
      const existingId = await read(`social:pair:${pair}`)
      const existing = existingId && await read(`social:thread:${existingId}`)
      if (existing?.state === 'accepted') return { thread: await threadView(uid, existing), existing: true, notified: false }
      if (existing?.state === 'pending') return { thread: await threadView(uid, existing), existing: true, notified: false }
      const last = Number(await read(`social:contactcool:${pair}`, 0))
      if (last && Date.now() - last < DAY) fail('rate_limited', '24 小时内只发送一条待确认联系请求', 429)
      const thread = { id: id('c'), members: [uid, toUserId], recipientId: toUserId, state: 'pending', template, createdAt: iso(), updatedAt: iso(), messages: [] }
      await store.put(`social:thread:${thread.id}`, thread)
      await Promise.all([appendIndex(`social:threads:${uid}`, thread.id), appendIndex(`social:threads:${toUserId}`, thread.id), store.put(`social:pair:${pair}`, thread.id), store.put(`social:contactcool:${pair}`, Date.now())])
      const notified = await deliver(toUserId, {...card('收到一条衣物联系请求', `${CONTACT_TEMPLATES[template]}\n接受后才会开启双向聊天，也可以直接拒绝或屏蔽。`),nativeKind:'CHAT_MENTION',nativeEventKey:'social:contact:'+thread.id})
      return { thread: await threadView(uid, thread), notified }
    })
  }
  async function acceptThread(uid, threadId, action = 'accept') {
    return mutate(store, async () => {
      await user(uid)
      rate(uid, 'thread_action', 30, 60000)
      const thread = await loadThread(uid, threadId)
      if (thread.recipientId !== uid) fail('forbidden', '请等待对方确认', 403)
      if (!['accept', 'reject'].includes(action)) fail('bad_param', '无效操作')
      if (thread.state !== 'pending') return { thread: await threadView(uid, thread, true), changed: false }
      if (await blocked(...thread.members)) fail('blocked', '会话已屏蔽', 403)
      thread.state = action === 'accept' ? 'accepted' : 'rejected'
      thread.updatedAt = iso()
      await store.put(`social:thread:${thread.id}`, thread)
      return { thread: await threadView(uid, thread, true), changed: true }
    })
  }
  async function getThread(uid, threadId) {
    await user(uid)
    return { thread: await threadView(uid, await loadThread(uid, threadId), true) }
  }
  async function message(uid, threadId, rawText) {
    return mutate(store, async () => {
      await user(uid)
      rate(uid, 'message', 30, 60000)
      const thread = await loadThread(uid, threadId)
      const other = thread.members.find((x) => x !== uid)
      if (thread.state !== 'accepted' || await blocked(uid, other)) fail('forbidden', '对方接受请求后才可聊天，已屏蔽的会话不能发送消息', 403)
      if (typeof rawText !== 'string' || !rawText.trim() || [...rawText.trim()].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rawText)) fail('bad_param', '消息请填写 1–500 字')
      const last = await read(`social:messagecool:${uid}:${threadId}`, 0)
      if (last && Date.now() - last < 1000) fail('rate_limited', '发送太快了，稍等一秒', 429)
      const entry = { id: id('m'), userId: uid, text: rawText.trim(), at: iso() }
      thread.messages = [...array(thread.messages), entry].slice(-100)
      thread.updatedAt = entry.at
      await store.put(`social:thread:${thread.id}`, thread)
      await store.put(`social:messagecool:${uid}:${threadId}`, Date.now())
      // 钉钉仅提醒有新消息，不转发私聊正文；每会话 5 分钟至多一次。
      const notifyKey = `social:chatnotify:${other}:${threadId}`
      const lastNotice = Number(await read(notifyKey, 0))
      if (!lastNotice || Date.now() - lastNotice >= 5 * 60000) {
        const sent = await deliver(other, {...card('好友协作有新消息', '你的衣物联系会话收到新消息。'),nativeKind:'CHAT_MENTION',nativeEventKey:'social:message:'+entry.id})
        if (sent) await store.put(notifyKey, Date.now())
      }
      return { message: { id: entry.id, sender: 'me', text: entry.text, at: entry.at } }
    })
  }
  async function blockThread(uid, threadId) {
    return mutate(store, async () => {
      await user(uid)
      const thread = await loadThread(uid, threadId)
      const other = thread.members.find((x) => x !== uid)
      await store.put(blockKey(uid, other), { at: iso() })
      thread.state = 'blocked'; thread.updatedAt = iso()
      await store.put(`social:thread:${thread.id}`, thread)
      return { ok: true, thread: await threadView(uid, thread, true) }
    })
  }
  async function taskView(ownerId, taskId) {
    const tasks = array(await read(`tasks:${ownerId}`, []))
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return { id: taskId, unavailable: true }
    const entry = await read(`machines:${task.buildingId || building}`)
    const machine = array(entry?.board?.floors).flatMap((f) => array(f.machines)).find((m) => String(m.id) === String(task.machineId))
    const endAt = task.mode === 'machine' && machine?.finishAt ? machine.finishAt : task.endAt
    const finish = endAt ? new Date(endAt).getTime() : NaN
    return { id: task.id, machineId: task.machineId, machineName: machine?.displayName || task.machineLabel || machine?.name || task.machineName || '机器', kind: machine?.kind || task.kind || 'washer', floorCode: machine?.floorCode || task.floorCode || '', state: machine?.state || 'unknown', endAt, leftMin: Number.isFinite(finish) ? Math.max(0, Math.ceil((finish - Date.now()) / 60000)) : null, done: !!task.done, takenAt: task.takenAt || null }
  }
  async function pickupView(uid, request) {
    const other = request.ownerId === uid ? request.friendId : request.ownerId
    return { id: request.id, direction: request.ownerId === uid ? 'sent' : 'received', peer: await peer(other, true), state: request.state, createdAt: request.createdAt, updatedAt: request.updatedAt, task: await taskView(request.ownerId, request.taskId) }
  }
  async function requestPickup(uid, { friendId, taskId } = {}) {
    return mutate(store, async () => {
      await user(uid); rate(uid, 'pickup', 10, 60000)
      if (!friendId || !taskId || friendId === uid) fail('bad_param', '请选择好友和洗衣任务')
      if (!await isFriend(uid, friendId)) fail('forbidden', '只能请已添加的好友代取', 403)
      if (await blocked(uid, friendId)) fail('blocked', '暂时无法联系这位好友', 403)
      const tasks = array(await read(`tasks:${uid}`, []))
      const task = tasks.find((t) => t.id === taskId)
      if (!task || task.done || task.takenAt) fail('bad_param', '只能邀请好友代取自己未取的任务')
      const activeId = await read(`social:pickuptask:${uid}:${taskId}`)
      const active = activeId && await read(`social:pickup:${activeId}`)
      if (active && ['pending', 'accepted'].includes(active.state)) fail('pickup_pending', '这条任务已有代取请求，请等待对方处理', 409)
      const coolKey = `social:pickupcool:${uid}:${taskId}`
      const last = Number(await read(coolKey, 0))
      if (last && Date.now() - last < 60000) fail('rate_limited', '刚邀请过，请稍后重试', 429)
      const request = { id: id('p'), ownerId: uid, friendId, taskId, state: 'pending', createdAt: iso(), updatedAt: iso() }
      await store.put(`social:pickup:${request.id}`, request)
      await Promise.all([appendIndex(`social:pickups:${uid}`, request.id), appendIndex(`social:pickups:${friendId}`, request.id), store.put(`social:pickuptask:${uid}:${taskId}`, request.id), store.put(coolKey, Date.now())])
      const snapshot = await taskView(uid, taskId)
      const name = textLine(snapshot.machineName, 80)
      const notified = await deliver(friendId, {...card('好友请你帮忙取衣', `${name}\n请先查看机器剩余时间，确认方便后再接受；不方便可拒绝。`),type:'pickup',nativeEventKey:'social:pickup:'+request.id})
      return { request: await pickupView(uid, request), notified }
    })
  }
  async function pickups(uid) {
    await user(uid)
    const ids = array(await read(`social:pickups:${uid}`, []))
    const records = (await Promise.all(ids.map((value) => read(`social:pickup:${value}`)))).filter((r) => r && (r.ownerId === uid || r.friendId === uid)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const views = await Promise.all(records.map((record) => pickupView(uid, record)))
    return { received: views.filter((v) => v.direction === 'received'), sent: views.filter((v) => v.direction === 'sent') }
  }
  async function respondPickup(uid, pickupId, action) {
    return mutate(store, async () => {
      await user(uid); rate(uid, 'pickup_respond', 30, 60000)
      const request = await read(`social:pickup:${pickupId}`)
      if (!request || request.friendId !== uid) fail('not_found', '代取请求不存在', 404)
      if (!['accept', 'reject', 'complete'].includes(action)) fail('bad_param', '无效操作')
      if (request.state === 'completed' && action === 'complete') return { request: await pickupView(uid, request), changed: false }
      if (action === 'complete' ? request.state !== 'accepted' : request.state !== 'pending') fail('invalid_state', '代取请求状态已变更，请刷新后重试', 409)
      if (action !== 'reject' && await blocked(uid, request.ownerId)) fail('blocked', '暂时无法处理这位用户的请求', 403)
      if (action === 'complete') {
        const tasks = array(await read(`tasks:${request.ownerId}`, []))
        const task = tasks.find((t) => t.id === request.taskId)
        if (!task) fail('not_found', '对方的任务已删除', 404)
        if (task.done || task.takenAt) fail('task_taken', '对方已确认取衣，请刷新任务', 409)
        task.done = true; task.takenAt = iso(); task.pickedUpBy = uid
        await store.put(`tasks:${request.ownerId}`, tasks)
        const bid = task.buildingId || building
        const occupancy = await read(`occupancy:${bid}`, {})
        const current = occupancy?.[task.machineId]
        // 必须精确对应本次任务，绝不清除同一用户后来再次登记的衣物。
        if (current?.userId === request.ownerId && (current.taskId === task.id || !current.taskId && current.startAt && current.startAt === task.startAt && current.endAt === task.endAt)) {
          delete occupancy[task.machineId]
          await store.put(`occupancy:${bid}`, occupancy)
        }
      }
      request.state = { accept: 'accepted', reject: 'rejected', complete: 'completed' }[action]
      request.updatedAt = iso()
      await store.put(`social:pickup:${request.id}`, request)
      const title = { accept: '好友已接受代取', reject: '好友这次不方便代取', complete: '好友已确认代取完成' }[action]
      await deliver(request.ownerId, {...card(title, action === 'complete' ? '对应任务已标记已取，请和好友确认衣物交接。' : '打开代取请求可查看最新状态。'),type:'pickup',nativeEventKey:'social:pickup:'+request.id+':'+action})
      return { request: await pickupView(uid, request), changed: true }
    })
  }
  async function dashboard(uid) {
    await user(uid)
    const values = await friends(uid)
    const friendViews = await Promise.all(values.map(async (f) => ({ ...await peer(f.userId, true), since: f.at, blocked: await blocked(uid, f.userId) })))
    const ids = array(await read(`social:threads:${uid}`, []))
    const records = (await Promise.all(ids.map((value) => read(`social:thread:${value}`)))).filter((t) => array(t?.members).includes(uid)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const threads = await Promise.all(records.map((t) => threadView(uid, t)))
    return { friends: friendViews, threads, requests: threads.filter((t) => t.incoming && t.state === 'pending'), templates: CONTACT_TEMPLATES }
  }
  return { dashboard, invite, preview, acceptInvite, contact, acceptThread, getThread, message, blockThread, requestPickup, pickups, respondPickup }
}
