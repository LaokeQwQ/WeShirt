import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMemoryStore } from '../packages/core/store.js'
import { registerOperationsRoutes } from '../server/operations.js'
import { createApp } from '../server/app.js'
import { issueToken } from '../packages/core/auth.js'

const AT = Date.parse('2026-11-11T00:00:00Z')
async function fixture() {
  const store = createMemoryStore()
  let clock = AT
  for (const [id, dormBuilding] of [['a', 'guiyuan'], ['b', 'liuyuan'], ['admin', 'guiyuan'], ['super', 'guiyuan'], ['operator', 'guiyuan'], ['volunteer', 'guiyuan']]) await store.put('user:' + id, { id, nick: id + '同学', dormBuilding, provider: 'dingtalk', avatar: 'av1' })
  await store.put('meta:siteAdmins', [{ userId: 'admin', role: 'admin' }, { userId: 'super', role: 'super' }, { userId: 'operator', role: 'operator' }, { userId: 'volunteer', role: 'volunteer', buildings: ['guiyuan'] }])
  await store.put('machines:b1', { board: { updatedAt: new Date(clock).toISOString(), floors: [{ code: '1', machines: [{ id: 'g1', name: '桂园洗衣机', dormBuilding: 'guiyuan', state: 'idle' }, { id: 'l1', name: '柳园洗衣机', dormBuilding: 'liuyuan', state: 'idle' }] }] } })
  const app = new Hono()
  registerOperationsRoutes(app, { store, authenticate: (c) => c.req.header('x-user') || null, checkSuperAdmin: (c) => c.req.header('x-bootstrap') === 'yes', checkAdmin: () => false, now: () => clock })
  const call = async (path, { user = 'a', method = 'GET', body, bootstrap } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (user) headers['x-user'] = user
    if (bootstrap) headers['x-bootstrap'] = 'yes'
    const response = await app.request('https://laundry.example' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  return { store, call, advance: (ms = 11000) => { clock += ms } }
}
const post = (call, body, user = 'a') => call('/api/messages', { user, method: 'POST', body })

test('channel catalog is public, puts current dorm second, honors dynamic buildings and validates filters', async () => {
  const { call, store } = await fixture()
  const own = await call('/api/messages/channels', { user: 'b' })
  assert.equal(own.status, 200)
  assert.deepEqual(own.data.channels.slice(0, 2).map((channel) => channel.code), ['public', 'liuyuan'])
  assert.equal(own.data.currentBuilding, 'liuyuan')
  assert.equal(own.data.permissions.canModerate, false)
  assert.equal((await call('/api/messages/channels', { user: null })).status, 200)
  await store.put('meta:site', { buildings: [{ code: 'custom', name: '自定义楼' }, { code: 'liuyuan', name: '柳园' }] })
  assert.deepEqual((await call('/api/messages/channels')).data.channels.map((channel) => channel.code), ['public', 'custom', 'liuyuan'])
  assert.equal((await call('/api/messages?channel=guiyuan')).status, 400)
  assert.equal((await call('/api/messages?channel=public&machineId=g1')).status, 400)
})

test('public and building channels isolate posts/replies and legacy dorm/machine/default queries remain compatible', async () => {
  const { call, advance, store } = await fixture()
  const pub = await post(call, { channel: 'public', text: '公共留言' })
  assert.equal(pub.status, 200)
  advance()
  assert.equal((await post(call, { channel: 'public', machineId: 'g1', text: '不能带机器' })).status, 400)
  const own = await post(call, { dorm: 'guiyuan', machineId: 'g1', text: '楼内留言' })
  advance()
  const other = await post(call, { channel: 'liuyuan', text: '另一楼留言' })
  assert.equal(other.status, 200)
  advance()
  assert.equal((await post(call, { channel: 'liuyuan', replyTo: own.data.id, text: '跨楼回复' })).status, 400)
  assert.equal((await post(call, { channel: 'public', replyTo: own.data.id, text: '跨公共回复' })).status, 400)
  assert.equal((await post(call, { channel: 'guiyuan', dorm: 'liuyuan', text: '矛盾字段' })).status, 400)
  const reply = await post(call, { channel: 'public', replyTo: pub.data.id, text: '同频道回复' })
  assert.equal(reply.status, 200)
  assert.equal(reply.data.message.machineId, null)
  assert.equal((await call('/api/messages?channel=public')).data.pagination.total, 2)
  assert.equal((await call('/api/messages?dorm=guiyuan')).data.pagination.total, 1)
  assert.equal((await call('/api/messages?machineId=g1')).data.pagination.total, 1)
  assert.equal((await call('/api/messages')).data.pagination.total, 4)
  assert.equal((await call('/api/messages?channel=public&limit=1')).data.pagination.hasMore, true)
  await store.put('messages:b1', [{ id: 'old', userId: 'a', machineId: 'g1', text: '迁移旧留言', at: new Date(AT).toISOString() }])
  assert.equal((await call('/api/messages?channel=guiyuan')).data.messages[0].id, 'old')
})

test('current author profile and server identity are displayed; ordinary users never receive target IDs', async () => {
  const { call, store } = await fixture()
  await store.put('messages:b1', [{ id: 'm1', userId: 'volunteer', nick: '旧昵称', avatar: 'av2', text: '宿管留言', at: new Date(AT).toISOString(), channel: 'public' }])
  let response = await call('/api/messages?channel=public')
  let message = response.data.messages[0]
  assert.equal(message.identity.role, 'volunteer')
  assert.equal(message.authorBuilding, 'guiyuan')
  assert.equal(message.authorBuildingName, '桂园')
  assert.equal(message.authorId, undefined)
  assert.equal(message.userId, undefined)
  assert.equal(message.permissions.canPin, false)
  const user = await store.get('user:volunteer')
  await store.put('user:volunteer', { ...user, nick: '新昵称', dormBuilding: 'liuyuan', role: 'super' })
  response = await call('/api/messages?channel=public', { user: 'admin' })
  message = response.data.messages[0]
  assert.equal(message.nick, '新**')
  assert.equal(message.identity.role, 'volunteer', 'profile role cannot self elevate')
  assert.equal(message.authorBuilding, 'liuyuan')
  assert.equal(message.authorId, 'volunteer')
  assert.equal(message.permissions.canPin, true)
  assert.equal(message.permissions.canMute, true)
})

test('only owner or moderators may delete and volunteer/operator cannot moderate', async () => {
  const { call } = await fixture()
  const created = await post(call, { channel: 'public', text: '本人的留言' })
  const url = '/api/messages/' + created.data.id
  assert.equal((await call(url, { method: 'DELETE', user: null })).status, 401)
  for (const user of ['b', 'volunteer', 'operator']) assert.equal((await call(url, { method: 'DELETE', user })).status, 403)
  assert.equal((await call(url, { method: 'DELETE', user: 'admin' })).status, 200)
  assert.equal((await call(url, { method: 'DELETE', user: 'a' })).status, 404)
})

test('pin is moderator-only, targets only current volunteers, sorts first, caps five per channel and allows unpin', async () => {
  const { call, store } = await fixture()
  const entries = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, userId: 'volunteer', text: '公告' + i, channel: 'public', at: new Date(AT + i).toISOString() }))
  entries.push({ id: 'regular', userId: 'a', text: '普通帖子', channel: 'public', at: new Date(AT + 100).toISOString() })
  entries.push({ id: 'dorm', userId: 'volunteer', text: '楼内公告', channel: 'guiyuan', at: new Date(AT).toISOString() })
  await store.put('messages:b1', entries)
  const pin = (id, user = 'admin', pinned = true) => call('/api/messages/' + id + '/pin', { user, method: 'PATCH', body: { pinned } })
  for (const user of [null, 'a', 'volunteer', 'operator']) assert.equal((await pin('m0', user)).status, user ? 403 : 401)
  assert.equal((await pin('regular')).status, 403)
  for (let i = 0; i < 5; i++) assert.equal((await pin('m' + i)).status, 200)
  assert.equal((await pin('m5')).status, 409)
  assert.equal((await pin('dorm')).status, 200)
  const list = (await call('/api/messages?channel=public')).data.messages
  assert.equal(list[0].pinned, true)
  assert.equal(list[4].pinned, true)
  assert.equal(list[5].pinned, false)
  assert.equal((await pin('m0', 'admin', false)).status, 200)
  assert.equal((await pin('m5')).status, 200)
})

