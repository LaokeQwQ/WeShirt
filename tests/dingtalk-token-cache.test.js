import test from 'node:test'
import assert from 'node:assert/strict'

const config = (suffix, secret = 'secret-' + suffix) => ({ DINGTALK_APP_KEY: 'key-' + suffix, DINGTALK_APP_SECRET: secret, DINGTALK_ROBOT_CODE: 'robot-' + suffix })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
async function isolated() { return import(new URL('../packages/core/dingtalk.js?test=' + crypto.randomUUID(), import.meta.url)) }
function mock(t, handler) { t.mock.method(globalThis, 'fetch', handler) }

test('new and legacy tokens stay bound to both app key and secret through application switches and key rotation', async (t) => {
  const { createDingTalk } = await isolated()
  const oldGrants = [], newGrants = [], sends = []
  mock(t, async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/gettoken') {
      const key = parsed.searchParams.get('appkey'), secret = parsed.searchParams.get('appsecret')
      oldGrants.push([key, secret]); return json({ errcode: 0, access_token: 'old:' + key + ':' + secret })
    }
    if (parsed.pathname.endsWith('/oauth2/accessToken')) {
      const body = JSON.parse(options.body); newGrants.push([body.appKey, body.appSecret]); return json({ accessToken: 'new:' + body.appKey + ':' + body.appSecret, expireIn: 7200 })
    }
    if (parsed.pathname.endsWith('/oToMessages/batchSend')) { sends.push({ robot: JSON.parse(options.body).robotCode, token: options.headers['x-acs-dingtalk-access-token'] }); return json({}) }
    throw new Error('Unexpected mocked endpoint')
  })
  const a = config('A'), b = config('B'), rotated = config('A', 'rotated-secret')
  for (const env of [a, b, rotated, a, b]) {
    const client = createDingTalk(env)
    assert.equal(await client.getToken(), 'old:' + env.DINGTALK_APP_KEY + ':' + env.DINGTALK_APP_SECRET)
    assert.equal((await client.sendSingle('mock-user', 'mock')).ok, true)
  }
  assert.equal(oldGrants.length, 3)
  assert.equal(newGrants.length, 3)
  assert.deepEqual(sends.map((item) => item.token), [a, b, rotated, a, b].map((env) => 'new:' + env.DINGTALK_APP_KEY + ':' + env.DINGTALK_APP_SECRET))
  const sharedApplication = createDingTalk({ ...a, DINGTALK_ROBOT_CODE: 'another-robot-on-A' })
  await sharedApplication.sendSingle('mock-user', 'mock')
  assert.equal(newGrants.length, 3, 'tokens belong to the application, not an individual robot')
  assert.equal(sends.at(-1).robot, 'another-robot-on-A')
})

test('concurrent clients with identical credentials share a single in-flight grant for each API generation', async (t) => {
  const { createDingTalk } = await isolated()
  const env = config('concurrent'), grants = { old: 0, modern: 0 }
  let releaseOld, releaseModern
  const oldGate = new Promise((resolve) => { releaseOld = resolve }), modernGate = new Promise((resolve) => { releaseModern = resolve })
  mock(t, async (url) => {
    if (new URL(url).pathname === '/gettoken') { grants.old++; await oldGate; return json({ errcode: 0, access_token: 'old-token' }) }
    if (String(url).endsWith('/oauth2/accessToken')) { grants.modern++; await modernGate; return json({ accessToken: 'modern-token', expireIn: 7200 }) }
    if (String(url).endsWith('/oToMessages/batchSend')) return json({})
    throw new Error('Unexpected mocked endpoint')
  })
  const old = Array.from({ length: 20 }, () => createDingTalk(env).getToken())
  const modern = Array.from({ length: 20 }, () => createDingTalk(env).sendSingle('mock-user', 'mock'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(grants, { old: 1, modern: 1 })
  releaseOld(); releaseModern()
  assert.equal((await Promise.all(old)).every((token) => token === 'old-token'), true)
  assert.equal((await Promise.all(modern)).every((result) => result.ok), true)
})

test('failed modern grants use only the matching legacy token and failures do not poison later retries or logs', async (t) => {
  const { createDingTalk } = await isolated()
  let legacyCalls = 0, modernCalls = 0, failModern = true, failLegacy = true
  const used = [], logs = []
  t.mock.method(console, 'warn', (...values) => logs.push(values.join(' ')))
  mock(t, async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/gettoken') {
      legacyCalls++
      if (failLegacy) return json({ errcode: 400, errmsg: 'secret-A access_token=SHOULD_NOT_LOG' }, 500)
      return json({ errcode: 0, access_token: 'legacy-' + parsed.searchParams.get('appkey') })
    }
    if (parsed.pathname.endsWith('/oauth2/accessToken')) {
      modernCalls++
      if (failModern) return json({ message: 'secret-A access_token=SHOULD_NOT_LOG' }, 500)
      return json({ accessToken: 'restored-modern-token', expireIn: 7200 })
    }
    if (parsed.pathname.endsWith('/oToMessages/batchSend')) { used.push(options.headers['x-acs-dingtalk-access-token']); return json({}) }
    throw new Error('Unexpected mocked endpoint')
  })
  assert.equal((await createDingTalk(config('A')).sendSingle('mock-user', 'mock')).ok, false)
  failLegacy = false
  assert.equal((await createDingTalk(config('A')).sendSingle('mock-user', 'mock')).ok, true)
  assert.equal((await createDingTalk(config('B')).sendSingle('mock-user', 'mock')).ok, true)
  assert.deepEqual(used, ['legacy-key-A', 'legacy-key-B'])
  failModern = false
  await createDingTalk(config('A')).sendSingle('mock-user', 'mock')
  assert.equal(used.at(-1), 'restored-modern-token')
  assert.equal(legacyCalls, 3)
  assert.equal(modernCalls, 4)
  assert.equal(logs.some((line) => /secret-A|SHOULD_NOT_LOG|legacy-key|restored-modern/.test(line)), false)
})

