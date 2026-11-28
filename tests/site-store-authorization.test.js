import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteSiteStore } from '../packages/core/site-store.js'
import { getUserIdentity } from '../packages/core/identity.js'
import { getUserPermissions } from '../packages/core/permissions.js'
import { issueToken } from '../packages/core/auth.js'
import { createApp } from '../server/app.js'

function backend() {
  const values = new Map(), failRead = new Set()
  const connect = () => createRemoteSiteStore({
    url: 'https://storage.example/site-store',
    secret: 'storage-authorization-test-secret-at-least-32',
    fetch: async (_url, options) => {
      const { op, key, prefix, value } = JSON.parse(options.body)
      let result
      if (op === 'get') {
        if (failRead.has(key)) return new Response(null, { status: 503 })
        result = values.has(key) ? { found: true, value: values.get(key) } : { found: false }
      } else if (op === 'put') {
        values.set(key, value)
        result = true
      } else if (op === 'delete') {
        result = values.delete(key)
      } else if (op === 'list_keys') {
        result = { rows: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })), next: null }
      } else {
        assert.fail('Unexpected storage operation')
      }
      return Response.json({ protocolVersion: 1, ok: true, result })
    },
  })
  return { values, failRead, connect }
}

const user = { id: 'member', nick: 'Test member', provider: 'dingtalk', dingUserId: 'ding-member', dormBuilding: 'test' }
const buildings = [{ code: 'test', name: 'Test building' }]
const unavailable = { code: 'site_store_unavailable' }

test('independent CloudBase clients observe API role changes with the same user token', async () => {
  const db = backend(), writer = db.connect(), reader = db.connect()
  await writer.put('user:member', user)
  await writer.put('meta:siteAdmins', [])
  const env = { AUTH_SECRET: 'site-store-test-auth-secret-at-least-32', ADMIN_TOKEN: 'site-store-test-bootstrap', HAIER_MODE: 'mock', BUILDING_ID: 'b1' }
  const manager = createApp({ store: writer, env }), client = createApp({ store: reader, env })
  const token = await issueToken(user.id, env.AUTH_SECRET)
  const account = path => client.request('https://laundry.example' + path, { headers: { authorization: 'Bearer ' + token } })
  const role = async value => {
    const response = await manager.request('https://laundry.example/api/admin/site', {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-admin-token': env.ADMIN_TOKEN },
      body: JSON.stringify(value ? { admin: { userId: user.id, role: value, buildings: [] } } : { removeAdmin: user.id }),
    })
    assert.equal(response.status, 200, await response.text())
  }
  assert.equal((await account('/api/admin/users')).status, 401)
  await role('admin')
  assert.equal((await account('/api/admin/users')).status, 200)
  assert.equal((await getUserIdentity(reader, user.id)).role, 'admin')
  await role('super')
  const highest = await (await account('/api/user/permissions')).json()
  assert.equal(highest.identity.role, 'super')
  assert.ok(Object.values(highest.permissions).every(row => row.view && row.operate && row.viewBuildings === null && row.operateBuildings === null))
  await role(null)
  assert.equal((await account('/api/admin/users')).status, 401)
  assert.equal((await getUserIdentity(reader, user.id)).role, 'user')
})

test('independent CloudBase clients read current restrictions, account blocking and identity indexes', async () => {
  const db = backend(), writer = db.connect(), reader = db.connect()
  await writer.put('user:member', user)
  await writer.put('meta:siteAdmins', [{ userId: user.id, role: 'admin' }])
  assert.equal((await getUserPermissions(reader, await reader.get('user:member'), buildings)).permissions.adminUsers.operate, true)
  await writer.put('access:user:member', { permissions: { adminUsers: { view: true, operate: false, viewBuildings: ['test'], operateBuildings: [] } } })
  let access = await getUserPermissions(reader, await reader.get('user:member'), buildings)
  assert.equal(access.permissions.adminUsers.operate, false)
  assert.deepEqual(access.permissions.adminUsers.viewBuildings, ['test'])
  await writer.del('access:user:member')
  assert.equal((await getUserPermissions(reader, await reader.get('user:member'), buildings)).permissions.adminUsers.operate, true)
  await writer.put('user:member', { ...user, blocked: true })
  assert.equal((await getUserIdentity(reader, user.id)).role, 'user')
  await writer.put('user:member', user)
  assert.equal((await getUserIdentity(reader, user.id)).role, 'admin')
  for (const key of ['userByDing:ding-member', 'userByUnionId:union-member', 'userByDevice:device-member', 'userByUuid:legacy-member']) {
    await writer.put(key, user.id)
    assert.equal(await reader.get(key), user.id)
    await writer.del(key)
    assert.equal(await reader.get(key), null)
  }
  await writer.del('user:member')
  assert.equal((await getUserIdentity(reader, user.id)).role, 'user')
})

test('security and session reads distinguish missing records from CloudBase failures', async () => {
  const db = backend(), store = db.connect()
  const entries = [
    ['meta:siteAdmins', []], ['meta:site', { buildings }], ['user:member', user],
    ['access:user:member', { permissions: {} }], ['mobile:session:test', { revoked: false }],
    ['oauthstate:test', { device: 'test' }], ['claim:test', { userId: user.id }], ['usedclaim:test', true],
    ['takeCode:test', user.id], ['token:test', { revoked: false }], ['oauthcallbacks:test', []],
    ['bindcode:test', { userId: user.id }], ['mapping:test', { mapping: {} }], ['machines:test', { board: {} }], ['messages:test', []],
    ['moderation:mutes', {}], ['social:friends:member', []], ['community:ws-lease:member', []], ['subs', []],
  ]
  for (const [key, value] of entries) {
    await store.put(key, value)
    assert.deepEqual(await store.get(key), value)
    db.failRead.add(key)
    await assert.rejects(store.get(key, 'must not fall back'), unavailable)
    db.failRead.delete(key)
  }
  assert.equal(await store.get('user:missing', 'absent'), 'absent')
  for (const corrupt of ['{broken', [], { permissions: null }, 'ignored']) {
    db.values.set('access:user:member', corrupt)
    await assert.rejects(store.get('access:user:member', {}), unavailable)
  }
})

test('an unreadable personal rule produces an error on the real protected API instead of granting the base admin role', async () => {
  const db = backend(), store = db.connect()
  await store.put('user:member', user)
  await store.put('meta:siteAdmins', [{ userId: user.id, role: 'admin' }])
  await store.put('access:user:member', { permissions: { adminUsers: { view: false, operate: false, viewBuildings: [], operateBuildings: [] } } })
  const secret = 'site-denial-test-auth-secret-32'
  const app = createApp({ store, env: { AUTH_SECRET: secret, ADMIN_TOKEN: 'test-bootstrap', HAIER_MODE: 'mock', BUILDING_ID: 'b1' } })
  const token = await issueToken(user.id, secret)
  const request = () => app.request('https://laundry.example/api/admin/users', { headers: { authorization: 'Bearer ' + token } })
  assert.equal((await request()).status, 403)
  db.failRead.add('access:user:member')
  const response = await request(), body = await response.json()
  assert.equal(response.status, 503)
  assert.ok(response.headers.get('X-Event-ID'))
  assert.equal(body.items, undefined)
  assert.equal(body.error.status, 503)
  const rows = (await store.list('auditlog:')).flatMap(row => row.value)
  const diagnostic = rows.find(row => row.type === 'error' && row.detail?.eventId === body.error.eventId)
  assert.equal(diagnostic?.detail?.failureCategory, 'site_store_unavailable')
  assert.ok(!JSON.stringify(diagnostic).includes('CloudBase site storage unavailable'))
})
