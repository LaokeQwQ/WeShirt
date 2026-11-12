import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

async function setup(t) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('external request forbidden') })
  const store = createMemoryStore(), env = { AUTH_SECRET: 'machine-feedback-fixture-only-32bytes', ADMIN_TOKEN: 'machine-feedback-bootstrap', BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
  const tokens = {}
  for (const [id, dormBuilding] of [['chief', 'guiyuan'], ['manager', 'guiyuan'], ['user', 'guiyuan'], ['willow', 'liuyuan'], ['readOnly', 'guiyuan']]) {
    await store.put('user:' + id, { id, nick: id, dormBuilding })
    tokens[id] = await issueToken(id, env.AUTH_SECRET)
  }
  await store.put('meta:siteAdmins', [{ userId: 'chief', role: 'super' }, { userId: 'manager', role: 'admin' }, { userId: 'readOnly', role: 'admin' }])
  await store.put('access:user:manager', { permissions: { adminMachines: { view: true, operate: true, viewBuildings: ['guiyuan'], operateBuildings: ['guiyuan'] } } })
  await store.put('access:user:readOnly', { permissions: { adminMachines: { view: true, operate: false, viewBuildings: ['guiyuan'], operateBuildings: [] } } })
  await store.put('mapping:b1', { mapping: { '1': 'm1' } })
  await store.put('machines:b1', { board: { updatedAt: new Date().toISOString(), floors: [{ code: '1', machines: [{ id: 'm1', name: '现场原名', state: 'idle' }, { id: 'm2', name: '柳园洗衣机', dormBuilding: 'liuyuan', state: 'idle' }] }] } })
  const app = createApp({ store, env })
  const call = async (path, { user = 'user', body, method = body ? 'POST' : 'GET', bootstrap = false } = {}) => {
    const response = await app.request(path, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), ...(user ? { Authorization: 'Bearer ' + tokens[user] } : {}), ...(bootstrap ? { 'x-admin-token': env.ADMIN_TOKEN } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  return { store, call }
}

test('真实登录用户可反馈本楼机器；他楼、无账号、额外字段和过长内容被拒绝', async t => {
  const { store, call } = await setup(t)
  const result = await call('/api/machines/m1/feedback', { body: { type: 'name', detail: '现场名称不同' } })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  assert.match(result.data.feedback.id, /^mf_/)
  const saved = await store.get('machine-feedback:b1')
  assert.equal(saved[0].reporterId, 'user')
  assert.equal(saved[0].displayName, '1号洗衣机')
  assert.equal(result.data.feedback.reporterId, undefined)
  assert.equal((await call('/api/machines/m2/feedback', { body: { type: 'state', detail: '越权反馈' } })).status, 403)
  assert.equal((await call('/api/machines/m1/feedback', { user: null, body: { type: 'state', detail: '未登录' } })).status, 401)
  assert.equal((await call('/api/machines/m1/feedback', { body: { type: 'state', detail: '说明', reporterId: 'chief' } })).status, 400)
  assert.equal((await call('/api/machines/m1/feedback', { body: { type: 'state', detail: '长'.repeat(301) } })).status, 400)
})

test('并发相同反馈去重，不同反馈串行保存且触发频率限制', async t => {
  const { store, call } = await setup(t)
  const responses = await Promise.all(Array.from({ length: 5 }, () => call('/api/machines/m1/feedback', { body: { type: 'location', detail: '同一个位置问题' } })))
  assert.ok(responses.every(result => result.status === 200))
  assert.equal(new Set(responses.map(result => result.data.feedback.id)).size, 1)
  const more = await Promise.all(['第二条', '第三条', '第四条'].map(detail => call('/api/machines/m1/feedback', { body: { type: 'other', detail } })))
  assert.deepEqual(more.map(result => result.status).sort(), [200, 200, 429])
  assert.equal((await store.get('machine-feedback:b1')).length, 3)
  assert.ok(more.find(result => result.status === 429).data.error.eventId)
})

test('后台按楼栋隔离反馈，不暴露提交人账号，处理权限及说明独立校验', async t => {
  const { store, call } = await setup(t)
  const own = await call('/api/machines/m1/feedback', { body: { type: 'name', detail: '名字不对' } })
  const other = await call('/api/machines/m2/feedback', { user: 'willow', body: { type: 'state', detail: '状态不对' } })
  const listed = await call('/api/admin/machine-feedback', { user: 'manager' })
  assert.equal(listed.status, 200)
  assert.equal(listed.data.feedback.length, 1)
  assert.equal(listed.data.feedback[0].canHandle, true)
  assert.equal(listed.data.feedback[0].reporterId, undefined)
  const readonly = await call('/api/admin/machine-feedback', { user: 'readOnly' })
  assert.equal(readonly.data.feedback[0].canHandle, false)
  const patch = { method: 'PATCH', user: 'manager', body: { status: 'resolved', resolution: '已核对并修改' } }
  assert.equal((await call('/api/admin/machine-feedback/' + other.data.feedback.id, patch)).status, 403)
  assert.equal((await call('/api/admin/machine-feedback/' + own.data.feedback.id, { ...patch, user: 'readOnly' })).status, 403)
  assert.equal((await call('/api/admin/machine-feedback/' + own.data.feedback.id, { ...patch, body: { status: 'resolved', resolution: '' } })).status, 400)
  assert.equal((await call('/api/admin/machine-feedback/' + own.data.feedback.id, patch)).status, 200)
  const rows = await store.get('machine-feedback:b1')
  assert.equal(rows.find(row => row.id === own.data.feedback.id).status, 'resolved')
  assert.equal(rows.find(row => row.id === other.data.feedback.id).status, 'open')
})

test('未配置过稀疏权限的账号仍在处理时重新校验身份，不沿用中间件空白权限', async t => {
  const { store, call } = await setup(t)
  const own = await call('/api/machines/m1/feedback', { body: { type: 'other', detail: '待核实' } })
  await store.del('access:user:manager')
  await store.put('meta:siteAdmins', [{ userId: 'chief', role: 'super' }, { userId: 'manager', role: 'operator' }])
  assert.equal((await call('/api/admin/machine-feedback/' + own.data.feedback.id, { user: 'manager', method: 'PATCH', body: { status: 'resolved', resolution: '不应保存' } })).status, 403)
  assert.equal((await store.get('machine-feedback:b1'))[0].status, 'open')
})
