import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const AUTH_SECRET = 'error-boundary-auth-test-secret'
const ADMIN_TOKEN = 'error-boundary-bootstrap-test'
const SENSITIVE = 'synthetic_private_key_DO_NOT_EXPOSE_47ac9f'
const PRIVATE_FRAME = 'synthetic-private-module/internal-connection.js'
const SAFE_MESSAGE = '服务暂时不可用，请稍后重试'
const failure = () => {
  const error = new Error(SENSITIVE)
  error.stack = `Error: ${SENSITIVE}\n    at ${PRIVATE_FRAME}:44:5`
  return error
}

async function fixture(t, extraEnv = {}) {
  const memory = createMemoryStore(), failures = new Set(), hits = new Map(), consoleLines = []
  // Clone on both sides: a route cannot accidentally mutate our injected
  // storage state or benefit from MemoryStore object identity.
  const store = {
    async get(key, fallback = null) {
      if (failures.has(key)) { hits.set(key, (hits.get(key) || 0) + 1); throw failure() }
      return structuredClone(await memory.get(key, fallback))
    },
    async put(key, value) { return memory.put(key, structuredClone(value)) },
    del: memory.del,
    async list(prefix) { return structuredClone(await memory.list(prefix)) },
  }
  for (const name of ['warn', 'error', 'log']) t.mock.method(console, name, (...args) => consoleLines.push(args.map((value) => value instanceof Error ? { message: value.message, stack: value.stack } : value)))
  t.mock.method(globalThis, 'fetch', async () => { throw failure() })
  const env = { AUTH_SECRET, ADMIN_TOKEN, BUILDING_ID: 'b1', HAIER_MODE: 'mock', SYNC_STALE_MS: 86400000, ...extraEnv }
  await store.put('user:student', { id: 'student', nick: '测试同学', avatar: 'av1', dormBuilding: 'guiyuan', notifyOn: false })
  await store.put('user:victim', { id: 'victim', nick: '另一同学', avatar: 'av2', dormBuilding: 'guiyuan' })
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('meta:sync', { lastAttemptAt: Date.now(), lastFetchAt: new Date().toISOString() })
  await store.put('machines:b1', { board: { buildingId: 'b1', updatedAt: new Date().toISOString(), floors: [{ code: '1', machines: [{ id: 'test-machine', name: '桂园测试机', dormBuilding: 'guiyuan', kind: 'washer', state: 'idle' }] }], total: 1, idle: 1 } })
  const token = await issueToken('student', AUTH_SECRET)
  const app = createApp({ store, env })
  const call = async (path, { admin = false, user = false, method = 'GET', body } = {}) => {
    const headers = { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': ADMIN_TOKEN } : {}), ...(user ? { authorization: 'Bearer ' + token } : {}) }
    const response = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, eventId: response.headers.get('X-Event-ID'), text, data: JSON.parse(text) }
  }
  const assertNoLeak = async (result) => {
    const serialized = JSON.stringify({ text: result.text, storage: await memory.list(''), console: consoleLines })
    assert.equal(serialized.includes(SENSITIVE), false, 'Exception message must never enter response, storage or console')
    assert.equal(serialized.includes(PRIVATE_FRAME), false, 'Exception stack must never enter response, storage or console')
  }
  const errorLogs = async () => (await memory.list('auditlog:')).flatMap((entry) => Array.isArray(entry.value) ? entry.value : []).filter((entry) => entry.type === 'error')
  return { call, store, failures, hits, assertNoLeak, errorLogs }
}

async function assertFailure(f, result, code = 'internal') {
  assert.equal(result.status, 500)
  assert.match(result.eventId, /^evt_[a-f0-9]{24}$/)
  assert.deepEqual(result.data, { error: { code, message: SAFE_MESSAGE, eventId: result.eventId, status: 500 } })
  const log = (await f.errorLogs()).find((entry) => entry.detail?.eventId === result.eventId)
  assert.ok(log, 'The response ID must identify a persisted safe error log')
  assert.equal(log.detail.status, result.status)
  await f.assertNoLeak(result)
}

