import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createCloudBasePostgresAtomicStore } from '../packages/core/mobile-store-postgres.js'
import { createMobileAtomicHttpHandler } from '../packages/core/mobile-store.js'
import { mobileDigest } from '../packages/core/mobile-auth.js'
import { createAdminAccessCodes } from '../packages/core/admin-access-codes.js'

let db
const migration = new URL('../cloudbase/migrations/20261111030000_mobile_atomic_store.sql', import.meta.url)
const argumentsFor = {
  weshirt_mobile_atomic_get: ['p_key_digest'],
  weshirt_mobile_atomic_cas: ['p_key_digest', 'p_expected_version', 'p_next_version', 'p_value', 'p_expires_at_ms'],
}
async function executeRpc(name, args, { role = 'service_role', claims = { role } } = {}) {
  assert.ok(argumentsFor[name])
  assert.ok(['service_role', 'anon', 'authenticated'].includes(role))
  return db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE ' + role)
    await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)])
    const keys = argumentsFor[name]
    const query = 'SELECT public.' + name + '(' + keys.map((_, i) => '$' + (i + 1)).join(',') + ') AS result'
    const result = await tx.query(query, keys.map(key => args[key]))
    return result.rows[0].result
  })
}
const client = {
  async rpc(name, args) {
    try { return { data: await executeRpc(name, args), error: null } }
    catch (error) { return { data: null, error: { code: error.code } } }
  },
}
const makeStore = () => createCloudBasePostgresAtomicStore(client)
const expiry = () => Date.now() + 60000
const casArgs = async (key, extra = {}) => ({
  p_key_digest: await mobileDigest(key), p_expected_version: null,
  p_next_version: crypto.randomUUID(), p_value: { fixture: true }, p_expires_at_ms: expiry(), ...extra,
})

before(async () => {
  db = new PGlite()
  await db.waitReady
  await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;')
  await db.exec(await readFile(migration, 'utf8'))
})
after(async () => { await db?.close() })

test('real PostgreSQL get/create/CAS preserve values and rotate versions', async () => {
  const store = makeStore(), key = 'mobile:session:pg-versioned'
  assert.equal(await store.get(key), null)
  const value = { token: 'fictional', note: '衣服 "备注"\n第二行', flags: [false, null] }
  assert.equal(await store.compareAndSet(key, null, value, { expiresAt: expiry() }), true)
  const first = await store.get(key)
  assert.deepEqual(first.value, value)
  assert.match(first.version, /^[0-9a-f-]{36}$/)
  assert.equal(await store.compareAndSet(key, null, { wrong: true }, { expiresAt: expiry() }), false)
  assert.equal(await store.compareAndSet(key, 'old-version', { wrong: true }, { expiresAt: expiry() }), false)
  assert.equal(await store.compareAndSet(key, first.version, { revision: 2 }, { expiresAt: expiry() }), true)
  const second = await store.get(key)
  assert.notEqual(second.version, first.version)
  assert.deepEqual(second.value, { revision: 2 })
})

test('non-null expected version never inserts a missing or expired row', async () => {
  const store = makeStore(), key = 'mobile:session:pg-missing'
  assert.equal(await store.compareAndSet(key, crypto.randomUUID(), { bad: true }, { expiresAt: expiry() }), false)
  assert.equal(await store.get(key), null)
  assert.equal(await store.compareAndSet(key, null, { original: true }, { expiresAt: expiry() }), true)
  const first = await store.get(key)
  await db.query("UPDATE weshirt_mobile_private.weshirt_mobile_sessions SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE key_digest = $1", [await mobileDigest(key)])
  assert.equal(await store.get(key), null)
  assert.equal(await store.compareAndSet(key, first.version, { bad: true }, { expiresAt: expiry() }), false)
  assert.equal(await store.compareAndSet(key, null, { replacedExpired: true }, { expiresAt: expiry() }), true)
  assert.deepEqual((await store.get(key)).value, { replacedExpired: true })
})

test('queued competing callers have one winner for absent and existing versions', async () => {
  // PGlite executes real PostgreSQL in one connection. This verifies the SQL
  // contract; cloud acceptance must additionally race independent HTTP callers.
  const stores = Array.from({ length: 12 }, makeStore), key = 'mobile:challenge:pg-race'
  const first = await Promise.all(stores.map((store, winner) => store.compareAndSet(key, null, { winner }, { expiresAt: expiry() })))
  assert.equal(first.filter(Boolean).length, 1)
  const saved = await stores[0].get(key)
  const updates = await Promise.all(stores.map((store, winner) => store.compareAndSet(key, saved.version, { winner, next: true }, { expiresAt: expiry() })))
  assert.equal(updates.filter(Boolean).length, 1)
  assert.notEqual((await stores[0].get(key)).version, saved.version)
})

test('the database validates role even when RPC execute privileges are bypassed', async () => {
  // Simulate the documented CloudBase gateway behavior by granting endpoint
  // reachability. The function's explicit claim check must still deny access.
  await db.exec('GRANT EXECUTE ON FUNCTION public.weshirt_mobile_atomic_get(text) TO anon, authenticated; GRANT EXECUTE ON FUNCTION public.weshirt_mobile_atomic_cas(text, text, uuid, jsonb, bigint) TO anon, authenticated;')
  const args = await casArgs('mobile:session:pg-denied')
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(executeRpc('weshirt_mobile_atomic_get', { p_key_digest: args.p_key_digest }, { role }), { code: '42501' })
    await assert.rejects(executeRpc('weshirt_mobile_atomic_cas', args, { role }), { code: '42501' })
  }
  await assert.rejects(executeRpc('weshirt_mobile_atomic_get', { p_key_digest: args.p_key_digest }, { claims: {} }), { code: '42501' })
  // Even a direct SQL caller with a forged claim has no private schema/table ACL.
  await assert.rejects(executeRpc('weshirt_mobile_atomic_get', { p_key_digest: args.p_key_digest }, { role: 'authenticated', claims: { role: 'service_role' } }), { code: '42501' })
})

