import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocialService, CONTACT_TEMPLATES } from '../packages/core/social.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueTicket } from '../packages/core/auth.js'
import { registerSocialRoutes } from '../server/social.js'

const SECRET = 'social-test-secret-with-32-characters'
const ENV = { AUTH_SECRET: SECRET, BUILDING_ID: 'b1' }

async function fixture({ notify } = {}) {
  const store = createMemoryStore()
  const sent = []
  for (const id of ['a', 'b', 'c']) await store.put(`user:${id}`, { id, nick: `${id}同学`, dingUserId: `${id}-ding-private`, mobile: '13912345678' })
  const service = createSocialService({ store, env: ENV, notify: notify || (async (uid, notice) => { sent.push({ uid, notice }); return { ok: true } }) })
  return { store, service, sent }
}
async function friend(service, a = 'a', b = 'b') {
  const invite = await service.invite(a, 'friend')
  return service.acceptInvite(b, invite.ticket)
}
async function pending(service, store) {
  await store.put('occupancy:b1', { m1: { userId: 'b' } })
  return (await service.contact('a', { toUserId: 'b', template: 'forgot', machineId: 'm1' })).thread
}
async function ownTask(store, extra = {}) {
  const task = { id: 'task-a', machineId: 'm1', machineName: '旧设备名称', mode: 'machine', buildingId: 'b1', startAt: '2026-11-01T09:00:00Z', endAt: new Date(Date.now() + 20 * 60000).toISOString(), done: false, ...extra }
  await store.put('tasks:a', [task])
  await store.put('occupancy:b1', { m1: { userId: 'a', taskId: task.id, startAt: task.startAt, endAt: task.endAt } })
  return task
}

test('个人邀请不包含用户ID，公开预览仅脱敏昵称；确认双向添加且重复幂等', async () => {
  const { service, store } = await fixture()
  const result = await service.invite('a', 'friend')
  const payload = JSON.parse(Buffer.from(result.ticket.split('.')[0], 'base64url').toString())
  assert.equal(payload.type, 'social-invite')
  assert.equal(payload.userId, undefined)
  assert.equal(payload.ownerId, undefined)
  assert.equal(payload.uid, undefined)
  const preview = await service.preview(result.ticket)
  assert.deepEqual(Object.keys(preview).sort(), ['expiresAt', 'kind', 'nick'])
  assert.equal(preview.nick, 'a**')
  assert.ok(!JSON.stringify(preview).includes('13912345678'))
  await assert.rejects(service.acceptInvite('a', result.ticket), { code: 'self_invite' })
  assert.equal((await service.acceptInvite('b', result.ticket)).added, true)
  assert.equal((await service.acceptInvite('b', result.ticket)).added, false)
  assert.equal((await store.get('social:friends:a')).length, 1)
  assert.equal((await store.get('social:friends:b')).length, 1)
})

test('分享仅分享站点不自动加好友；拒绝篡改、过期、跨用途票据和缺少签名密钥', async () => {
  const { service, store } = await fixture()
  const share = await service.invite('a', 'share')
  assert.equal((await service.acceptInvite('b', share.ticket)).added, false)
  assert.deepEqual((await service.dashboard('b')).friends, [])
  await assert.rejects(service.preview(share.ticket + 'x'), { code: 'invalid_invite' })
  const expired = await issueTicket({ type: 'social-invite', inviteId: 'i_' + 'a'.repeat(32), kind: 'friend', exp: Date.now() - 1 }, SECRET)
  await assert.rejects(service.preview(expired), { code: 'invalid_invite' })
  const other = await issueTicket({ role: 'admin', exp: Date.now() + 60000 }, SECRET)
  await assert.rejects(service.preview(other), { code: 'invalid_invite' })
  const badService = createSocialService({ store, env: { AUTH_SECRET: 'short' } })
  await assert.rejects(badService.invite('a'), { code: 'not_configured' })
})

test('仅可联系好友或当前占用者，模板白名单严格，任意正文不进入请求或通知', async () => {
  const { service, store, sent } = await fixture()
  await assert.rejects(service.contact('a', { toUserId: 'b', template: 'forgot' }), { code: 'forbidden' })
  await store.put('occupancy:b1', { m1: { userId: 'b' } })
  await assert.rejects(service.contact('a', { toUserId: 'b', template: 'toString' }), { code: 'bad_param' })
  await assert.rejects(service.contact('a', { toUserId: 'b', template: 'forgot', machineId: 'wrong' }), { code: 'forbidden' })
  const result = await service.contact('a', { toUserId: 'b', template: 'forgot', text: 'arbitrary-private-text' })
  assert.equal(result.thread.state, 'pending')
  assert.equal(result.thread.peer.nick, 'b**')
  assert.equal(result.thread.requestText, CONTACT_TEMPLATES.forgot)
  assert.ok(!JSON.stringify(await store.get(`social:thread:${result.thread.id}`)).includes('arbitrary-private-text'))
  assert.ok(!JSON.stringify(sent).includes('arbitrary-private-text'))
  assert.ok(!JSON.stringify(result).includes('13912345678'))
})

