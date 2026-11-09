import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken, issueAdminSession } from '../packages/core/auth.js'
import { withOperationLock } from '../packages/core/operations.js'

const SECRET = 'admin-roles-real-jwt-secret-at-least-32'
const BOOTSTRAP = 'admin-roles-bootstrap-secret'
async function fixture(t) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real notification or upstream request forbidden') })
  const store = createMemoryStore(), tokens = {}
  for (const id of ['chief', 'admin', 'peer', 'operator', 'volunteer', 'ordinary']) {
    await store.put('user:' + id, { id, nick: id, dingUserId: 'ding-' + id, dingUnionId: 'union-' + id, provider: 'dingtalk', dormBuilding: 'guiyuan' })
    await store.put('userByDing:ding-' + id, id)
    tokens[id] = await issueToken(id, SECRET)
  }
  await store.put('meta:siteAdmins', [{ userId: 'chief', role: 'super' }, { userId: 'admin', role: 'admin' }, { userId: 'peer', role: 'admin' }, { userId: 'operator', role: 'operator' }, { userId: 'volunteer', role: 'volunteer', buildings: ['guiyuan'] }])
  const app = createApp({ store, env: { AUTH_SECRET: SECRET, ADMIN_TOKEN: BOOTSTRAP, BUILDING_ID: 'b1', HAIER_MODE: 'mock' } })
  const call = async (path, { user = 'admin', method = 'GET', body, bootstrap, session } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (user) headers.authorization = 'Bearer ' + tokens[user]
    if (bootstrap || session) headers['x-admin-token'] = session || BOOTSTRAP
    const response = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  return { store, call, tokens }
}

test('ordinary admin cannot edit or unbind super/admin/operator, including disabled high-privilege accounts', async (t) => {
  const { store, call } = await fixture(t)
  for (const target of ['chief', 'admin', 'peer', 'operator']) {
    const before = structuredClone(await store.get('user:' + target))
    for (const body of [{ unbindDing: true }, { nick: '不得覆盖', dormBuilding: 'liuyuan' }, { notifyOn: false, karma: -20 }]) {
      assert.equal((await call('/api/admin/user/' + target, { method: 'POST', body })).status, 403)
      assert.deepEqual(await store.get('user:' + target), before)
      assert.equal(await store.get('userByDing:ding-' + target), target)
    }
  }
  const chief = await store.get('user:chief')
  await store.put('user:chief', { ...chief, disabled: true })
  assert.equal((await call('/api/admin/user/chief', { method: 'POST', body: { unbindDing: true } })).status, 403)
  for (const target of ['ordinary', 'volunteer']) assert.equal((await call('/api/admin/user/' + target, { method: 'POST', body: { nick: '普通资料管理', dormBuilding: 'liuyuan' } })).status, 200)
})

test('both legacy deletion paths protect high roles and denial leaves tasks/messages/indices untouched', async (t) => {
  const { store, call } = await fixture(t)
  await store.put('tasks:chief', [{ id: 'task-chief' }])
  await store.put('messages:b1', [{ id: 'message-chief', userId: 'chief', text: '不可被普通管理员连带删账号' }])
  for (const target of ['chief', 'admin', 'peer', 'operator']) for (const path of ['/api/admin/user/', '/api/admin/users/']) {
    assert.equal((await call(path + target + '?force=1', { method: 'DELETE' })).status, 403)
    assert.ok(await store.get('user:' + target))
    assert.equal(await store.get('userByDing:ding-' + target), target)
  }
  assert.deepEqual(await store.get('tasks:chief'), [{ id: 'task-chief' }])
  assert.equal((await store.get('messages:b1')).length, 1)
  assert.equal((await call('/api/admin/user/ordinary', { method: 'DELETE' })).status, 200)
  assert.equal((await call('/api/admin/users/volunteer?force=1', { method: 'DELETE' })).status, 200)
  assert.equal((await store.get('meta:siteAdmins')).some((row) => row.userId === 'volunteer'), false, 'deletion also removes stale authorization entries')
})

