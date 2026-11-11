import test from 'node:test'
import assert from 'node:assert/strict'
import { createEdgeKVStore } from '../packages/core/store.js'
import { getUserIdentity } from '../packages/core/identity.js'
import { getUserPermissions } from '../packages/core/permissions.js'
import { issueToken } from '../packages/core/auth.js'
import { createApp } from '../server/app.js'

function backend() {
  const values = new Map(), reads = new Map(), failRead = new Set()
  let failWrite = false, failDelete = false, failList = false
  const staleKeys = new Set()
  function binding() {
    return {
      async get(key) {
        reads.set(key, (reads.get(key) || 0) + 1)
        if (failRead.has(key)) throw new Error('binding read failed')
        return values.has(key) ? values.get(key) : null
      },
      async put(key, value) {
        assert.equal(typeof value, 'string', 'the real binding accepts text, not JSON primitives')
        if (failWrite) throw new Error('binding write failed')
        values.set(key, value)
      },
      async delete(key) {
        if (failDelete) throw new Error('binding delete failed')
        values.delete(key)
      },
      async list({ prefix, cursor, limit }) {
        if (failList) throw new Error('binding list failed')
        const keys = [...new Set([...values.keys(), ...staleKeys])].filter(key => key.startsWith(prefix)).sort()
        const offset = cursor ? Number(cursor) : 0
        const page = keys.slice(offset, offset + limit)
        return { keys: page.map(key => ({ key })), complete: offset + limit >= keys.length, cursor: offset + limit < keys.length ? String(offset + limit) : null }
      },
    }
  }
  return {
    values, reads, failRead, staleKeys, binding,
    set failWrite(value) { failWrite = value },
    set failDelete(value) { failDelete = value },
    set failList(value) { failList = value },
  }
}

const user = { id: 'member', nick: 'Test member', provider: 'dingtalk', dingUserId: 'ding-member', dormBuilding: 'test' }
const buildings = [{ code: 'test', name: 'Test building' }]

test('two live Edge stores observe normal API role grants, promotion and revocation with the same user token', async () => {
  const kv = backend(), writer = createEdgeKVStore(kv.binding()), reader = createEdgeKVStore(kv.binding())
  await writer.put('user:member', user)
  await writer.put('meta:siteAdmins', [])
  const env = { AUTH_SECRET: 'edge-kv-test-auth-secret-at-least-32', ADMIN_TOKEN: 'edge-kv-test-bootstrap', HAIER_MODE: 'mock', BUILDING_ID: 'b1' }
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

test('personal restrictions, account blocking and deleted identity indexes cannot survive in a second store cache', async () => {
  const kv = backend(), writer = createEdgeKVStore(kv.binding()), reader = createEdgeKVStore(kv.binding())
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
    kv.values.set(key, user.id) // Legacy indexes were unquoted strings.
    assert.equal(await reader.get(key), user.id)
    await writer.del(key)
    assert.equal(await reader.get(key), null)
  }
  await writer.del('user:member')
  assert.equal((await getUserIdentity(reader, user.id)).role, 'user')
})

test('security and session keys are re-read and binding failures never turn restrictions into absent records', async () => {
  const kv = backend(), store = createEdgeKVStore(kv.binding())
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
    kv.failRead.add(key)
    await assert.rejects(store.get(key, 'must not fall back'), /binding read failed/)
    kv.failRead.delete(key)
  }
  assert.equal(await store.get('user:missing', 'absent'), 'absent')
  for (const corrupt of ['{broken', '[]', '{"permissions":null}', '"ignored"']) {
    kv.values.set('access:user:member', corrupt)
    await assert.rejects(store.get('access:user:member', {}), /Invalid stored authorization record/)
  }
})

test('an unreadable personal rule produces an error on the real protected API instead of granting the base admin role', async () => {
  const kv = backend(), store = createEdgeKVStore(kv.binding())
  await store.put('user:member', user)
  await store.put('meta:siteAdmins', [{ userId: user.id, role: 'admin' }])
  await store.put('access:user:member', { permissions: { adminUsers: { view: false, operate: false, viewBuildings: [], operateBuildings: [] } } })
  const secret = 'edge-kv-denial-test-auth-secret-32'
  const app = createApp({ store, env: { AUTH_SECRET: secret, ADMIN_TOKEN: 'test-bootstrap', HAIER_MODE: 'mock', BUILDING_ID: 'b1' } })
  const token = await issueToken(user.id, secret)
  const request = () => app.request('https://laundry.example/api/admin/users', { headers: { authorization: 'Bearer ' + token } })
  assert.equal((await request()).status, 403)
  kv.failRead.add('access:user:member')
  const response = await request(), body = await response.json()
  assert.equal(response.status, 500)
  assert.ok(response.headers.get('X-Event-ID'))
  assert.equal(body.items, undefined)
  assert.equal(body.error.status, 500)
})

