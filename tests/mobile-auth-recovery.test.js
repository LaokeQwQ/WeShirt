import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMobileAuth, mobileDigest, MOBILE_PACKAGE, mobileAuthFailureDiagnostics, MobileError } from '../packages/core/mobile-auth.js'
import { createMemoryStore } from '../packages/core/store.js'
import { registerMobileRoutes } from '../server/mobile.js'
import { registerRequestSafety } from '../server/request-safety.js'

const env = { MOBILE_AUTH_ENABLED: 'true', DINGTALK_MOBILE_CLIENT_ID: 'test-native-client', DINGTALK_MOBILE_CLIENT_SECRET: 'test-only-native-secret-long-enough', DINGTALK_MOBILE_REDIRECT_URI: 'https://app.example/native' }
const verifier = 'V'.repeat(64), state = 'test_native_state_1234'
function atomicFixture(now = Date.now) {
  const records = new Map()
  return { consistency: 'linearizable', durable: true, records,
    async get(key) { const row = records.get(key); return row?.expiresAt > now() ? structuredClone({ version: row.version, value: row.value }) : null },
    async compareAndSet(key, version, value, { expiresAt }) {
      const row = records.get(key), current = row?.expiresAt > now() ? row : null
      if ((current?.version ?? null) !== version) return false
      records.set(key, { version: crypto.randomUUID(), value: structuredClone(value), expiresAt }); return true
    },
  }
}
async function fixture({ now = Date.now } = {}) {
  const atomicStore = atomicFixture(now), store = createMemoryStore()
  await store.put('userByUnionId:verified-test-union', 'u_test')
  await store.put('user:u_test', { id: 'u_test', dingUnionId: 'verified-test-union' })
  let exchanges = 0
  const options = { env, atomicStore, store, now, identityProvider: { async exchange() { exchanges++; return { unionId: 'verified-test-union' } } } }
  const auth = createMobileAuth(options)
  const createChallenge = async (installationId = 'test_installation_alpha') => auth.challenge({ installationId, state, codeChallenge: await mobileDigest(verifier), platform: 'android', packageName: MOBILE_PACKAGE })
  return { auth, options, atomicStore, store, createChallenge, exchanges: () => exchanges }
}
const exchangeBody = row => ({ challengeId: row.challengeId, state, codeVerifier: verifier, authCode: 'private-one-time-test-code' })
const authApp = f => {
  const app = new Hono()
  registerRequestSafety(app, { store: f.store })
  registerMobileRoutes(app, { store: f.store, env, auth: f.auth, atomicStore: f.atomicStore, authenticate: () => null })
  return app
}

test('twelve independent workers can exchange below the unchanged global limit without contention 503', async () => {
  const f = await fixture(), challenges = []
  for (let i = 0; i < 12; i++) challenges.push(await f.createChallenge('test_installation_' + String(i).padStart(3, '0')))
  const results = await Promise.allSettled(challenges.map(row => createMobileAuth(f.options).exchange({ challengeId: row.challengeId, state, codeVerifier: verifier, authCode: 'one-time-test-code-' + row.challengeId })))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 12, 'CAS contention must not be mistaken for an exhausted login quota')
  assert.equal(f.exchanges(), 12)
  const bucket = [...f.atomicStore.records].find(([key]) => key.startsWith('mobile:limit:exchange-global:'))[1]
  assert.equal(bucket.value.count, 12, 'every accepted exchange still consumes one global permit')
})

test('actual exhausted quota remains 429 and never consumes a challenge or calls the provider', async () => {
  const at = 1795000000000, f = await fixture({ now: () => at }), row = await f.createChallenge()
  const key = 'mobile:limit:exchange-global:' + Math.floor(at / 60000)
  f.atomicStore.records.set(key, { version: 'at-quota', value: { count: 120 }, expiresAt: at + 120000 })
  await assert.rejects(f.auth.exchange(exchangeBody(row)), { code: 'mobile_rate_limited', status: 429 })
  assert.equal(f.atomicStore.records.get(key).value.count, 120)
  assert.equal((await f.atomicStore.get('mobile:challenge:' + row.challengeId)).value.consumed, false)
  assert.equal(f.exchanges(), 0)
})