test('last active account super cannot delete/unbind itself; bootstrap token/session can recover', async (t) => {
  const { store, call } = await fixture(t)
  await store.put('meta:siteAdmins', [...await store.get('meta:siteAdmins'), { userId: 'ghost', role: 'super' }, { userId: 'disabled-chief', role: 'super' }])
  await store.put('user:disabled-chief', { id: 'disabled-chief', disabled: true })
  for (const path of ['/api/admin/user/chief', '/api/admin/users/chief?force=1']) {
    const result = await call(path, { user: 'chief', method: 'DELETE' })
    assert.equal(result.status, 403)
    assert.equal(result.data.error.code, 'last_super')
  }
  assert.equal((await call('/api/admin/user/chief', { user: 'chief', method: 'POST', body: { unbindDing: true } })).status, 403)
  assert.equal((await call('/api/admin/user/chief', { user: 'chief', method: 'POST', body: { nick: '总管自己改昵称' } })).status, 200)
  assert.equal((await call('/api/admin/user/peer', { user: 'chief', method: 'POST', body: { notifyOn: false } })).status, 200)
  const session = await issueAdminSession(SECRET)
  assert.equal((await call('/api/admin/user/chief', { user: null, session, method: 'POST', body: { unbindDing: true } })).status, 200)
  assert.equal((await call('/api/admin/users/chief?force=1', { user: null, bootstrap: true, method: 'DELETE' })).status, 200)
  assert.equal(await store.get('user:chief', null), null)
  assert.equal((await store.get('meta:siteAdmins')).some((row) => row.userId === 'chief'), false)
})

test('account super may delete itself when another active super survives, then the survivor is protected', async (t) => {
  const { store, call } = await fixture(t)
  await store.put('meta:siteAdmins', (await store.get('meta:siteAdmins')).map((row) => row.userId === 'peer' ? { ...row, role: 'super' } : row))
  assert.equal((await call('/api/admin/user/chief', { user: 'chief', method: 'DELETE' })).status, 200)
  const response = await call('/api/admin/user/peer', { user: 'peer', method: 'DELETE' })
  assert.equal(response.status, 403)
  assert.equal(response.data.error.code, 'last_super')
  assert.ok(await store.get('user:peer'))
})

test('member promotion and account mutation serialize so queued edits cannot overwrite a newly privileged target', async (t) => {
  const { store, call } = await fixture(t)
  let release, entered
  const started = new Promise((resolve) => { entered = resolve })
  const blocker = withOperationLock(store, 'site-config', () => { entered(); return new Promise((resolve) => { release = resolve }) })
  await started
  const promotion = withOperationLock(store, 'site-config', async () => store.put('meta:siteAdmins', [...await store.get('meta:siteAdmins'), { userId: 'ordinary', role: 'admin' }]))
  const modification = call('/api/admin/user/ordinary', { method: 'POST', body: { unbindDing: true, nick: '不得覆盖' } })
  release()
  await Promise.all([blocker, promotion])
  assert.equal((await modification).status, 403)
  assert.equal((await store.get('user:ordinary')).dingUserId, 'ding-ordinary')
  assert.equal((await store.get('user:ordinary')).nick, 'ordinary')
})

test('user edit allowlists prevent identity injection; ordinary profile writes cannot override DingTalk identity or owner', async (t) => {
  const { store, call } = await fixture(t)
  const before = structuredClone(await store.get('user:ordinary'))
  for (const body of [{ userId: 'chief', nick: '不得部分写入' }, { id: 'chief' }, { dingUserId: 'ding-chief' }, { dingUnionId: 'union-chief' }, { provider: 'dingtalk' }, { role: 'super' }, null, [], { notifyOn: 'false' }, { unbindDing: 'true' }, { karma: '100' }]) {
    assert.equal((await call('/api/admin/user/ordinary', { method: 'POST', body })).status, 400)
    assert.deepEqual(await store.get('user:ordinary'), before)
  }
  const response = await call('/api/user/profile', { user: 'ordinary', method: 'POST', body: { nick: '本人改昵称', id: 'chief', userId: 'chief', dingUserId: 'ding-chief', dingUnionId: 'union-chief', provider: 'evil', role: 'super', buildings: ['liuyuan'] } })
  assert.equal(response.status, 200)
  const after = await store.get('user:ordinary')
  assert.equal(after.id, 'ordinary')
  assert.equal(after.dingUserId, before.dingUserId)
  assert.equal(after.dingUnionId, before.dingUnionId)
  assert.equal(after.provider, before.provider)
  assert.equal(after.role, undefined)
  assert.equal((await call('/api/user/identity', { user: 'ordinary' })).data.identity.role, 'user')
  assert.equal((await store.get('user:chief')).dingUserId, 'ding-chief')
})
