import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMemoryStore } from '../packages/core/store.js'
import { registerRequestSafety } from '../server/request-safety.js'

async function fixture({ handler, clock = () => Date.now() } = {}) {
  const store = createMemoryStore()
  for (const id of ['a', 'b']) await store.put('user:' + id, { id })
  const build = () => {
    const app = new Hono()
    registerRequestSafety(app, { store, now: clock, authenticate: (c) => store.get('user:' + c.req.header('x-user'), null) })
    if (handler) handler(app, store)
    return app
  }
  const app = build()
  const call = async (path, { user = 'a', key, body = {}, method = 'POST', target = app, headers: extra = {} } = {}) => {
    const headers = { 'content-type': 'application/json', ...extra }
    if (user) headers['x-user'] = user
    if (key) headers['Idempotency-Key'] = key
    const res = await target.request(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) })
    return { status: res.status, headers: res.headers, data: await res.json() }
  }
  return { store, app, build, call }
}

test('所有API返回事件ID；错误保留业务码/文案/状态且日志只有规范路由和可查eventId', async () => {
  const { call, store } = await fixture({ handler(app) {
    app.get('/api/ok', (c) => c.json({ ok: true }))
    app.get('/api/tasks/:id', (c) => c.json({ error: { code: 'not_found', message: '任务不存在' } }, 404))
  } })
  const ok = await call('/api/ok', { method: 'GET' })
  assert.match(ok.headers.get('x-event-id'), /^evt_[a-f0-9]{24}$/)
  const result = await call('/api/tasks/private-user-id?token=secret-query', { method: 'GET' })
  assert.equal(result.data.error.code, 'not_found')
  assert.equal(result.data.error.message, '任务不存在')
  assert.equal(result.data.error.status, 404)
  assert.equal(result.data.error.eventId, result.headers.get('x-event-id'))
  const logs = (await store.list('auditlog:')).flatMap((row) => row.value)
  assert.equal(logs[0].target, '/api/tasks/:id')
  assert.equal(logs[0].detail.eventId, result.data.error.eventId)
  for (const hidden of ['private-user-id', 'secret-query', 'token=', 'authorization']) assert.equal(JSON.stringify(logs).includes(hidden), false)
  const unknown = await call('/api/secret-in-unknown-path?secret=hidden', { method: 'GET' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.data.error.eventId, unknown.headers.get('x-event-id'))
  assert.equal(JSON.stringify(await store.list('auditlog:')).includes('secret-in-unknown-path'), false)
})

test('未捕获异常和手动internal500均泛化，诊断文本不进入响应、日志或重试cache', async () => {
  const secret = 'never-return-this-synthetic-private-value'
  const { call, store } = await fixture({ handler(app) {
    app.post('/api/throw', () => { throw new Error(secret) })
    app.post('/api/caught', (c) => c.json({ error: { code: 'internal', message: secret, stack: secret }, debug: secret }, 500))
  } })
  for (const path of ['/api/throw', '/api/caught']) {
    const result = await call(path, { key: 'same-error-key' })
    assert.equal(result.status, 500)
    assert.equal(result.data.error.status, 500)
    assert.equal(result.data.error.eventId, result.headers.get('x-event-id'))
    assert.equal(JSON.stringify(result.data).includes(secret), false)
  }
  assert.equal(JSON.stringify(await store.list('')).includes(secret), false)
})

test('同uid/method/path/key并发仅执行一次，后续跨app重放；不同body冲突409', async () => {
  let count = 0, enter, release
  const entered = new Promise((resolve) => { enter = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const { call, build } = await fixture({ handler(app) {
    app.post('/api/tasks', async (c) => { count++; await c.req.json(); enter(); await wait; return c.json({ task: { id: 'created-once' } }) })
  } })
  const first = call('/api/tasks', { key: 'submit-task-key', body: { machineId: 'one' } })
  await entered
  const second = call('/api/tasks', { key: 'submit-task-key', body: { machineId: 'one' }, target: build() })
  assert.equal((await call('/api/tasks', { key: 'submit-task-key', body: { machineId: 'different' } })).status, 409)
  release()
  const results = await Promise.all([first, second])
  assert.equal(count, 1)
  assert.equal(results.every((result) => result.data.task.id === 'created-once'), true)
  assert.notEqual(results[0].headers.get('x-event-id'), results[1].headers.get('x-event-id'))
  assert.equal(results[1].headers.get('idempotency-replayed'), 'true')
  const cached = await call('/api/tasks', { key: 'submit-task-key', body: { machineId: 'one' }, target: build() })
  assert.equal(cached.headers.get('idempotency-replayed'), 'true')
  assert.equal(count, 1)
})

test('用户/路径/查询隔离且短TTL后可执行，不同用户写入互不等待', async () => {
  let count = 0, clock = 1000000
  const { call } = await fixture({ clock: () => clock, handler(app) {
    app.post('/api/items/:id', (c) => c.json({ serial: ++count }))
  } })
  const opts = { key: 'isolation-key' }
  for (const args of [['/api/items/one', opts], ['/api/items/one', { ...opts, user: 'b' }], ['/api/items/two', opts], ['/api/items/one?mode=other', opts]]) assert.equal((await call(...args)).status, 200)
  assert.equal(count, 4)
  assert.equal((await call('/api/items/one', opts)).data.serial, 1)
  clock += 120001
  assert.equal((await call('/api/items/one', opts)).data.serial, 5)
})

test('角色撤销后不能从旧cache重放私有管理响应；上传排除而普通写体积受限', async () => {
  const { call, store } = await fixture({ handler(app, store) {
    app.post('/api/manage', async (c) => (await store.get('meta:siteAdmins', [])).some((row) => row.userId === c.req.header('x-user') && row.role === 'admin') ? c.json({ privateSetting: 'authorized-only' }) : c.json({ error: { code: 'forbidden', message: '没有权限' } }, 403))
    app.post('/api/inspections', (c) => c.json({ accepted: true }))
    app.post('/api/small', (c) => c.json({ ok: true }))
  } })
  await store.put('meta:siteAdmins', [{ userId: 'a', role: 'admin' }])
  assert.equal((await call('/api/manage', { key: 'auth-scope-key' })).status, 200)
  await store.put('meta:siteAdmins', [])
  const revoked = await call('/api/manage', { key: 'auth-scope-key' })
  assert.equal(revoked.status, 403)
  assert.equal(JSON.stringify(revoked.data).includes('authorized-only'), false)
  assert.equal((await call('/api/small', { key: 'large-json-key', body: { text: 'x'.repeat(65537) } })).status, 413)
  assert.equal((await call('/api/inspections', { key: 'photo-upload-key', body: { photoData: 'x'.repeat(70000) } })).status, 200)
})

test('个人权限撤销会失效旧去重cache，401续期后的同key请求可以重新鉴权', async () => {
  let allowAuth = false
  const { call, store } = await fixture({ handler(app, store) {
    app.post('/api/permission-write', async (c) => (await store.get('access:user:a', {})).allowed ? c.json({ privateResult: 'authorized' }) : c.json({ error: { code: 'forbidden', message: '权限已撤销' } }, 403))
    app.post('/api/needs-refresh', (c) => allowAuth ? c.json({ ok: true }) : c.json({ error: { code: 'unauthorized', message: '请续期' } }, 401))
  } })
  await store.put('access:user:a', { allowed: true })
  assert.equal((await call('/api/permission-write', { key: 'override-scope-key' })).status, 200)
  await store.put('access:user:a', { allowed: false })
  assert.equal((await call('/api/permission-write', { key: 'override-scope-key' })).status, 403)
  assert.equal((await call('/api/needs-refresh', { key: 'refresh-retain-key' })).status, 401)
  allowAuth = true
  assert.equal((await call('/api/needs-refresh', { key: 'refresh-retain-key' })).status, 200)
})
