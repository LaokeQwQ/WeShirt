import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerAdminRoutes } from '../server/admin.js'
import { createMemoryStore } from '../packages/core/store.js'

async function fixture() {
  const store = createMemoryStore()
  const app = new Hono()
  registerAdminRoutes(app, { store, env: { BUILDING_ID: 'b1', ADMIN_TOKEN: 'admin-test-token', AUTH_SECRET: 's'.repeat(32) } })
  await store.put('user:a', { id: 'a', nick: '甲', dormBuilding: 'guiyuan', mobile: '13812345678' })
  await store.put('user:b', { id: 'b', nick: '乙', dormBuilding: 'liuyuan' })
  await store.put('user:c', { id: 'c', nick: '丙' })
  const call = async (path, { method = 'GET', body, auth = true } = {}) => {
    const headers = auth ? { 'x-admin-token': 'admin-test-token' } : {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await app.request('http://local' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  return { store, call }
}

test('后台用户按住宿楼/未绑定筛选，保留脱敏并返回楼栋名', async () => {
  const { call } = await fixture()
  const selected = await call('/api/admin/users?dorm=guiyuan')
  assert.equal(selected.status, 200)
  assert.equal(selected.data.total, 1)
  assert.equal(selected.data.items[0].id, 'a')
  assert.equal(selected.data.items[0].dormBuildingName, '桂园')
  assert.equal(selected.data.items[0].mobile, '138****5678')
  assert.equal((await call('/api/admin/users?dorm=unbound')).data.items[0].id, 'c')
  assert.equal((await call('/api/admin/users?dorm=no-such-building')).status, 400)
  assert.equal((await call('/api/admin/users?limit=bad')).data.items.length, 3)
})

test('管理员修改/清除住宿楼，非法字段拒绝且不污染资料', async () => {
  const { store, call } = await fixture()
  const updated = await call('/api/admin/user/a', { method: 'POST', body: { dormBuilding: 'meiyuan' } })
  assert.equal(updated.data.user.dormBuilding, 'meiyuan')
  assert.equal(updated.data.user.dormBuildingName, '梅园')
  for (const value of ['invalid', '', { code: 'guiyuan' }, 1]) {
    assert.equal((await call('/api/admin/user/a', { method: 'POST', body: { dormBuilding: value, nick: '不得生效' } })).status, 400)
    assert.equal((await store.get('user:a')).dormBuilding, 'meiyuan')
    assert.equal((await store.get('user:a')).nick, '甲')
  }
  const cleared = await call('/api/admin/user/a', { method: 'POST', body: { dormBuilding: null } })
  assert.equal(cleared.data.user.dormBuilding, null)
  assert.equal((await call('/api/admin/users?dorm=unbound')).data.total, 2)
})

test('住宿楼管理接口保留管理员鉴权', async () => {
  const { store, call } = await fixture()
  assert.equal((await call('/api/admin/users?dorm=guiyuan', { auth: false })).status, 401)
  assert.equal((await call('/api/admin/user/a', { method: 'POST', body: { dormBuilding: 'zhuyuan' }, auth: false })).status, 401)
  assert.equal((await store.get('user:a')).dormBuilding, 'guiyuan')
  assert.equal((await call('/api/admin/machines?dorm=guiyuan', { auth: false })).status, 401)
})

test('机器筛选遵从人工绑定与明确归属，kind不再仅依赖名字', async () => {
  const { store, call } = await fixture()
  const end = new Date(Date.now() + 50 * 60000).toISOString()
  await store.put('machines:b1', { board: { floors: [{ code: '1F', machines: [
    { id: 'alias', name: '柳园西', state: 'occupied', finishAt: end, leftMin: 99 },
    { id: 'explicit', name: '桂园烘干机', kind: 'dryer', dormBuilding: 'meiyuan', state: 'idle' },
    { id: 'willow', name: '柳园1号机', kind: 'washer', state: 'idle' },
    { id: 'unknown', name: '设备X', kind: 'dryer', state: 'unknown' },
  ] }] } })
  await store.put('mapping:b1', { mapping: { D1: 'alias' } })
  await store.put('queue:b1', [{ machineId: 'alias' }, { machineId: 'alias' }])
  await store.put('occupancy:b1', { alias: { userId: 'a', nick: '甲' } })
  const gui = await call('/api/admin/machines?dorm=guiyuan')
  assert.equal(gui.data.total, 1)
  const row = gui.data.rows[0]
  assert.equal(row.id, 'alias')
  assert.equal(row.kind, 'dryer')
  assert.equal(row.dormBuilding, 'guiyuan')
  assert.deepEqual(row.slots, ['D1'])
  assert.equal(row.leftMin, 50, '从结束时间算当前剩余时间，不能沿用快照99分钟')
  assert.equal(row.remainMin, 50)
  assert.equal(row.queueCount, 2)
  assert.equal(row.occupiedBy.userId, 'a')
  const willow = await call('/api/admin/machines?dorm=liuyuan')
  assert.deepEqual(willow.data.rows.map((r) => r.id), ['willow'])
  assert.equal((await call('/api/admin/machines?dorm=meiyuan')).data.rows[0].id, 'explicit')
  assert.equal((await call('/api/admin/machines?dorm=unbound')).data.rows[0].id, 'unknown')
  assert.equal((await call('/api/admin/machines?dorm=invalid')).status, 400)
})

test('网站自定义楼栋在用户列表、详情、修改和机器筛选中保持一致', async () => {
  const { call, store } = await fixture()
  await store.put('meta:site', { name: '站点', buildings: [{ code: 'custom_dorm', name: '新宿舍' }] })
  await store.put('user:a', { id: 'a', nick: '甲', dormBuilding: 'custom_dorm' })
  let result = await call('/api/admin/users?dorm=custom_dorm')
  assert.equal(result.data.items[0].dormBuilding, 'custom_dorm')
  assert.equal(result.data.items[0].dormBuildingName, '新宿舍')
  result = await call('/api/admin/user/a')
  assert.equal(result.data.user.dormBuildingName, '新宿舍')
  result = await call('/api/admin/user/b', { method: 'POST', body: { dormBuilding: 'custom_dorm' } })
  assert.equal(result.data.user.dormBuilding, 'custom_dorm')
  assert.equal(result.data.user.dormBuildingName, '新宿舍')
  await store.put('machines:b1', { board: { floors: [{ code: '1', machines: [{ id: 'custom', name: '设备', state: 'idle', dormBuilding: 'custom_dorm' }] }] } })
  result = await call('/api/admin/machines?dorm=custom_dorm')
  assert.equal(result.data.rows[0].dormBuilding, 'custom_dorm')
  assert.equal(result.data.rows[0].dormBuildingName, '新宿舍')
})