test('待确认联系请求幂等；拒绝后24h持久冷却跨服务实例继续生效', async () => {
  const { service, store, sent } = await fixture()
  const thread = await pending(service, store)
  const again = await service.contact('a', { toUserId: 'b', template: 'taken_wrong' })
  assert.equal(again.thread.id, thread.id)
  assert.equal(sent.length, 1)
  await service.acceptThread('b', thread.id, 'reject')
  const otherInstance = createSocialService({ store, env: ENV })
  await assert.rejects(otherInstance.contact('a', { toUserId: 'b', template: 'misplaced' }), { code: 'rate_limited' })
  await assert.rejects(otherInstance.contact('b', { toUserId: 'a', template: 'forgot' }), { code: 'forbidden' })
})

test('陌生人不可读取/接受/发消息，发起人不能自行接受，对方确认后才可双向聊天', async () => {
  const { service, store } = await fixture()
  const thread = await pending(service, store)
  await assert.rejects(service.message('a', thread.id, 'hello'), { code: 'forbidden' })
  await assert.rejects(service.getThread('c', thread.id), { code: 'not_found' })
  await assert.rejects(service.acceptThread('c', thread.id), { code: 'not_found' })
  await assert.rejects(service.acceptThread('a', thread.id), { code: 'forbidden' })
  await service.acceptThread('b', thread.id)
  const own = await service.message('a', thread.id, '我的衣物是蓝色外套')
  assert.equal(own.message.sender, 'me')
  const view = await service.getThread('b', thread.id)
  assert.equal(view.thread.messages[0].sender, 'peer')
  assert.equal(view.thread.messages[0].text, '我的衣物是蓝色外套')
  assert.equal(view.thread.peer.nick, 'a同学')
  assert.ok(!JSON.stringify(view).includes('a-ding-private'))
  await service.message('b', thread.id, '我到现场看看')
})

test('聊天按长度/持久速率限制，保存最近100条，通知不转发消息正文', async () => {
  const { service, store, sent } = await fixture()
  const thread = await pending(service, store)
  await service.acceptThread('b', thread.id)
  await assert.rejects(service.message('a', thread.id, 'x'.repeat(501)), { code: 'bad_param' })
  await assert.rejects(service.message('a', thread.id, '\u0000'), { code: 'bad_param' })
  const raw = await store.get(`social:thread:${thread.id}`)
  raw.messages = Array.from({ length: 100 }, (_, i) => ({ id: `m-${i}`, userId: 'a', text: `old${i}`, at: new Date().toISOString() }))
  await store.put(`social:thread:${thread.id}`, raw)
  await service.message('a', thread.id, 'private-message-body')
  const view = await service.getThread('a', thread.id)
  assert.equal(view.thread.messages.length, 100)
  assert.equal(view.thread.messages[0].text, 'old1')
  assert.equal(view.thread.messages.at(-1).text, 'private-message-body')
  assert.ok(!JSON.stringify(sent).includes('private-message-body'))
  const other = createSocialService({ store, env: ENV })
  await assert.rejects(other.message('a', thread.id, 'too-fast'), { code: 'rate_limited' })
})

test('任一方屏蔽后停止聊天、再联系和代取邀请', async () => {
  const { service, store } = await fixture()
  await friend(service)
  const thread = await pending(service, store)
  await service.acceptThread('b', thread.id)
  await service.blockThread('b', thread.id)
  await assert.rejects(service.message('a', thread.id, 'hello'), { code: 'forbidden' })
  await assert.rejects(service.contact('a', { toUserId: 'b', template: 'forgot' }), { code: 'blocked' })
  await ownTask(store)
  await assert.rejects(service.requestPickup('a', { friendId: 'b', taskId: 'task-a' }), { code: 'blocked' })
})

