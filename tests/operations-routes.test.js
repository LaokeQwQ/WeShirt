import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMemoryStore } from '../packages/core/store.js'
import { registerOperationsRoutes } from '../server/operations.js'
import { recordAdminAlert } from '../packages/core/operations.js'
const AT = Date.parse('2026-11-10T00:00:00Z')

async function fixture() {
  const store = createMemoryStore()
  let clock = AT
  await store.put('user:a', { id: 'a', nick: '甲', dormBuilding: 'guiyuan' })
  await store.put('user:b', { id: 'b', nick: '乙', dormBuilding: 'liuyuan' })
  await store.put('machines:b1', { board: { updatedAt: new Date(AT).toISOString(), floors: [{ code: '1', machines: [
    { id: '1', name: '桂园洗衣机', state: 'occupied', finishAt: new Date(AT + 20 * 60000).toISOString(), kind: 'washer' },
    { id: '2', name: '柳园烘干机', state: 'occupied', kind: 'dryer' },
  ] }] } })
  const app = new Hono()
  registerOperationsRoutes(app, { store, authenticate: (c) => store.get('user:' + c.req.header('x-user'), null), checkAdmin: (c) => c.req.header('x-admin') === 'yes', now: () => clock })
  const call = async (path, { user, admin, method = 'GET', body } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (user) headers['x-user'] = user
    if (admin) headers['x-admin'] = 'yes'
    const r = await app.request('http://local' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: await r.json() }
  }
  return { store, call, advance: (ms) => { clock += ms } }
}

test('预约累计实际finishAt，重复拒绝、本人取消后重算，公开响应不泄露userId', async () => {
  const { call, store } = await fixture()
  assert.equal((await call('/api/queue', { method: 'POST', body: { machineId: '1' } })).status, 401)
  const first = await call('/api/queue', { method: 'POST', user: 'a', body: { machineId: '1', durationMin: 30 } })
  assert.equal(first.status, 200)
  assert.equal(first.data.entry.waitMin, 20)
  assert.equal((await call('/api/queue', { method: 'POST', user: 'a', body: { machineId: '2' } })).status, 409)
  const second = await call('/api/queue', { method: 'POST', user: 'b', body: { machineId: '1', durationMin: 42 } })
  assert.equal(second.data.entry.waitMin, 50)
  assert.equal(second.data.entry.position, 2)
  const publicList = await call('/api/queue?machineId=1')
  assert.equal(publicList.data.queue.length, 2)
  assert.equal(publicList.data.queue[0].userId, undefined)
  assert.equal(publicList.data.queue[0].mine, false)
  await call('/api/queue?machineId=1', { method: 'DELETE', user: 'a' })
  const remaining = await call('/api/queue?machineId=1', { user: 'b' })
  assert.equal(remaining.data.queue[0].position, 1)
  assert.equal(remaining.data.queue[0].waitMin, 20)
  assert.equal(remaining.data.queue[0].mine, true)
  assert.equal((await store.get('queue:b1'))[0].userId, 'b')
})

test('无结束时间烘干预约保守60分钟，楼栋与时长校验、快速反复加入受限', async () => {
  const { call, advance } = await fixture()
  assert.equal((await call('/api/queue', { user: 'a', method: 'POST', body: { machineId: '2', dorm: 'guiyuan' } })).status, 404)
  assert.equal((await call('/api/queue', { user: 'a', method: 'POST', body: { machineId: '2', durationMin: 61 } })).status, 400)
  const created = await call('/api/queue', { user: 'a', method: 'POST', body: { machineId: '2', dorm: 'liuyuan' } })
  assert.equal(created.data.entry.durationMin, 60)
  assert.equal(created.data.entry.waitMin, 60)
  assert.equal(created.data.entry.uncertain, true)
  await call('/api/queue', { method: 'DELETE', user: 'a' })
  assert.equal((await call('/api/queue', { user: 'a', method: 'POST', body: { machineId: '2' } })).status, 429)
  advance(6000)
  assert.equal((await call('/api/queue', { user: 'a', method: 'POST', body: { machineId: '2' } })).status, 200)
})