test('persistent limiter conflicts stop when the short recovery budget is spent', async () => {
  let at = 1795000000000, calls = 0
  const f = await fixture({ now: () => at })
  f.atomicStore.compareAndSet = async () => { calls++; at += 700; return false }
  await assert.rejects(f.createChallenge(), error => {
    assert.deepEqual(mobileAuthFailureDiagnostics(error), { stage: 'challenge_limit_global', category: 'mobile_cas_contention' })
    return error.status === 503 && error.code === 'mobile_busy'
  })
  assert.equal(calls, 3, 'the recovery budget stops further CAS attempts, even before the attempt cap')
  assert.equal(f.exchanges(), 0)
})

test('an uncertain limiter write is not retried as a contention conflict', async () => {
  const f = await fixture(), row = await f.createChallenge(), original = f.atomicStore.compareAndSet
  let calls = 0
  f.atomicStore.compareAndSet = async (...args) => {
    if (args[0].startsWith('mobile:limit:exchange-global:')) { calls++; throw Error('mobile_store_unavailable') }
    return original(...args)
  }
  await assert.rejects(f.auth.exchange(exchangeBody(row)), error => {
    assert.deepEqual(mobileAuthFailureDiagnostics(error), { stage: 'exchange_limit', category: 'mobile_store_unavailable' })
    return error.message === 'mobile_store_unavailable'
  })
  assert.equal(calls, 1)
  assert.equal(f.exchanges(), 0)
  assert.equal((await f.atomicStore.get('mobile:challenge:' + row.challengeId)).value.consumed, false)
})

test('a challenge consumption that commits before transport failure cannot exchange a code or revive on replay', async () => {
  const f = await fixture(), row = await f.createChallenge(), original = f.atomicStore.compareAndSet
  let writes = 0
  f.atomicStore.compareAndSet = async (...args) => {
    if (args[0] === 'mobile:challenge:' + row.challengeId) { writes++; await original(...args); throw Error('mobile_store_unavailable') }
    return original(...args)
  }
  await assert.rejects(f.auth.exchange(exchangeBody(row)), error => mobileAuthFailureDiagnostics(error)?.stage === 'exchange_challenge_consume')
  await assert.rejects(f.auth.exchange(exchangeBody(row)), { code: 'invalid_challenge', status: 400 })
  assert.equal(writes, 1)
  assert.equal(f.exchanges(), 0)
  assert.equal((await f.atomicStore.get('mobile:challenge:' + row.challengeId)).value.consumed, true)
})

test('a session write that commits before transport failure never repeats the provider exchange or session write', async () => {
  const f = await fixture(), row = await f.createChallenge(), original = f.atomicStore.compareAndSet
  let writes = 0
  f.atomicStore.compareAndSet = async (...args) => {
    if (args[0].startsWith('mobile:session:')) { writes++; await original(...args); throw Error('mobile_store_unavailable') }
    return original(...args)
  }
  await assert.rejects(f.auth.exchange(exchangeBody(row)), error => mobileAuthFailureDiagnostics(error)?.stage === 'exchange_session_save')
  await assert.rejects(f.auth.exchange(exchangeBody(row)), { code: 'invalid_challenge', status: 400 })
  assert.equal(f.exchanges(), 1)
  assert.equal(writes, 1)
})

