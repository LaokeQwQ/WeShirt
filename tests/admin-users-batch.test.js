import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'user-batch-fixture-signing-key-at-least-32'
async function fixture(t) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External request forbidden') })
  const store = createMemoryStore(), tokens = {}
  for (const [id, dormBuilding] of [['chief', 'liuyuan'], ['admin', 'liuyuan'], ['scoped', 'liuyuan'], ['gui', 'guiyuan'], ['willow', 'liuyuan'], ['active', 'guiyuan'], ['broken', 'guiyuan']]) {
    await store.put('user:' + id, { id, nick: id === 'gui' ? '=HYPERLINK("https://invalid")' : id, dormBuilding, mobile: '13812345678', notifyOn: true })
    tokens[id] = await issueToken(id, SECRET)
  }
  await store.put('meta:siteAdmins', [{ userId: 'chief', role: 'super' }, { userId: 'admin', role: 'admin' }, { userId: 'scoped', role: 'admin' }])
  await store.put('access:user:scoped', { permissions: { adminUsers: { view: true, operate: true, viewBuildings: ['guiyuan'], operateBuildings: ['guiyuan'] } } })
  const app = createApp({ store, env: { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'batch-bootstrap-token', HAIER_MODE: 'mock', BUILDING_ID: 'b1' } })
  const request = (path, { user = 'scoped', body, method = body ? 'POST' : 'GET' } = {}) => app.request(path, {
    method, headers: { ...(user ? { authorization: 'Bearer ' + tokens[user] } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const batch = async (ids, action, options = {}, user = 'scoped') => {
    const response = await request('/api/admin/users/batch', { user, body: { ids, action, confirmed: true, ...options } })
    return { status: response.status, data: await response.json() }
  }
  return { store, request, batch }
}

test('用户CSV按查看楼栋和搜索先筛选，始终脱敏、防公式且留下导出审计', async (t) => {
  const { store, request } = await fixture(t)
  const response = await request('/api/admin/users.csv?q=hyperlink&phone=1')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.match(response.headers.get('content-type'), /text\/csv/)
  const text = await response.text()
  assert.ok(text.includes('138****5678'))
  assert.ok(!text.includes('13812345678'))
  assert.ok(text.includes('"\'=HYPERLINK('))
  assert.ok(!text.includes('willow'))
  assert.equal((await request('/api/admin/users.csv?dorm=liuyuan')).status, 403)
  assert.equal((await request('/api/admin/users.csv', { user: 'gui' })).status, 401)
  assert.equal((await request('/api/admin/users.csv', { user: null })).status, 401)
  const audit = (await store.list('auditlog:')).flatMap((entry) => Array.isArray(entry.value) ? entry.value : [])
  assert.ok(audit.some((entry) => entry.action === '导出脱敏用户列表'))
})

test('批量每个目标独立校验楼栋，越权和缺失不影响合法目标', async (t) => {
  const { store, batch } = await fixture(t)
  const result = await batch(['gui', 'willow', 'missing'], 'setNotify', { notifyOn: false })
  assert.equal(result.status, 200)
  assert.equal(result.data.succeeded, 1)
  assert.equal(result.data.failed, 2)
  assert.deepEqual(result.data.results.map((row) => [row.id, row.status]), [['gui', 200], ['willow', 403], ['missing', 404]])
  assert.equal((await store.get('user:gui')).notifyOn, false)
  assert.equal((await store.get('user:willow')).notifyOn, true)
  for (const row of result.data.results.filter((row) => !row.ok)) assert.equal(row.error.eventId, result.data.eventId)
  assert.equal((await batch(['gui'], 'setDorm', { dormBuilding: 'liuyuan' })).data.results[0].status, 403)
  assert.equal((await batch(['gui'], 'setDorm', { dormBuilding: null })).data.results[0].status, 403)
})

test('先按查看范围筛选再分页，其他楼栋的新用户不会挤掉授权用户', async (t) => {
  const { store, request } = await fixture(t)
  for (let i = 0; i < 205; i++) await store.put('user:outside_' + i, { id: 'outside_' + i, nick: 'outside', dormBuilding: 'liuyuan', createdAt: '2099-01-01T00:00:00Z' })
  const response = await request('/api/admin/users?limit=2')
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.items.length, 2)
  assert.ok(data.items.every(user => user.dormBuilding === 'guiyuan'))
  assert.ok(data.items.every(user => user.canOperate))
  assert.deepEqual(data.bulk.operateBuildings, ['guiyuan'])
})

test('批量沿用高权限和最后总管保护，有未取衣任务或登记时拒绝批量删除', async (t) => {
  const { store, batch } = await fixture(t)
  let result = await batch(['chief', 'gui'], 'setNotify', { notifyOn: false }, 'admin')
  assert.deepEqual(result.data.results.map((row) => row.status), [403, 200])
  await store.put('tasks:active', [{ id: 'unfinished', done: false }])
  result = await batch(['active', 'willow', 'chief'], 'delete', {}, 'chief')
  assert.deepEqual(result.data.results.map((row) => row.status), [409, 200, 403])
  assert.ok(await store.get('user:active'))
  assert.equal(await store.get('user:willow', null), null)
  assert.ok(await store.get('user:chief'))
  await store.put('occupancy:b1', { machine: { userId: 'gui' } })
  assert.equal((await batch(['gui'], 'delete', {}, 'chief')).data.results[0].status, 409)
})

test('单用户存储失败逐项返回，后续目标继续；参数上限和二次确认必需', async (t) => {
  const { store, request, batch } = await fixture(t)
  const put = store.put.bind(store)
  store.put = async (key, value) => { if (key === 'user:broken') throw new Error('private store failure'); return put(key, value) }
  const result = await batch(['broken', 'gui'], 'setNotify', { notifyOn: false })
  assert.equal(result.status, 200)
  assert.deepEqual(result.data.results.map((row) => row.status), [500, 200])
  assert.ok(!JSON.stringify(result.data).includes('private store failure'))
  for (const body of [
    { ids: ['gui'], action: 'setNotify', notifyOn: false },
    { ids: ['gui', 'gui'], action: 'delete', confirmed: true },
    { ids: Array.from({ length: 51 }, (_, i) => 'id' + i), action: 'delete', confirmed: true },
    { ids: ['gui'], action: 'setNotify', notifyOn: 'false', confirmed: true },
  ]) assert.equal((await request('/api/admin/users/batch', { body })).status, 400)
})