test('moderators can withdraw old pins after volunteer role is revoked or author account disappears', async () => {
  const { call, store } = await fixture()
  await store.put('messages:b1', [{ id: 'former-volunteer', userId: 'volunteer', text: '旧公告', channel: 'public', at: new Date(AT).toISOString(), pinned: true }])
  const url = '/api/messages/former-volunteer/pin'
  await store.put('meta:siteAdmins', (await store.get('meta:siteAdmins')).filter((row) => row.userId !== 'volunteer'))
  let message = (await call('/api/messages?channel=public', { user: 'admin' })).data.messages[0]
  assert.equal(message.identity.role, 'user')
  assert.equal(message.permissions.canPin, true, 'the UI must keep the unpin action available')
  assert.equal((await call(url, { user: 'a', method: 'PATCH', body: { pinned: false } })).status, 403)
  assert.equal((await call(url, { user: 'admin', method: 'PATCH', body: { pinned: false } })).status, 200)
  message = (await call('/api/messages?channel=public', { user: 'admin' })).data.messages[0]
  assert.equal(message.pinned, false)
  assert.equal(message.permissions.canPin, false)
  assert.equal((await call(url, { user: 'admin', method: 'PATCH', body: { pinned: true } })).status, 403, 'a former volunteer cannot be pinned again')
  const entries = await store.get('messages:b1')
  entries[0].pinned = true
  await store.put('messages:b1', entries)
  await store.del('user:volunteer')
  assert.equal((await call(url, { user: null, bootstrap: true, method: 'POST', body: { pinned: false } })).status, 200)
  assert.equal((await store.get('messages:b1'))[0].pinned, false)
})

