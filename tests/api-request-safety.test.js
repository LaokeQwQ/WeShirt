import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSingleFlight } from '../frontend/src/loginFlow.js'

async function frontend(fetch, track = () => {}) {
  const source = await readFile(new URL('../frontend/src/api.js', import.meta.url), 'utf8')
  const map = new Map([['ws_token', 'initial-user-token']])
  const localStorage = { getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
  const body = source.replace(/^import[^\n]*\n/gm, '').replace(/import\.meta\.env\.VITE_API_BASE/g, "''").replace(/import\.meta\.env\.DEV/g, 'false').replace(/^export\s+(?=(?:async\s+)?function|const)/gm, '').replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
  return new Function('fetch', 'localStorage', 'createSingleFlight', 'track', 'getTelemetryContext', body + '\nreturn { api, claimCode, startDingLogin, setToken, onNeedLogin, NEED_LOGIN }')(fetch, localStorage, createSingleFlight, track, () => ({}))
}
const reply = (data, status = 200, eventId = 'evt_1234567890abcdef12345678') => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Event-ID': eventId } })

test('dynamic API reads bypass browser response storage even when the old endpoint advertised stale caching', async () => {
  const client = await frontend(async (_url, options) => { assert.equal(options.cache, 'no-store'); return reply({ board: { floors: [] } }) })
  await client.api('/api/machines', { auth: false })
})

test('被页面捕获的网络错误仍将同一事件ID传给遥测；非法服务端标识不会回显', async () => {
  const records = []
  const client = await frontend(async () => { throw new Error('private network configuration') }, (name, fields) => records.push({ name, fields }))
  let failure
  try { await client.api('/api/machines') } catch (error) { failure = error }
  assert.match(failure.eventId, /^client_[a-f0-9]{24}$/)
  assert.equal(records[0].name, 'api_request')
  assert.equal(records[0].fields.eventId, failure.eventId)
  assert.equal(records[0].fields.status, 0)
  const invalid = await frontend(async () => reply({ error: { message: '失败' } }, 403, 'private-key-do-not-echo'))
  await assert.rejects(() => invalid.api('/api/machines'), error => {
    assert.match(error.eventId, /^client_[a-f0-9]{24}$/)
    assert.equal(error.message.includes('private-key'), false)
    return true
  })
})

test('前端HTTP错误保留status/code/eventId且展示简短追踪码，不把query或body拼到消息', async () => {
  const client = await frontend(async () => reply({ error: { code: 'bad_param', message: '内容无效', eventId: 'evt_1234567890abcdef12345678', status: 400 } }, 400))
  await assert.rejects(() => client.api('/api/tasks?private=secret-query', { method: 'POST', body: { note: 'private-body' } }), (error) => {
    assert.equal(error.status, 400)
    assert.equal(error.code, 'bad_param')
    assert.equal(error.eventId, 'evt_1234567890abcdef12345678')
    assert.match(error.message, /HTTP 400.*evt_1234567890abcdef12345678/)
    assert.equal(error.message.includes('secret-query'), false)
    assert.equal(error.message.includes('private-body'), false)
    return true
  })
})

test('双击相同写请求共享flight；401续用后重试保同Idempotency-Key', async () => {
  let release, calls = 0
  const delayed = new Promise((resolve) => { release = resolve })
  const keys = []
  const client = await frontend(async (url, options) => {
    if (url === '/api/auth') return reply({ token: 'renewed-token', user: { id: 'same-user' } })
    calls++; keys.push(options.headers['Idempotency-Key'])
    if (calls === 1) { await delayed; return reply({ error: { code: 'unauthorized', message: '登录过期' } }, 401) }
    return reply({ task: { id: 'once' } })
  })
  const a = client.api('/api/tasks', { method: 'POST', body: { machineId: 'one' } })
  const b = client.api('/api/tasks', { method: 'POST', body: { machineId: 'one' } })
  release()
  const results = await Promise.all([a, b])
  assert.equal(calls, 2, 'one initial request plus its authenticated retry')
  assert.equal(results.every((result) => result.task.id === 'once'), true)
  assert.ok(keys[0])
  assert.equal(keys[0], keys[1])
})

test('网络异常用client事件和status0；相同手工重试保key，成功后新操作生成新key', async () => {
  const keys = []
  const client = await frontend(async (_url, options) => {
    keys.push(options.headers['Idempotency-Key'])
    if (keys.length === 1) throw new TypeError('sensitive network details')
    return reply({ ok: true })
  })
  await assert.rejects(() => client.api('/api/tasks', { method: 'POST', body: { machineId: 'one' } }), (error) => {
    assert.equal(error.status, 0)
    assert.equal(error.code, 'network_error')
    assert.match(error.eventId, /^client_/)
    assert.equal(error.idempotencyKey, keys[0])
    assert.equal(error.message.includes('sensitive'), false)
    return true
  })
  await client.api('/api/tasks', { method: 'POST', body: { machineId: 'one' } })
  await client.api('/api/tasks', { method: 'POST', body: { machineId: 'one' } })
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[1], keys[2])
})

test('上传不自动加去重key；登录信号兼容NEED_LOGIN且仍带HTTP追踪属性', async () => {
  let key, login = 0
  const client = await frontend(async (_url, options) => { key = options.headers['Idempotency-Key']; return reply({ error: { code: 'need_login', message: '请先登录' } }, 401) })
  client.onNeedLogin(() => { login++ })
  await assert.rejects(() => client.api('/api/inspections', { method: 'POST', retry: false, body: { photoData: 'data:image/png' } }), (error) => {
    assert.equal(error.message, client.NEED_LOGIN)
    assert.equal(error.status, 401)
    assert.equal(error.eventId, 'evt_1234567890abcdef12345678')
    assert.equal(error.code, 'need_login')
    return true
  })
  assert.equal(login, 1)
  assert.equal(key, undefined)
})

test('调用方小写Idempotency-Key头被保留为单个规范头，不合并为非法重复值', async () => {
  let seen
  const client = await frontend(async (_url, options) => { seen = new Headers(options.headers); return reply({ ok: true }) })
  await client.api('/api/tasks', { method: 'POST', headers: { 'idempotency-key': 'explicit-test-request' }, body: { machineId: 'one' } })
  assert.equal(seen.get('idempotency-key'), 'explicit-test-request')
})
