import test from 'node:test'
import assert from 'node:assert/strict'
import { createMobileAuth, mobileDigest, MOBILE_PACKAGE } from '../packages/core/mobile-auth.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createApp } from '../server/app.js'
import { issueToken } from '../packages/core/auth.js'
import { createCloudBaseMobileAtomicStore, createRemoteMobileAtomicStore, createMobileAtomicHttpHandler } from '../packages/core/mobile-store.js'

const env = { AUTH_SECRET: 'unit-test-auth-secret-long-enough', MOBILE_AUTH_ENABLED: 'true', DINGTALK_MOBILE_CLIENT_ID: 'native-test-client', DINGTALK_MOBILE_CLIENT_SECRET: 'native-test-secret-at-least-sixteen', DINGTALK_MOBILE_REDIRECT_URI: 'https://app.example.org/native-callback' }
const install = 'installation_alpha_1234', state = 'native_state_alpha_1234', verifier = 'A'.repeat(64)
// Test-only linearizable adapter. This is never exported as a production store.
function atomicFixture(now = Date.now) {
  const records = new Map()
  return { consistency: 'linearizable', durable: true, records,
    async get(key) { const row = records.get(key); return row?.expiresAt > now() ? structuredClone({ version: row.version, value: row.value }) : null },
    async compareAndSet(key, version, value, { expiresAt }) { const row = records.get(key); const current = row?.expiresAt > now() ? row : null; if ((current?.version ?? null) !== version) return false; records.set(key, { version: crypto.randomUUID(), value: structuredClone(value), expiresAt }); return true },
  }
}
async function setup({ overrides = {}, atomic = true, identity = { unionId: 'verified_union' }, now = Date.now } = {}) {
  const store = createMemoryStore(), atomicStore = atomic ? atomicFixture(now) : undefined
  await store.put('user:u_native', { id: 'u_native', dingUnionId: 'verified_union', nick: '固定昵称', dormBuilding: 'guiyuan', dingUserId: 'ding_native' })
  await store.put('userByUnionId:verified_union', 'u_native')
  let exchanges = 0
  const identityProvider = { async exchange() { exchanges++; return identity } }
  const options = { store, env: { ...env, ...overrides }, atomicStore, identityProvider, now }
  const auth = createMobileAuth(options)
  const challenge = async () => auth.challenge({ installationId: install, state, codeChallenge: await mobileDigest(verifier), platform: 'android', packageName: MOBILE_PACKAGE })
  const session = async () => { const row = await challenge(); return auth.exchange({ challengeId: row.challengeId, state, codeVerifier: verifier, authCode: 'new-sdk-code' }) }
  return { store, atomicStore, identityProvider, auth, challenge, session, exchanges: () => exchanges, options }
}