test('expired grants refresh, failed refreshes remain retryable, and mutating a caller config cannot change an existing client grant', async (t) => {
  const { createDingTalk } = await isolated()
  let clock = 1000000, legacy = 0, modern = 0
  const credentials = []
  t.mock.method(Date, 'now', () => clock)
  mock(t, async (url, options = {}) => {
    if (new URL(url).pathname === '/gettoken') { legacy++; credentials.push(new URL(url).searchParams.get('appsecret')); return json({ errcode: 0, access_token: 'old-' + legacy, expires_in: 2 }) }
    if (String(url).endsWith('/oauth2/accessToken')) { modern++; credentials.push(JSON.parse(options.body).appSecret); return json({ accessToken: 'new-' + modern, expireIn: 2 }) }
    if (String(url).endsWith('/oToMessages/batchSend')) return json({})
    throw new Error('Unexpected mocked endpoint')
  })
  const env = config('expires'), client = createDingTalk(env)
  env.DINGTALK_APP_SECRET = 'caller-mutated-secret'
  assert.equal(await client.getToken(), 'old-1'); await client.sendSingle('mock-user', 'mock')
  clock += 1000
  assert.equal(await client.getToken(), 'old-1'); await client.sendSingle('mock-user', 'mock')
  assert.deepEqual([legacy, modern], [1, 1])
  clock += 1000
  assert.equal(await client.getToken(), 'old-2'); await client.sendSingle('mock-user', 'mock')
  assert.deepEqual([legacy, modern], [2, 2])
  assert.equal(credentials.every((value) => value === 'secret-expires'), true)
})

test('repeated credential rotation evicts old token entries and bounds simultaneous grants without losing same-config deduplication', async (t) => {
  const { createDingTalk } = await isolated()
  const legacyCalls = new Map(), modernCalls = new Map()
  let active = 0, peak = 0
  mock(t, async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/gettoken' || parsed.pathname.endsWith('/oauth2/accessToken')) {
      const legacy = parsed.pathname === '/gettoken'
      const key = legacy ? parsed.searchParams.get('appkey') : JSON.parse(options.body).appKey
      const counts = legacy ? legacyCalls : modernCalls
      counts.set(key, (counts.get(key) || 0) + 1)
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active--
      return legacy ? json({ errcode: 0, access_token: 'old-' + key }) : json({ accessToken: 'new-' + key, expireIn: 7200 })
    }
    if (parsed.pathname.endsWith('/oToMessages/batchSend')) return json({})
    throw new Error('Unexpected mocked endpoint')
  })
  for (let i = 0; i < 40; i++) {
    const client = createDingTalk(config('rotate-' + i))
    await client.getToken(); await client.sendSingle('mock-user', 'mock')
  }
  await createDingTalk(config('rotate-0')).getToken()
  await createDingTalk(config('rotate-0')).sendSingle('mock-user', 'mock')
  assert.equal(legacyCalls.get('key-rotate-0'), 2)
  assert.equal(modernCalls.get('key-rotate-0'), 2)
  active = 0; peak = 0
  const requests = Array.from({ length: 32 }, (_, i) => createDingTalk(config('parallel-' + i)).getToken())
  requests.push(createDingTalk(config('parallel-0')).getToken())
  await Promise.all(requests)
  assert.equal(legacyCalls.get('key-parallel-0'), 1)
  assert.ok(peak <= 16, 'all-pending token slots apply backpressure rather than growing a global cache')
})