test('table ACL and forced RLS independently prevent client access', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE ' + role)
      await tx.query('SELECT * FROM weshirt_mobile_private.weshirt_mobile_sessions')
    }), { code: '42501' })
  }
  // If a later operator accidentally grants basic read access, the no-client
  // RLS policy still returns no rows. No production grants are changed here.
  await db.exec('GRANT USAGE ON SCHEMA weshirt_mobile_private TO authenticated; GRANT SELECT, INSERT ON TABLE weshirt_mobile_private.weshirt_mobile_sessions TO authenticated;')
  try {
    const result = await db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE authenticated')
      return tx.query('SELECT * FROM weshirt_mobile_private.weshirt_mobile_sessions')
    })
    assert.deepEqual(result.rows, [])
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE authenticated')
      await tx.query("INSERT INTO weshirt_mobile_private.weshirt_mobile_sessions VALUES ($1, $2, '{}'::jsonb, clock_timestamp() + interval '1 minute')", [await mobileDigest('mobile:session:pg-illegal'), crypto.randomUUID()])
    }), { code: '42501' })
  } finally {
    await db.exec('REVOKE ALL ON TABLE weshirt_mobile_private.weshirt_mobile_sessions FROM authenticated; REVOKE ALL ON SCHEMA weshirt_mobile_private FROM authenticated;')
  }
})

test('database expiry and input validation remain authoritative behind the adapter', async () => {
  const base = await casArgs('mobile:limit:pg-invalid')
  for (const extra of [
    { p_expires_at_ms: Date.now() - 60000 },
    { p_expires_at_ms: Date.now() + 101 * 86400000 },
    { p_value: [] }, { p_value: null }, { p_key_digest: 'invalid' },
    { p_expected_version: 'x'.repeat(81) },
  ]) await assert.rejects(executeRpc('weshirt_mobile_atomic_cas', { ...base, ...extra }), { code: '22023' })
  assert.equal((await executeRpc('weshirt_mobile_atomic_get', { p_key_digest: base.p_key_digest })).result, null)
  assert.equal((await executeRpc('weshirt_mobile_atomic_cas', base)).result, true)
  await assert.rejects(executeRpc('weshirt_mobile_atomic_cas', { ...base, p_expected_version: base.p_next_version }), { code: '22023' })
})

test('SDK failures and malformed scalar responses fail closed without retrying writes', async () => {
  for (const response of [
    { data: false, error: null }, { data: {}, error: null },
    { data: { protocolVersion: 1, ok: true, result: null }, error: { code: '42501' } },
    { data: { protocolVersion: 1, ok: true, result: 'true' }, error: null },
  ]) {
    let calls = 0
    const store = createCloudBasePostgresAtomicStore({ async rpc() { calls++; return response } })
    await assert.rejects(store.compareAndSet('mobile:session:pg-bad-response', null, {}, { expiresAt: expiry() }), /mobile_store_unavailable/)
    assert.equal(calls, 1)
  }
  let calls = 0
  const store = createCloudBasePostgresAtomicStore({ async rpc() { calls++; throw new Error('network response uncertain') } })
  await assert.rejects(store.compareAndSet('mobile:session:pg-network', null, {}, { expiresAt: expiry() }), /mobile_store_unavailable/)
  assert.equal(calls, 1)
  await assert.rejects(store.get('users:private'), /mobile_store_unavailable/)
  assert.equal(calls, 1)
})

test('HTTP bridge preserves method/auth denials and uses PostgreSQL transactions', async () => {
  const secret = 'fictional-bridge-secret-not-for-production'
  const handler = createMobileAtomicHttpHandler({ atomicStore: makeStore(), secret })
  const request = (body, auth = true) => handler({ httpMethod: 'POST', headers: auth ? { authorization: 'Bearer ' + secret } : {}, body: JSON.stringify(body) })
  assert.equal((await request({ op: 'get', key: 'mobile:limit:pg-http' }, false)).statusCode, 401)
  assert.equal((await handler({ httpMethod: 'GET', headers: { authorization: 'Bearer ' + secret } })).statusCode, 405)
  const saved = await request({ op: 'compareAndSet', key: 'mobile:limit:pg-http', expectedVersion: null, value: { deploymentCheck: true }, expiresAt: expiry() })
  assert.equal(saved.statusCode, 200)
  assert.equal(JSON.parse(saved.body).result, true)
  const read = await request({ op: 'get', key: 'mobile:limit:pg-http' })
  assert.equal(read.statusCode, 200)
  assert.deepEqual(JSON.parse(read.body).result.value, { deploymentCheck: true })
})

test('temporary admin namespace stores hashes and revokes sessions through real PostgreSQL CAS',async()=>{
  const service=createAdminAccessCodes({atomicStore:makeStore(),authSecret:'postgres-admin-code-test-secret32'})
  const created=await service.create({name:'数据库回归'},{actor:'bootstrap',key:'postgres-admin-create-key',buildings:[]})
  const stored=await makeStore().get('mobile:admin-access-codes:registry')
  assert.equal(JSON.stringify(stored).includes(created.code),false)
  const login=await service.login(created.code,[],12*3600000)
  const c={req:{header:()=>login.session,query:()=>undefined}}
  assert.equal((await service.verifyRequest(c,[])).identity.role,'admin')
  await service.revoke(created.accessCode.id)
  await assert.rejects(service.verifyRequest(c,[]),error=>error.status===401)
})