test('native auth fails closed without both dedicated native credentials and durable atomic store', async () => {
  for (const options of [{ atomic: false }, { overrides: { MOBILE_AUTH_ENABLED: 'false' } }, { overrides: { DINGTALK_MOBILE_CLIENT_SECRET: '' } }, { overrides: { DINGTALK_MOBILE_REDIRECT_URI: 'http://app.example.org/' } }]) {
    const f = await setup(options)
    assert.equal(f.auth.enabled, false)
    await assert.rejects(f.challenge(), error => error.status === 503 && error.code === 'mobile_auth_not_configured')
    assert.equal(f.exchanges(), 0)
  }
  const f = await setup(); assert.equal(createMobileAuth({ ...f.options, atomicStore: { ...f.atomicStore, durable: false } }).enabled, false)
})
test('native challenge binds state, package, verifier and survives concurrent exchange on only one worker', async () => {
  const f = await setup(), challenge = await f.challenge()
  const body = { challengeId: challenge.challengeId, state, codeVerifier: verifier, authCode: 'secret-native-code' }
  assert.equal(challenge.provider.scope, 'openid')
  assert.equal(challenge.provider.redirectUri, env.DINGTALK_MOBILE_REDIRECT_URI)
  await assert.rejects(f.auth.exchange({ ...body, state: 'different_state_1234' }), error => error.code === 'invalid_challenge')
  await assert.rejects(f.auth.exchange({ ...body, codeVerifier: 'B'.repeat(64) }), error => error.code === 'invalid_challenge')
  const otherWorker = createMobileAuth(f.options)
  const results = await Promise.allSettled([f.auth.exchange(body), otherWorker.exchange(body)])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(f.exchanges(), 1)
  assert.ok(!JSON.stringify([...f.atomicStore.records]).includes(body.authCode))
  const session = results.find(row => row.status === 'fulfilled').value
  assert.equal(await f.auth.verifyAccessToken(session.accessToken), 'u_native')
  assert.deepEqual(Object.keys(session.user).sort(), ['avatar', 'avatarUrl', 'dormBuilding', 'id', 'nick'].sort())
})
test('refresh rotation is atomic across independent workers; logout revokes immediately', async () => {
  const f = await setup(), session = await f.session(), otherWorker = createMobileAuth(f.options)
  const refresh = { installationId: install, refreshToken: session.refreshToken }
  await assert.rejects(f.auth.refresh({ ...refresh, installationId: 'other_installation_1234' }), error => error.status === 401)
  const results = await Promise.allSettled([f.auth.refresh(refresh), otherWorker.refresh(refresh)])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  const rotated = results.find(row => row.status === 'fulfilled').value
  assert.equal(await f.auth.verifyAccessToken(session.accessToken), null)
  assert.equal(await otherWorker.verifyAccessToken(rotated.accessToken), 'u_native')
  await assert.rejects(f.auth.refresh(refresh), error => error.status === 401)
  await f.atomicStore.compareAndSet('mobile:installation:' + install, null, { userId: 'u_native', notificationsEnabled: true, token: 'private-push-token' }, { expiresAt: Date.now() + 60000 })
  await otherWorker.logout({ installationId: install, refreshToken: rotated.refreshToken })
  assert.equal(await f.auth.verifyAccessToken(rotated.accessToken), null)
  const installation = (await f.atomicStore.get('mobile:installation:' + install)).value
  assert.equal(installation.token, null); assert.equal(installation.userId, null)
  await assert.rejects(f.auth.refresh({ ...refresh, refreshToken: rotated.refreshToken }), error => error.status === 401)
})
test('tokens expire and disabled accounts cannot authenticate or refresh', async () => {
  let at = 1794300000000
  const f = await setup({ now: () => at }), session = await f.session()
  at += 901000
  assert.equal(await f.auth.verifyAccessToken(session.accessToken), null)
  const refreshed = await f.auth.refresh({ installationId: install, refreshToken: session.refreshToken })
  const user = await f.store.get('user:u_native'); await f.store.put('user:u_native', { ...user, disabled: true })
  assert.equal(await f.auth.verifyAccessToken(refreshed.accessToken), null)
  await assert.rejects(f.auth.refresh({ installationId: install, refreshToken: refreshed.refreshToken }), error => error.status === 401)
})