test('代取只允许自己的未取任务和双向好友，不能重复请求或提前完成', async () => {
  const { service, store } = await fixture()
  await ownTask(store)
  await assert.rejects(service.requestPickup('a', { friendId: 'b', taskId: 'task-a' }), { code: 'forbidden' })
  await friend(service)
  await assert.rejects(service.requestPickup('b', { friendId: 'a', taskId: 'task-a' }), { code: 'bad_param' })
  const request = await service.requestPickup('a', { friendId: 'b', taskId: 'task-a' })
  await assert.rejects(service.requestPickup('a', { friendId: 'b', taskId: 'task-a' }), { code: 'pickup_pending' })
  await assert.rejects(service.respondPickup('b', request.request.id, 'complete'), { code: 'invalid_state' })
  await assert.rejects(service.respondPickup('a', request.request.id, 'accept'), { code: 'not_found' })
  await assert.rejects(service.respondPickup('c', request.request.id, 'accept'), { code: 'not_found' })
  await service.respondPickup('b', request.request.id, 'reject')
  assert.equal((await store.get('tasks:a'))[0].done, false)
})

test('代取双方获取最新机器状态与剩余时间，第三人看不到；完成只清精确任务占用', async () => {
  const { service, store } = await fixture()
  await friend(service)
  await ownTask(store)
  const request = await service.requestPickup('a', { friendId: 'b', taskId: 'task-a' })
  const finishAt = new Date(Date.now() + 5 * 60000).toISOString()
  await store.put('machines:b1', { board: { floors: [{ code: '1', machines: [{ id: 'm1', displayName: '桂园1号烘干机', kind: 'dryer', state: 'occupied', finishAt }] }] } })
  const received = (await service.pickups('b')).received[0]
  assert.equal(received.task.machineName, '桂园1号烘干机')
  assert.equal(received.task.endAt, finishAt)
  assert.equal(received.task.leftMin, 5)
  assert.deepEqual(await service.pickups('c'), { received: [], sent: [] })
  await service.respondPickup('b', request.request.id, 'accept')
  await service.respondPickup('b', request.request.id, 'complete')
  const task = (await store.get('tasks:a'))[0]
  assert.equal(task.done, true)
  assert.equal(task.pickedUpBy, 'b')
  assert.ok(task.takenAt)
  assert.deepEqual(await store.get('occupancy:b1'), {})
  assert.equal((await service.respondPickup('b', request.request.id, 'complete')).changed, false)
})

test('完成旧代取任务不清掉同一用户随后登记的新占用', async () => {
  const { service, store } = await fixture()
  await friend(service); await ownTask(store)
  const request = await service.requestPickup('a', { friendId: 'b', taskId: 'task-a' })
  await service.respondPickup('b', request.request.id, 'accept')
  await store.put('occupancy:b1', { m1: { userId: 'a', taskId: 'new-task', startAt: new Date().toISOString() } })
  await service.respondPickup('b', request.request.id, 'complete')
  assert.equal((await store.get('occupancy:b1')).m1.taskId, 'new-task')
})

test('并发重复邀请只产生一条请求，通知失败不丢站内记录', async () => {
  const { service, store } = await fixture({ notify: async () => { throw new Error('network') } })
  await store.put('occupancy:b1', { m1: { userId: 'b' } })
  const results = await Promise.all([1, 2].map(() => service.contact('a', { toUserId: 'b', template: 'forgot' })))
  assert.equal(results[0].thread.id, results[1].thread.id)
  assert.equal(results[0].notified, false)
  assert.equal((await service.dashboard('b')).requests.length, 1)
})

test('HTTP所有私有接口拒绝匿名，预览公开仅返回脱敏数据，异常输入有明确4xx', async () => {
  const { store } = await fixture()
  const routes = new Map()
  const app = { get(path, fn) { routes.set(`GET ${path}`, fn) }, post(path, fn) { routes.set(`POST ${path}`, fn) } }
  registerSocialRoutes(app, { store, env: ENV, authenticate: (c) => c.uid, notify: async () => ({ ok: true }) })
  function context(uid, data = {}, query = {}) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data)
    return { uid, req: { header: () => '', text: async () => raw, query: (key) => query[key], param: () => 'missing' }, json: (value, status = 200) => ({ value, status }) }
  }
  for (const [route, fn] of routes) {
    if (route === 'GET /api/social/invite') continue
    assert.equal((await fn(context(null))).status, 401, route)
  }
  const invite = await routes.get('POST /api/social/invite')(context('a', { kind: 'friend' }))
  assert.equal(invite.status, 200)
  const preview = await routes.get('GET /api/social/invite')(context(null, {}, { ticket: invite.value.ticket }))
  assert.equal(preview.status, 200)
  assert.equal(preview.value.nick, 'a**')
  assert.equal(preview.value.id, undefined)
  assert.equal((await routes.get('POST /api/social/contact')(context('a', '{bad'))).status, 400)
  assert.equal((await routes.get('POST /api/social/contact')(context('a', 'x'.repeat(9000)))).status, 413)
  assert.equal((await routes.get('POST /api/social/contact')(context('a', { toUserId: 'b', template: 'forgot' }))).status, 403)
})
