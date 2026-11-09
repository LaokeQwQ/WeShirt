import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { getUserIdentity, canModerate, canInspect } from '../packages/core/identity.js'
import { registerSiteRoutes, checkSiteAdmin } from '../server/site.js'

const SECRET = 'identity-test-secret-at-least-16'

test('身份仅来自受控成员表；失效账号、未知角色不能提权，志愿管理仅本楼', async () => {
  const store = createMemoryStore()
  await store.put('user:ordinary', { id: 'ordinary', role: 'super' })
  await store.put('user:volunteer', { id: 'volunteer' })
  await store.put('user:operator', { id: 'operator' })
  await store.put('user:corrupt', { id: 'corrupt' })
  await store.put('user:disabled', { id: 'disabled', disabled: true })
  await store.put('user:blocked', { id: 'blocked', blocked: true })
  await store.put('meta:siteAdmins', [{ userId: 'missing', role: 'super' }, { userId: 'disabled', role: 'super' }, { userId: 'blocked', role: 'admin' }, { userId: 'volunteer', role: 'volunteer', buildings: ['guiyuan', 'guiyuan', 'public', '../bad'] }, { userId: 'operator', role: 'operator' }, { userId: 'corrupt', role: '__proto__' }])
  for (const id of ['ordinary', 'missing', 'corrupt', 'disabled', 'blocked']) assert.deepEqual(await getUserIdentity(store, id), { role: 'user', label: '', buildings: [] })
  const volunteer = await getUserIdentity(store, 'volunteer')
  assert.deepEqual(volunteer, { role: 'volunteer', label: '志愿管理', buildings: ['guiyuan'] })
  assert.equal(canInspect(volunteer, 'guiyuan'), true)
  assert.equal(canInspect(volunteer, 'liuyuan'), false)
  assert.equal(canModerate(volunteer), false)
  assert.equal(canInspect(await getUserIdentity(store, 'operator'), 'guiyuan'), false)
  assert.equal(canModerate({ role: 'admin' }), true)
  assert.equal(canInspect({ role: 'super' }, 'guiyuan'), true)
  assert.equal(canInspect({ role: 'super' }, 'public'), false)
})

async function fixture() {
  const store = createMemoryStore()
  const tokens = {}
  for (const id of ['chief', 'admin', 'operator', 'volunteer', 'candidate']) {
    await store.put('user:' + id, { id, nick: id, dingUserId: 'test-' + id })
    tokens[id] = await issueToken(id, SECRET)
  }
  await store.put('meta:siteAdmins', [{ userId: 'chief', role: 'super' }, { userId: 'admin', role: 'admin' }, { userId: 'operator', role: 'operator' }, { userId: 'volunteer', role: 'volunteer', buildings: ['guiyuan'] }])
  const app = new Hono()
  registerSiteRoutes(app, { store, env: { AUTH_SECRET: SECRET }, checkSuperAdmin: (c) => c.req.header('x-bootstrap') === 'test-bootstrap' })
  const call = async (user, body, bootstrap = false) => {
    const headers = { 'content-type': 'application/json' }
    if (user) headers.authorization = 'Bearer ' + tokens[user]
    if (bootstrap) headers['x-bootstrap'] = 'test-bootstrap'
    const response = await app.request('/api/admin/site', { method: body === undefined ? 'GET' : 'PATCH', headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  return { store, call, tokens }
}

test('账号总管管理成员和密钥；管理员仅管理志愿者，原高权成员不可覆盖或移除', async () => {
  const { call, store, tokens } = await fixture()
  let response = await call('chief')
  assert.equal(response.data.permissions.manageAdmins, true)
  assert.equal(response.data.permissions.manageVolunteers, true)
  assert.equal((await call('chief', { credentials: { appSecret: 'synthetic-test-secret' } })).status, 200)
  response = await call('admin')
  assert.equal(response.data.permissions.manageAdmins, false)
  assert.equal(response.data.permissions.manageVolunteers, true)
  assert.equal((await call('admin', { admin: { userId: 'candidate', role: 'volunteer', buildings: ['guiyuan', 'liuyuan'] } })).status, 200)
  assert.equal((await call('admin', { admin: { userId: 'operator', role: 'volunteer', buildings: ['guiyuan'] } })).status, 403)
  assert.equal((await call('admin', { admin: { userId: 'candidate', role: 'super' } })).status, 403)
  assert.equal((await call('admin', { removeAdmin: 'chief' })).status, 403)
  assert.equal((await call('admin', { credentials: { appSecret: 'overwrite' } })).status, 403)
  assert.equal((await call('admin', { removeAdmin: 'candidate' })).status, 200)
  assert.equal((await call('volunteer')).status, 401)
  assert.equal((await call('operator')).data.permissions.manageVolunteers, false)
  assert.equal(await checkSiteAdmin({ req: { header: () => 'Bearer ' + tokens.chief, method: 'PATCH' } }, store, SECRET), true)
})

test('志愿范围与保留频道校验先于写入；账号最后总管自降/自删被拒，bootstrap可恢复', async () => {
  const { call, store } = await fixture()
  for (const buildings of [[], ['missing'], ['public'], ['guiyuan', 'guiyuan'], 'guiyuan']) {
    assert.equal((await call('chief', { name: '不得落库', admin: { userId: 'candidate', role: 'volunteer', buildings } })).status, 400)
  }
  assert.equal(await store.get('meta:site', null), null)
  assert.equal((await call('chief', { buildings: [{ code: 'public', name: '公共' }] })).status, 400)
  assert.equal((await call('chief', { removeAdmin: 'chief' })).status, 400)
  assert.equal((await call('chief', { admin: { userId: 'chief', role: 'admin' } })).status, 400)
  assert.equal((await call(null, { admin: { userId: 'candidate', role: 'super' } }, true)).status, 200)
  assert.equal((await call('chief', { removeAdmin: 'chief' })).status, 200)
  assert.equal((await call(null, { admin: { userId: 'chief', role: 'super' } }, true)).status, 200)
})