test('留言按楼栋/机器分页、支持回复、本人删除；长度与发送频率受限', async () => {
  const { call, store, advance } = await fixture()
  assert.equal((await call('/api/messages', { method: 'POST', body: { text: 'x' } })).status, 401)
  assert.equal((await call('/api/messages', { method: 'POST', user: 'a', body: { text: 'x'.repeat(201) } })).status, 400)
  const post = await call('/api/messages', { method: 'POST', user: 'a', body: { text: '<script>alert(1)</script>', dorm: 'guiyuan', machineId: '1' } })
  assert.equal(post.status, 200)
  assert.equal((await call('/api/messages', { method: 'POST', user: 'a', body: { text: 'spam', dorm: 'guiyuan' } })).status, 429)
  const replyBody = { text: '回复', dorm: 'guiyuan', machineId: '1', replyTo: post.data.id }
  assert.equal((await call('/api/messages', { method: 'POST', user: 'b', body: replyBody })).status, 403)
  assert.equal((await store.get('messages:b1')).length, 1, '跨楼拒绝不能写入留言')
  await store.put('user:b', { ...await store.get('user:b'), dormBuilding: 'guiyuan' })
  const reply = await call('/api/messages', { method: 'POST', user: 'b', body: replyBody })
  assert.equal(reply.status, 200)
  let list = await call('/api/messages?dorm=guiyuan&machineId=1&limit=1', { user: 'b' })
  assert.equal(list.data.messages.length, 1)
  assert.equal(list.data.pagination.hasMore, true)
  assert.equal(list.data.messages[0].mine, true)
  assert.equal(list.data.messages[0].reply.text, '<script>alert(1)</script>')
  assert.equal(list.data.messages[0].userId, undefined)
  assert.equal((await call('/api/messages?dorm=liuyuan')).status, 403)
  assert.equal((await call('/api/messages/' + post.data.id, { method: 'DELETE', user: 'b' })).status, 403)
  assert.equal((await call('/api/messages/' + post.data.id, { method: 'DELETE', user: 'a' })).status, 200)
  assert.equal((await call('/api/messages', { method: 'POST', user: 'a', body: { text: '删帖后仍不能立即刷屏', dorm: 'guiyuan' } })).status, 429)
  list = await call('/api/messages?dorm=guiyuan', { user: 'a' })
  assert.equal(list.data.messages[0].reply, null)
  advance(11000)
  assert.equal((await call('/api/messages', { method: 'POST', user: 'a', body: { text: '正常新消息', dorm: 'guiyuan' } })).status, 200)
})

test('运营配置/告警读写均管理员鉴权，配置非法不落库，告警已读解决持久化', async () => {
  const { call, store } = await fixture()
  assert.equal((await call('/api/admin/operations')).status, 401)
  assert.equal((await call('/api/admin/operations', { method: 'PATCH', body: { broadcast: { enabled: false } } })).status, 401)
  assert.equal((await call('/api/admin/operations', { admin: true })).data.config.broadcast.enabled, true)
  const invalid = await call('/api/admin/operations', { admin: true, method: 'PATCH', body: { broadcast: { hours: [24] } } })
  assert.equal(invalid.status, 400)
  assert.equal(await store.get('operations:config', null), null)
  const saved = await call('/api/admin/operations', { admin: true, method: 'PATCH', body: { broadcast: { hours: [8, 12, 22] } } })
  assert.deepEqual(saved.data.config.broadcast.hours, [8, 12, 22])
  const alert = await recordAdminAlert(store, { key: 'test', title: '测试', severity: 'error' }, { now: AT })
  assert.equal((await call('/api/admin/operations/alerts/' + alert.id, { method: 'PATCH', body: { resolved: true } })).status, 401)
  const changed = await call('/api/admin/operations/alerts/' + alert.id, { admin: true, method: 'PATCH', body: { resolved: true } })
  assert.ok(changed.data.alert.readAt)
  assert.ok(changed.data.alert.resolvedAt)
  assert.ok((await call('/api/admin/operations', { admin: true })).data.alerts[0].resolvedAt)
})

test('网站新增自定义楼栋可立即筛选、预约和留言，旧楼栋选择被拒绝', async () => {
  const { call, store } = await fixture()
  await store.put('meta:site', { name: '站点', buildings: [{ code: 'new_dorm', name: '新一舍' }] })
  await store.put('user:a', { ...await store.get('user:a'), dormBuilding: 'new_dorm' })
  await store.put('machines:b1', { board: { updatedAt: new Date(AT).toISOString(), floors: [{ code: '1', machines: [{ id: 'custom', name: '新一舍洗衣机', state: 'idle', kind: 'washer', dormBuilding: 'new_dorm' }] }] } })
  const queue = await call('/api/queue', { method: 'POST', user: 'a', body: { machineId: 'custom', dorm: 'new_dorm' } })
  assert.equal(queue.status, 200)
  assert.equal((await call('/api/queue?dorm=new_dorm')).data.queue.length, 1)
  assert.equal((await call('/api/queue?dorm=guiyuan')).status, 400)
  const message = await call('/api/messages', { method: 'POST', user: 'a', body: { text: '新楼留言', dorm: 'new_dorm', machineId: 'custom' } })
  assert.equal(message.status, 200)
  const list = await call('/api/messages?dorm=new_dorm', { user: 'a' })
  assert.equal(list.data.messages[0].dormBuilding, 'new_dorm')
})