for (const scenario of [
  { title: '公开看板', path: '/api/machines', key: 'faults:b1' },
  { title: '后台概览', path: '/api/admin/status', key: 'mapping:b1', admin: true },
  { title: '后台用户详情', path: '/api/admin/user/victim', key: 'user:victim', admin: true },
]) test(scenario.title + '存储异常只返回固定5xx，事件编号与脱敏日志一致', async (t) => {
  const f = await fixture(t)
  f.failures.add(scenario.key)
  const result = await f.call(scenario.path, { admin: scenario.admin })
  assert.ok(f.hits.get(scenario.key), 'The intended route storage access must actually fail')
  await assertFailure(f, result)
})

test('未被路由捕获的运行时配置异常也走同一固定错误边界', async (t) => {
  const f = await fixture(t)
  f.failures.add('meta:dingtalk')
  const result = await f.call('/api/health')
  assert.ok(f.hits.get('meta:dingtalk'))
  await assertFailure(f, result)
})

test('钉钉自检成功200中的嵌套网络失败不回显异常或栈', async (t) => {
  const f = await fixture(t, { DINGTALK_APP_KEY: 'synthetic-app', DINGTALK_APP_SECRET: 'synthetic-app-secret' })
  const result = await f.call('/api/debug/dingtalk', { admin: true })
  assert.equal(result.status, 200)
  assert.match(result.eventId, /^evt_[a-f0-9]{24}$/)
  assert.equal(result.data.oapi.ok, false)
  assert.equal(result.data.newApi.ok, false)
  assert.ok(result.data.oapi.err)
  assert.ok(result.data.newApi.err)
  await f.assertNoLeak(result)
})

test('上游诊断成功200中的逐端点异常不回显异常或栈', async (t) => {
  const f = await fixture(t, { HAIER_MODE: 'real', HAIER_URL: 'https://upstream.example', HAIER_POSITION_ID: '90001', HAIER_HEADERS: '{}', HAIER_TIMEOUT_MS: 20 })
  const result = await f.call('/api/admin/diag-haier', { admin: true })
  assert.equal(result.status, 200)
  assert.equal(result.data.steps.length, 3)
  assert.ok(result.data.steps.every((step) => step.error))
  await f.assertNoLeak(result)
})

test('用户通知自检的存储失败返回带事件的固定503', async (t) => {
  const f = await fixture(t)
  await f.store.put('user:student', {id:'student',nick:'测试同学',dormBuilding:'guiyuan',notifyOn:true})
  f.failures.add('subs')
  const result = await f.call('/api/user/test-notify', { user: true, method: 'POST', body: {channel:'web', endpoint:'https://fcm.googleapis.com/fcm/send/fixture'} })
  assert.equal(result.status, 503)
  assert.ok(f.hits.get('subs'))
  assert.equal(result.data.error.code, 'push_provider_unavailable')
  await f.assertNoLeak(result)
})

test('钉钉回调处理失败仍安全确认，持久诊断和控制台均不含异常原文', async (t) => {
  const f = await fixture(t)
  f.failures.add('userByDing:synthetic-callback-user')
  const result = await f.call('/api/dingtalk/callback', { method: 'POST', body: { senderStaffId: 'synthetic-callback-user', msgtype: 'text', conversationType: '1', text: { content: '帮助' } } })
  assert.equal(result.status, 200)
  assert.equal(result.data.errcode, 0)
  assert.ok(f.hits.get('userByDing:synthetic-callback-user'))
  const diagnostic = await f.store.get('ding:lastCallback')
  assert.equal(diagnostic.kind, 'handler_error')
  assert.ok(diagnostic.err)
  assert.equal(diagnostic.stack, undefined)
  await f.assertNoLeak(result)
})

test('预期输入校验4xx保留明确用户提示，同时关联错误事件与状态码', async (t) => {
  const f = await fixture(t)
  const result = await f.call('/api/machines?dorm=not-a-building')
  assert.equal(result.status, 400)
  assert.deepEqual(result.data.error, { code: 'bad_param', message: '住宿楼无效', eventId: result.eventId, status: 400 })
  assert.match(result.eventId, /^evt_[a-f0-9]{24}$/)
  assert.ok((await f.errorLogs()).some((entry) => entry.detail?.eventId === result.eventId && entry.detail?.status === 400))
  await f.assertNoLeak(result)
})