test('native installation updates are bound to the login installation and an older logout cannot disable its replacement', async () => {
  const f = await setup(), older = await f.session(), newer = await f.session()
  const app = createApp({ store: f.store, env: { ...env, MOBILE_PUSH_ENABLED: 'true' }, mobile: { atomicStore: f.atomicStore, identityProvider: f.identityProvider, pushTransports: { fcm: async () => ({ ok: true }) } } })
  const patch = { notificationsEnabled: true, provider: 'fcm', token: 'replacement-device-token', appVersion: '0.1.1' }
  const request = (id, token) => app.request('/api/mobile/installations/' + id, { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'Idempotency-Key': 'same-device-setting-key' }, body: JSON.stringify(patch) })
  assert.equal((await request('installation_other_1234', older.accessToken)).status, 403)
  assert.equal((await request(install, older.accessToken)).status, 200)
  assert.equal((await request(install, newer.accessToken)).status, 200)
  assert.equal((await f.store.list('request:idempotency:')).length, 0)
  const newSessionId = newer.accessToken.split('.')[1]
  assert.equal((await f.atomicStore.get('mobile:installation:' + install)).value.sessionId, newSessionId)
  await f.auth.logout({ installationId: install, refreshToken: older.refreshToken })
  await f.auth.logout({ installationId: install, refreshToken: older.refreshToken })
  assert.equal((await f.atomicStore.get('mobile:installation:' + install)).value.token, patch.token)
  assert.deepEqual((await f.atomicStore.get('mobile:installation-index:u_native')).value.installations, [install])
  assert.equal(await f.auth.verifyAccessToken(newer.accessToken), 'u_native')
  await f.auth.logout({ installationId: install, refreshToken: newer.refreshToken })
  assert.equal((await f.atomicStore.get('mobile:installation:' + install)).value.token, null)
  assert.deepEqual((await f.atomicStore.get('mobile:installation-index:u_native')).value.installations, [])
})