test('global timed/permanent mutes stop every post/reply path and expire or unmute correctly', async () => {
  const { call, advance } = await fixture()
  const original = await post(call, { channel: 'public', text: '原帖' }, 'b')
  const mute = await call('/api/moderation/mutes', { user: 'admin', method: 'POST', body: { userId: 'a', durationMinutes: 60, reason: '  请注意文明  ' } })
  assert.equal(mute.status, 200)
  assert.equal(mute.data.mute.reason, '请注意文明')
  for (const fields of [{ channel: 'public' }, { channel: 'liuyuan' }, { dorm: 'guiyuan', machineId: 'g1' }, {}, { channel: 'public', replyTo: original.data.id }]) {
    const response = await post(call, { text: '被禁言尝试', ...fields })
    assert.equal(response.status, 403)
    assert.equal(response.data.error.code, 'muted')
  }
  assert.equal((await call('/api/messages/channels')).data.mute.active, true)
  assert.equal((await call('/api/moderation/mutes')).status, 403)
  assert.equal((await call('/api/moderation/mutes', { user: 'admin' })).data.mutes.length, 1)
  advance(61 * 60000)
  assert.equal((await post(call, { channel: 'public', text: '恢复发言' })).status, 200)
  assert.equal((await call('/api/messages/channels')).data.mute, null)
  assert.equal((await call('/api/moderation/mutes', { user: 'admin', method: 'POST', body: { userId: 'a', durationMinutes: null } })).status, 200)
  assert.equal((await call('/api/moderation/mutes/a', { user: 'admin', method: 'DELETE' })).status, 200)
  advance()
  assert.equal((await post(call, { dorm: 'guiyuan', machineId: 'g1', text: '旧3D入口也恢复' })).status, 200)
})