test('exchange errors produce fixed stage and category in event-linked audit without exposing provider or credential data', async () => {
  for (const [stage, category] of [
    ['exchange_challenge_read', 'mobile_store_unavailable'],
    ['exchange_challenge_consume', 'mobile_store_unavailable'],
    ['exchange_identity', 'mobile_auth_unavailable'],
    ['exchange_account', 'site_store_unavailable'],
    ['exchange_session_save', 'mobile_store_unavailable'],
  ]) {
    const f = await fixture(), row = await f.createChallenge(), originalGet = f.atomicStore.get, originalCas = f.atomicStore.compareAndSet, originalUserGet = f.store.get
    f.atomicStore.get = async key => {
      if (stage === 'exchange_challenge_read' && key.startsWith('mobile:challenge:')) throw Error('mobile_store_unavailable')
      return originalGet(key)
    }
    f.atomicStore.compareAndSet = async (...args) => {
      if (stage === 'exchange_challenge_consume' && args[0].startsWith('mobile:challenge:') || stage === 'exchange_session_save' && args[0].startsWith('mobile:session:')) throw Error('mobile_store_unavailable')
      return originalCas(...args)
    }
    if (stage === 'exchange_identity') f.options.identityProvider.exchange = async () => { throw Error('private-provider-body-and-secret') }
    if (stage === 'exchange_account') f.store.get = async (...args) => {
      if (args[0].startsWith('userByUnionId:')) throw Object.assign(Error('private-provider-body-and-secret'), { code: 'site_store_unavailable' })
      return originalUserGet(...args)
    }
    const result = await authApp(f).request('/api/mobile/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exchangeBody(row)) })
    const body = await result.json(), logs = (await f.store.list('auditlog:')).flatMap(row => row.value)
    assert.equal(result.status, 503, stage)
    assert.equal(body.error.code, 'mobile_unavailable')
    assert.equal(body.error.eventId, result.headers.get('X-Event-ID'))
    assert.equal(body.error.status, 503)
    assert.equal(body.error.authStage, undefined, 'implementation stages stay in private audit')
    assert.equal(logs.length, 1)
    assert.equal(logs[0].detail.eventId, body.error.eventId)
    assert.equal(logs[0].detail.authStage, stage)
    assert.equal(logs[0].detail.failureCategory, category)
    const exposed = JSON.stringify([body, logs])
    for (const hidden of ['private-provider-body-and-secret', exchangeBody(row).authCode, verifier, state, 'verified-test-union', row.challengeId]) assert.equal(exposed.includes(hidden), false)
  }
})

test('known provider rejection keeps its status and code with a safe exchange stage', async () => {
  const f = await fixture(), row = await f.createChallenge()
  f.options.identityProvider.exchange = async () => { throw new MobileError('mobile_identity_unavailable', '身份服务不可用', 502) }
  const result = await authApp(f).request('/api/mobile/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exchangeBody(row)) })
  const body = await result.json(), logs = (await f.store.list('auditlog:')).flatMap(row => row.value)
  assert.equal(result.status, 502)
  assert.equal(body.error.code, 'mobile_identity_unavailable')
  assert.equal(logs[0].detail.authStage, 'exchange_identity')
  assert.equal(logs[0].detail.failureCategory, 'mobile_auth_rejected')
  await assert.rejects(f.auth.exchange(exchangeBody(row)), { code: 'invalid_challenge', status: 400 })
})

test('refresh rotation failure exposes its audit stage without repeating an uncertain credential rotation', async () => {
  const f = await fixture(), row = await f.createChallenge(), session = await f.auth.exchange(exchangeBody(row)), original = f.atomicStore.compareAndSet
  let rotations = 0
  f.atomicStore.compareAndSet = async (...args) => {
    if (args[0].startsWith('mobile:session:')) { rotations++; await original(...args); throw Error('mobile_store_unavailable') }
    return original(...args)
  }
  const result = await authApp(f).request('/api/mobile/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId: 'test_installation_alpha', refreshToken: session.refreshToken }) })
  const body = await result.json(), logs = (await f.store.list('auditlog:')).flatMap(row => row.value)
  assert.equal(result.status, 503)
  assert.equal(body.error.eventId, logs[0].detail.eventId)
  assert.equal(logs[0].detail.authStage, 'refresh_session_rotate')
  assert.equal(rotations, 1)
  await assert.rejects(f.auth.refresh({ installationId: 'test_installation_alpha', refreshToken: session.refreshToken }), { code: 'invalid_refresh_token', status: 401 })
  assert.equal(rotations, 1)
  assert.equal(JSON.stringify([body, logs]).includes(session.refreshToken), false)
})