test('ordinary values expire after a short cache window and clock rollback cannot extend their lifetime', async t => {
  let now = 100_000
  t.mock.method(Date, 'now', () => now)
  const kv = backend(), writer = createEdgeKVStore(kv.binding()), reader = createEdgeKVStore(kv.binding())
  await writer.put('counter:test', { revision: 1 })
  assert.deepEqual(await reader.get('counter:test'), { revision: 1 })
  await writer.put('counter:test', { revision: 2 })
  now += 4000
  assert.deepEqual(await reader.get('counter:test'), { revision: 1 })
  now += 1000
  assert.deepEqual(await reader.get('counter:test'), { revision: 2 })
  await writer.put('counter:test', { revision: 3 })
  now -= 10_000
  assert.deepEqual(await reader.get('counter:test'), { revision: 3 })
  await writer.del('counter:test')
  now += 5000
  assert.equal(await reader.get('counter:test', 'gone'), 'gone')
})

test('entry count, total value bytes and individual value size all bound the process cache', async () => {
  const kv = backend(), writer = createEdgeKVStore(kv.binding()), reader = createEdgeKVStore(kv.binding())
  for (let index = 0; index < 200; index++) {
    await writer.put('item:' + index, index)
    await reader.get('item:' + index)
  }
  await writer.put('item:0', 'new oldest')
  await writer.put('item:199', 'new newest')
  assert.equal(await reader.get('item:0'), 'new oldest', 'old entries are evicted')
  assert.equal(await reader.get('item:199'), 199, 'recent small entries are still cached')
  for (let index = 0; index < 24; index++) {
    await writer.put('large:' + index, 'x'.repeat(60_000))
    await reader.get('large:' + index)
  }
  await writer.put('large:0', 'byte budget evicted this')
  assert.equal(await reader.get('large:0'), 'byte budget evicted this')
  await writer.put('oversized', 'x'.repeat(150_000))
  await reader.get('oversized')
  await writer.put('oversized', 'not retained')
  assert.equal(await reader.get('oversized'), 'not retained')
})

test('failed writes or deletes reject, invalidate cached data and cannot leak mutable uncommitted objects', async () => {
  const kv = backend(), store = createEdgeKVStore(kv.binding())
  await store.put('item:one', { nested: { value: 'persisted' } })
  const edited = await store.get('item:one')
  edited.nested.value = 'uncommitted'
  assert.equal((await store.get('item:one')).nested.value, 'persisted')
  kv.failWrite = true
  await assert.rejects(store.put('item:one', edited), /binding write failed/)
  assert.equal((await store.get('item:one')).nested.value, 'persisted')
  kv.failDelete = true
  await assert.rejects(store.del('item:one'), /binding delete failed/)
  assert.equal((await store.get('item:one')).nested.value, 'persisted')
  kv.failWrite = false; kv.failDelete = false
  await store.del('item:one')
  assert.equal(await store.get('item:one'), null)
  for (const value of [null, true, false, 0, 12, 'true', '12', 'null', '', { nested: ['value'] }]) {
    await store.put('roundtrip', value)
    assert.deepEqual(await store.get('roundtrip'), value)
  }
})

test('a late read cannot overwrite a newer successful write in the process cache', async () => {
  const kv = backend(), binding = kv.binding()
  kv.values.set('item:race', '1')
  let release, started
  const reading = new Promise(resolve => { started = resolve })
  const originalGet = binding.get
  binding.get = async key => {
    const old = await originalGet(key)
    started()
    await new Promise(resolve => { release = resolve })
    return old
  }
  const store = createEdgeKVStore(binding), oldRead = store.get('item:race')
  await reading
  await store.put('item:race', 2)
  release()
  assert.equal(await oldRead, 1)
  binding.get = originalGet
  assert.equal(await store.get('item:race'), 2)
})

test('an earlier committed write with a late acknowledgement cannot replace the newer durable value', async () => {
  const kv = backend(), binding = kv.binding()
  let release, committed
  const firstCommitted = new Promise(resolve => { committed = resolve })
  const originalPut = binding.put
  binding.put = async (key, value) => {
    await originalPut(key, value)
    if (value === '1') {
      committed()
      await new Promise(resolve => { release = resolve })
    }
  }
  const store = createEdgeKVStore(binding), firstWrite = store.put('item:race', 1)
  await firstCommitted
  await store.put('item:race', 2)
  assert.equal(await store.get('item:race'), 2)
  release()
  await firstWrite
  assert.equal(kv.values.get('item:race'), '2')
  assert.equal(await store.get('item:race'), 2)
})