test('moderation rejects peer/higher roles, self and forged roles; validates bounds and supports bootstrap super', async () => {
  const { call } = await fixture()
  const mute = (userId, user = 'admin', patch = {}) => call('/api/moderation/mutes', { user, method: 'POST', body: { userId, durationMinutes: 60, ...patch } })
  for (const userId of ['super', 'admin']) assert.equal((await mute(userId)).status, 403)
  assert.equal((await mute('super', 'super')).status, 403)
  for (const user of [null, 'a', 'operator', 'volunteer']) assert.equal((await mute('b', user)).status, user ? 403 : 401)
  for (const durationMinutes of [0, -1, 1.5, 525601, '60']) assert.equal((await mute('b', 'admin', { durationMinutes })).status, 400)
  assert.equal((await mute('b', 'admin', { reason: '字'.repeat(201) })).status, 400)
  assert.equal((await mute('missing')).status, 404)
  assert.equal((await call('/api/moderation/mutes', { user: null, bootstrap: true, method: 'POST', body: { userId: 'admin', durationMinutes: 1 } })).status, 200)
  assert.equal((await call('/api/moderation/mutes/admin', { user: 'admin', method: 'DELETE' })).status, 403)
  assert.equal((await call('/api/moderation/mutes/admin', { user: null, bootstrap: true, method: 'DELETE' })).status, 200)
})

test('read only queries fetch current authors/parents and never scan user namespace', async () => {
  const { call, store } = await fixture()
  await store.put('messages:b1', [{ id: 'p', userId: 'b', text: '父', channel: 'public', at: new Date(AT).toISOString() }, { id: 'c', userId: 'a', text: '子', channel: 'public', replyTo: 'p', at: new Date(AT).toISOString() }])
  store.list = () => { throw new Error('No user scan') }
  const response = await call('/api/messages?channel=public&limit=1')
  assert.equal(response.status, 200)
  assert.equal(response.data.messages[0].reply.authorBuilding, 'liuyuan')
  assert.equal(response.data.messages[0].reply.identity.role, 'user')
})

test('real application JWTs protect moderation and muted users cannot bypass through legacy 3D messages endpoint', async (t) => {
  const { store } = await fixture()
  const secret = 'community-real-jwt-integration-secret-2026'
  const app = createApp({ store, env: { AUTH_SECRET: secret, ADMIN_TOKEN: 'community-bootstrap-token', BUILDING_ID: 'b1', HAIER_MODE: 'mock' } })
  const tokens = { a: await issueToken('a', secret), admin: await issueToken('admin', secret), volunteer: await issueToken('volunteer', secret) }
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Community tests cannot call external services') })
  const request = async (path, { user = 'a', method = 'GET', body } = {}) => {
    const res = await app.fetch(new Request('https://laundry.example' + path, { method, headers: { ...(user ? { authorization: 'Bearer ' + tokens[user] } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
    return { status: res.status, data: await res.json() }
  }
  assert.equal((await request('/api/moderation/mutes', { method: 'POST', body: { userId: 'admin', durationMinutes: 60, role: 'super' } })).status, 403)
  assert.equal((await request('/api/moderation/mutes', { user: 'volunteer', method: 'POST', body: { userId: 'a', durationMinutes: 60 } })).status, 403)
  assert.equal((await request('/api/moderation/mutes', { user: 'admin', method: 'POST', body: { userId: 'a', durationMinutes: null } })).status, 200)
  const failed = await request('/api/messages', { method: 'POST', body: { machineId: 'g1', text: '旧3D直接请求', userId: 'admin', identity: { role: 'super' } } })
  assert.equal(failed.status, 403)
  assert.equal(failed.data.error.code, 'muted')
  assert.equal((await request('/api/messages/channels', { user: 'admin' })).data.permissions.canModerate, true)
  assert.equal((await request('/api/messages/channels')).data.mute.active, true)
  assert.deepEqual(await store.get('messages:b1', []), [])
})