test('expired logout returns a credential error instead of attempting a store write with expired TTL', async () => {
  let at = Date.now()
  const f = await setup({ now: () => at }), session = await f.session()
  at += 31 * 86400000
  await assert.rejects(f.auth.logout({ installationId: install, refreshToken: session.refreshToken }), error => error.status === 401 && error.code === 'invalid_refresh_token')
})
test('unverified union index never merges accounts using nickname or phone', async () => {
  const f = await setup({ identity: { unionId: 'other_union', nick: '固定昵称', mobile: '12345678901' } })
  await f.store.put('userByUnionId:other_union', 'u_native')
  await assert.rejects(f.session(), error => error.code === 'account_link_required' && error.status === 409)
  assert.equal((await f.store.get('user:u_native')).dingUnionId, 'verified_union')
})
test('challenge limits are shared across workers and invalid payloads cannot create challenges', async () => {
  const f = await setup()
  for (let i = 0; i < 5; i++) await createMobileAuth(f.options).challenge({ installationId: install, state, codeChallenge: await mobileDigest(verifier), platform: 'android', packageName: MOBILE_PACKAGE })
  await assert.rejects(f.challenge(), error => error.status === 429)
  await assert.rejects(f.auth.challenge({ installationId: install, state, codeChallenge: await mobileDigest(verifier), platform: 'android', packageName: 'different.package' }), error => error.code === 'bad_param')
})
test('mobile routes use standard event IDs, accept native sessions on existing APIs and omit credentials from audit', async () => {
  const f = await setup(), app = createApp({ store: f.store, env, mobile: { atomicStore: f.atomicStore, identityProvider: f.identityProvider } })
  const request = (path, body, token) => app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'Idempotency-Key': 'native-auth-test-key' }), ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const config = await (await request('/api/mobile/config')).json()
  assert.equal(config.auth.enabled, true); assert.equal(JSON.stringify(config).includes(env.DINGTALK_MOBILE_CLIENT_SECRET), false)
  const session = await f.session(), me = await request('/api/auth/me', undefined, session.accessToken)
  assert.equal(me.status, 200)
  const refresh = await request('/api/mobile/auth/refresh', { installationId: install, refreshToken: session.refreshToken }, session.accessToken)
  assert.equal(refresh.status, 200)
  assert.equal((await f.store.list('request:idempotency:')).length, 0)
  const bad = await request('/api/mobile/auth/refresh', { installationId: install, refreshToken: 'bad' })
  const data = await bad.json()
  assert.equal(bad.status, 401); assert.equal(data.error.status, 401); assert.equal(data.error.eventId, bad.headers.get('X-Event-ID'))
  assert.equal(JSON.stringify(await f.store.list('audit:')).includes(session.refreshToken), false)
})
test('default native provider exchanges new SDK codes with dedicated credentials and verified identity only', async t => {
  const f = await setup(), originalFetch = globalThis.fetch, calls = []
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).endsWith('/oauth2/userAccessToken')) return new Response(JSON.stringify({ accessToken: 'provider-access-token' }), { status: 200 })
    if (String(url).endsWith('/contact/users/me')) return new Response(JSON.stringify({ unionId: 'verified_union', nick: 'Untrusted display name' }), { status: 200 })
    throw new Error('unexpected_provider_request')
  }
  const auth = createMobileAuth({ ...f.options, identityProvider: undefined, env: { ...env, DINGTALK_APP_KEY: 'web-credential-must-not-be-used', DINGTALK_APP_SECRET: 'web-secret-must-not-be-used' } })
  const challenge = await auth.challenge({ installationId: install, state, codeChallenge: await mobileDigest(verifier), platform: 'android', packageName: MOBILE_PACKAGE })
  const session = await auth.exchange({ challengeId: challenge.challengeId, state, codeVerifier: verifier, authCode: 'native-sdk-code' })
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.clientId, env.DINGTALK_MOBILE_CLIENT_ID)
  assert.equal(body.clientSecret, env.DINGTALK_MOBILE_CLIENT_SECRET)
  assert.equal(body.code, 'native-sdk-code'); assert.equal(calls.length, 2)
  assert.equal(session.user.nick, '固定昵称')
  assert.equal(calls.some(call => call.url.includes('sns/')), false)
})
test('native administrator sessions retain existing role and operation scope checks', async () => {
  const f = await setup(), session = await f.session()
  const app = createApp({ store: f.store, env, mobile: { atomicStore: f.atomicStore, identityProvider: f.identityProvider } })
  const request = () => app.request('/api/admin/site', { headers: { authorization: 'Bearer ' + session.accessToken } })
  assert.equal((await request()).status, 401)
  await f.store.put('meta:siteAdmins', [{ userId: 'u_native', role: 'admin' }])
  assert.equal((await request()).status, 200)
  await f.store.put('meta:siteAdmins', [])
  assert.equal((await request()).status, 401)
})
test('installation ownership, push capabilities and widget dorm/permission scopes are enforced', async () => {
  const f = await setup()
  const finishAt = new Date(Date.now() + 40 * 60000).toISOString()
  await f.store.put('user:u_other', { id: 'u_other', dormBuilding: 'liuyuan' })
  await f.store.put('machines:b1', { board: { floors: [{ code: '1F', machines: [{ id: 'machine_a', name: '一号洗衣机', dormBuilding: 'guiyuan', state: 'idle' }, { id: 'machine_b', name: '二号洗衣机', dormBuilding: 'liuyuan', state: 'idle' }] }] } })
  await f.store.put('tasks:u_native', [{ id: 'task_a', machineId: 'machine_a', endAt: finishAt, note: '公开备注', useDisinfectant: true }])
  await f.store.put('occupancy:b1', { machine_a: { userId: 'u_native', taskId: 'task_a' } })
  const app = createApp({ store: f.store, env: { ...env, MOBILE_PUSH_ENABLED: 'true' }, mobile: { atomicStore: f.atomicStore, pushProviders: ['fcm'] } })
  const token = await issueToken('u_native', env.AUTH_SECRET), otherToken = await issueToken('u_other', env.AUTH_SECRET)
  const request = (path, token, body) => app.request(path, { method: body ? 'PUT' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const installPath = '/api/mobile/installations/' + install, device = { provider: 'fcm', token: 'private-device-token-123456', notificationsEnabled: true, appVersion: '0.1.1' }
  const created = await request(installPath, token, device)
  assert.equal(created.status, 200); assert.ok(!JSON.stringify(await created.json()).includes(device.token))
  assert.equal((await request(installPath, otherToken)).status, 403)
  const snapshot = await (await request('/api/mobile/widget-snapshot', token)).json()
  assert.deepEqual(snapshot.machines.map(row => row.id), ['machine_a']); assert.equal(snapshot.tasks[0].useDisinfectant, true)
  assert.equal(snapshot.machines[0].state, 'occupied'); assert.equal(snapshot.machines[0].finishAt, finishAt)
  await f.store.put('access:user:u_native', { permissions: { board: { view: false, operate: false } } })
  const denied = await (await request('/api/mobile/widget-snapshot', token)).json()
  assert.deepEqual(denied.machines, []); assert.deepEqual(denied.tasks, [])
})
test('private bridge requires server credential, rejects arbitrary namespaces and never masks storage failure', async () => {
  const atomicStore = atomicFixture(), secret = 'internal-bridge-secret-32-characters-long'
  const handler = createMobileAtomicHttpHandler({ atomicStore, secret })
  const event = { httpMethod: 'POST', headers: { authorization: 'Bearer ' + secret }, body: JSON.stringify({ op: 'get', key: 'mobile:session:test' }) }
  assert.equal((await handler({ ...event, headers: {} })).statusCode, 401)
  assert.equal((await handler({ ...event, body: JSON.stringify({ op: 'get', key: 'user:u_native' }) })).statusCode, 400)
  const remote = createRemoteMobileAtomicStore({ MOBILE_ATOMIC_STORE_URL: 'https://store.example.org/atomic', MOBILE_ATOMIC_STORE_SECRET: secret }, async (_url, options) => {
    const result = await handler({ httpMethod: options.method, headers: options.headers, body: options.body })
    return new Response(result.body, { status: result.statusCode, headers: result.headers })
  })
  assert.equal(await remote.get('mobile:session:test'), null)
  assert.equal(await remote.compareAndSet('mobile:session:test', null, { test: true }, { expiresAt: Date.now() + 60000 }), true)
  assert.equal((await remote.get('mobile:session:test')).value.test, true)
  assert.equal(createRemoteMobileAtomicStore({ MOBILE_ATOMIC_STORE_URL: 'http://store.example.org/atomic', MOBILE_ATOMIC_STORE_SECRET: secret }), null)
  const broken = createRemoteMobileAtomicStore({ MOBILE_ATOMIC_STORE_URL: 'https://store.example.org/atomic', MOBILE_ATOMIC_STORE_SECRET: secret }, async () => new Response('{"ok":true}', { status: 200 }))
  await assert.rejects(broken.get('mobile:session:test'))
})
test('CloudBase adapter performs read/compare/write within one transaction and replaces expired rows atomically', async () => {
  const rows = new Map(); let at = Date.now(), transactions = 0
  const db = { async runTransaction(callback) { transactions++; return callback({ collection(name) { assert.equal(name, 'weshirt_mobile_sessions'); return { doc(id) { return { async get() { return { data: rows.get(id) || null } }, async set(value) { rows.set(id, value); return { updated: 1 } } } } } } }) } }
  const store = createCloudBaseMobileAtomicStore(db, { now: () => at })
  assert.equal(await store.compareAndSet('mobile:session:test', null, { safe: 1 }, { expiresAt: at + 1000 }), true)
  const row = await store.get('mobile:session:test')
  assert.equal(await store.compareAndSet('mobile:session:test', null, { safe: 2 }, { expiresAt: at + 1000 }), false)
  assert.equal(await store.compareAndSet('mobile:session:test', row.version, { safe: 3 }, { expiresAt: at + 1000 }), true)
  at += 1001
  assert.equal(await store.get('mobile:session:test'), null)
  assert.equal(await store.compareAndSet('mobile:session:test', null, { safe: 4 }, { expiresAt: at + 1000 }), true)
  assert.equal(transactions, 6)
})