test('list traverses real pages, de-duplicates keys and cannot resurrect deleted entries from a warm cache', async () => {
  const kv = backend(), writer = createEdgeKVStore(kv.binding()), reader = createEdgeKVStore(kv.binding())
  for (let index = 0; index < 600; index++) await writer.put('item:' + String(index).padStart(3, '0'), index)
  await reader.get('item:001')
  await writer.del('item:001')
  kv.staleKeys.add('item:001')
  const rows = await reader.list('item:')
  assert.equal(rows.length, 599)
  assert.equal(rows.some(row => row.key === 'item:001'), false)
  assert.equal(rows.at(-1).value, 599)
  kv.failList = true
  await assert.rejects(reader.list('item:'), /binding list failed/)
  kv.failList = false; kv.failRead.add('item:599')
  await assert.rejects(reader.list('item:'), /binding read failed/)
})

test('empty terminal listing variants allow a complete cron ingest and an empty audit list', async () => {
  for (const terminal of [{ complete: true }, { cursor: null }, { cursor: '' }, { keys: [], cursor: '' }]) {
    const kv = backend(), binding = kv.binding(), originalList = binding.list
    binding.list = async options => {
      const page = await originalList(options)
      return page.keys.length ? page : { ...terminal }
    }
    const store = createEdgeKVStore(binding)
    const env = { AUTH_SECRET: 'edge-kv-test-auth-secret-at-least-32', ADMIN_TOKEN: 'edge-kv-test-bootstrap', HAIER_MODE: 'mock', BUILDING_ID: 'b1' }
    const app = createApp({ store, env })
    const headers = { 'x-admin-token': env.ADMIN_TOKEN, 'content-type': 'application/json' }
    const response = await app.request('https://laundry.example/api/cron/ingest', {
      method: 'POST', headers,
      body: JSON.stringify({ source: 'cloudbase', raws: [{ id: 'test-machine', name: 'Test machine', floorCode: '1', state: 1 }] }),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify({ terminal, error: result.error }))
    assert.equal(result.fetched, 1)
    assert.equal((await store.get('meta:sync')).failCount, 0)
    assert.equal((await store.get('machines:b1')).board.total, 1)
    const audits = await app.request('https://laundry.example/api/admin/urge-audits', { headers })
    assert.equal(audits.status, 200)
    assert.deepEqual(await audits.json(), { total: 0, items: [] })
    assert.equal(kv.values.get('assistant:lastPrune') !== undefined, true)
    assert.equal(await store.get('meta:estimateCleanup:b1'), true)
  }
})

test('empty listing compatibility rejects ambiguous, erroneous and unfinished responses', async () => {
  const kv = backend(), binding = kv.binding(), store = createEdgeKVStore(binding)
  for (const page of [
    null, {}, { error: 'unavailable' }, { error: 'unavailable', complete: true },
    { Error: { code: 'unavailable' }, cursor: null }, new Error('unavailable'),
    { keys: null, complete: true }, { keys: 'invalid', cursor: null },
    { complete: false }, { complete: false, cursor: null }, { complete: false, cursor: '' },
    { keys: [], complete: false, cursor: null }, { keys: [], complete: false, cursor: '' },
    { cursor: 'unproven-next-page' },
  ]) {
    binding.list = async () => page
    await assert.rejects(store.list('assistant:history:'), /Invalid KV listing/)
  }
  binding.list = async () => { throw new Error('binding list failed') }
  await assert.rejects(store.list('assistant:history:'), /binding list failed/)
  let calls = 0
  binding.list = async () => ++calls === 1 ? { keys: ['item:one'], complete: false, cursor: 'next' } : { complete: true }
  kv.values.set('item:one', '1')
  assert.deepEqual(await store.list('item:'), [{ key: 'item:one', value: 1 }])
  assert.equal(calls, 2)
})

test('minimal legacy bindings support remove and one-page key formats without inventing successful lists', async () => {
  const values = new Map([['one', '1'], ['two', '2'], ['three', '3']])
  const binding = {
    values,
    async get(key) { return this.values.get(key) ?? null },
    async put(key, value) { this.values.set(key, value) },
    async remove(key) { this.values.delete(key) },
    async list() { return { keys: ['one', { key: 'two' }, { name: 'three' }, 'one'] } },
  }
  const store = createEdgeKVStore(binding)
  assert.equal((await store.list()).length, 3)
  await store.del('two')
  assert.equal((await store.list()).some(row => row.key === 'two'), false)
  delete binding.list
  await assert.rejects(store.list(), /KV listing unavailable/)
  binding.list = async () => ({ keys: [], complete: false, cursor: 'same-cursor' })
  await assert.rejects(store.list(), /Invalid KV listing cursor/)
})
