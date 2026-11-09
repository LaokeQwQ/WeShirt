import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createClientErrorReporter, newClientTraceId } from '../frontend/src/clientTrace.js'
import { createTelemetryClient } from '../frontend/src/telemetryClient.js'
import { telemetryEventId, telemetryErrorKind, normalizeTelemetryEvent, emptyTelemetryBucket, addTelemetry, summarizeTelemetry, telemetryRoute } from '../packages/core/telemetry.js'
import { createMemoryStore } from '../packages/core/store.js'
import { registerTelemetryRoutes } from '../server/telemetry.js'

test('同一个异常跨捕获入口只生成一条安全事件，冻结Error仍可去重', () => {
  const tracked = [], logs = []
  const report = createClientErrorReporter({ track: (...args) => tracked.push(args), logger: { error: (line) => logs.push(line) } })
  const error = Object.freeze(new TypeError('secret-token=https://private.example/?user=identity'))
  const trace = report(error, { kind: 'vue' })
  assert.match(trace.eventId, /^client_[a-f0-9]{24}$/)
  assert.equal(trace.status, 0)
  assert.equal(report(error), trace)
  assert.equal(report(error, { kind: 'UnhandledRejection' }), trace)
  assert.equal(tracked.length, 1)
  assert.equal(logs.length, 1)
  assert.deepEqual(Object.keys(tracked[0][1]).sort(), ['eventId', 'kind', 'status'])
  assert.match(logs[0], /^\[WeShirt client\] event=client_[a-f0-9]{24} status=0 kind=vue$/)
  assert.doesNotMatch(JSON.stringify({ tracked, logs }), /secret-token|private\.example|identity|stack|message/)
  assert.notEqual(report(new TypeError('same text')).eventId, trace.eventId)
})

test('API异常沿用合法事件ID与状态；敏感伪ID、异常类型和非法状态不进入日志', () => {
  const logs = [], events = []
  const report = createClientErrorReporter({ track: (_, fields) => events.push(fields), logger: { error: (line) => logs.push(line) } })
  const apiError = Object.assign(new Error('server content with token'), { eventId: 'evt_' + 'a'.repeat(24), status: 403 })
  assert.equal(report(apiError).eventId, apiError.eventId)
  assert.equal(events[0].status, 403)
  const bad = { eventId: 'sensitiveCredential123456', status: 99, name: 'https://secret.example/path?token=value' }
  const trace = report(bad)
  assert.match(trace.eventId, /^client_[a-f0-9]{24}$/)
  assert.equal(trace.status, 0)
  assert.equal(trace.kind, 'Error')
  assert.doesNotMatch(JSON.stringify({ logs, events }), /sensitiveCredential|secret\.example|token=value|server content/)
  assert.equal(telemetryEventId('evt_' + 'A'.repeat(24)), null)
  assert.equal(telemetryErrorKind('arbitrary name'), 'Error')
})

test('非Error rejection与资源事件不读取正文/URL，诊断自身失败也不会抛出', () => {
  const tracked = [], logs = [], identity = {}
  const report = createClientErrorReporter({ track: (_, fields) => tracked.push(fields), logger: { error: (line) => logs.push(line) } })
  const trace = report('private rejected text', { kind: 'UnhandledRejection', identity })
  assert.equal(report('private rejected text', { kind: 'UnhandledRejection', identity }), trace)
  const hostile = new Proxy({}, { get() { throw new Error('getter secret') }, set() { throw new Error('setter secret') } })
  assert.doesNotThrow(() => report(hostile))
  const broken = createClientErrorReporter({ enabled: () => { throw new Error('enabled secret') }, track: () => { throw new Error('track secret') }, logger: { error() { throw new Error('logger secret') } } })
  assert.doesNotThrow(() => broken(new Error('original secret')))
  assert.match(newClientTraceId(null), /^client_[a-f0-9]{24}$/)
  assert.doesNotMatch(JSON.stringify({ tracked, logs }), /private rejected text|getter secret|setter secret/)
})

test('遥测只传受限关联字段，状态0保留，非法状态回落0且recentErrors不保存任意内容', () => {
  const normalized = normalizeTelemetryEvent({ name: 'client_error', route: '/settings?token=secret', dorm: 'guiyuan', kind: 'ReferenceError', eventId: 'client_' + 'b'.repeat(24), status: 0, message: 'secret', stack: 'secret', userId: 'secret', url: 'https://private.example' })
  assert.deepEqual(normalized, { name: 'client_error', route: '/settings', dorm: 'guiyuan', kind: 'ReferenceError', eventId: 'client_' + 'b'.repeat(24), status: 0 })
  const bucket = emptyTelemetryBucket()
  addTelemetry(bucket, normalized, Date.now())
  const recent = summarizeTelemetry([bucket], 1).recentErrors[0]
  assert.deepEqual(Object.keys(recent).sort(), ['at', 'eventId', 'kind', 'route', 'status'])
  assert.equal(recent.eventId, normalized.eventId)
  assert.equal(recent.status, 0)
  const bad = normalizeTelemetryEvent({ ...normalized, eventId: 'secretCredential', status: Infinity })
  assert.equal(bad.eventId, undefined)
  assert.equal(bad.status, 0)
  assert.doesNotMatch(JSON.stringify(recent), /secret|private\.example|userId|stack/)
  const api = normalizeTelemetryEvent({ name: 'api_request', route: '/list', endpoint: '/api/machines', dorm: 'guiyuan', status: 0, durationMs: 20, eventId: normalized.eventId, message: 'secret' })
  addTelemetry(bucket, api, Date.now() + 1)
  assert.equal(summarizeTelemetry([bucket], 1).recentErrors[0].eventId, normalized.eventId)
  assert.equal(normalizeTelemetryEvent({ ...api, eventId: 'secretCredential' }).eventId, undefined)
})

test('window/Vue/rejection实际接线共享去重，遥测开关和DNT阻止上传且清队列', async () => {
  const source = await readFile(new URL('../frontend/src/telemetry.js', import.meta.url), 'utf8')
  const script = source.replace(/^import[^\n]*\n/gm, '').replace(/\bexport /g, '').replaceAll('import.meta.env.VITE_API_BASE', "''").replaceAll('import.meta.env.DEV', 'false')
  const handlers = {}, logs = [], sent = [], values = new Map()
  const win = { addEventListener: (type, callback) => { handlers[type] = callback } }
  const nav = { doNotTrack: '0' }
  const app = { config: {} }
  const router = { currentRoute: { value: { path: '/list' } }, afterEach() {}, isReady: async () => {} }
  const bindings = {
    createTelemetryClient: (options) => createTelemetryClient({ ...options, send: (body) => sent.push(body) }),
    createClientErrorReporter: (options) => createClientErrorReporter({ ...options, logger: { error: (line) => logs.push(line) } }),
    telemetryRoute, location: { hash: '#/list?token=secret' }, navigator: nav,
    localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    window: win, document: { addEventListener() {}, visibilityState: 'visible' }, setInterval() {},
  }
  const telemetry = new Function(...Object.keys(bindings), script + '\nreturn ({initTelemetry,setTelemetryEnabled,client})')(...Object.values(bindings))
  telemetry.initTelemetry({ router, getDorm: () => 'guiyuan', app })
  await Promise.resolve()
  const error = new TypeError('private runtime details')
  app.config.errorHandler(error)
  handlers.error({ error, target: win })
  handlers.unhandledrejection({ reason: error })
  const resource = { target: { src: 'https://secret.example/image?key=secret' } }
  handlers.error(resource)
  handlers.error(resource)
  await telemetry.client.flush()
  const events = sent.flatMap((batch) => batch.events).filter((event) => event.name === 'client_error')
  assert.equal(events.length, 2)
  assert.ok(events.every((event) => /^client_[a-f0-9]{24}$/.test(event.eventId) && event.status === 0))
  assert.equal(logs.length, 2)
  assert.doesNotMatch(JSON.stringify({ sent, logs }), /private runtime|secret\.example|key=secret/)
  telemetry.setTelemetryEnabled(false)
  handlers.unhandledrejection({ reason: new Error('disabled secret') })
  await telemetry.client.flush()
  assert.equal(sent.length, 1)
  telemetry.setTelemetryEnabled(true)
  handlers.error({ error: new Error('queued'), target: win })
  assert.equal(telemetry.client.pending, 1)
  nav.doNotTrack = '1'
  await telemetry.client.flush()
  assert.equal(telemetry.client.pending, 0)
  assert.equal(sent.length, 1)
})

test('遥测HTTP链路保存安全事件ID并在管理接口返回状态0', async () => {
  const store = createMemoryStore(), app = new Hono()
  registerTelemetryRoutes(app, { store, checkAdmin: (c) => c.req.header('x-admin-token') === 'local-admin' })
  const eventId = 'client_' + 'c'.repeat(24)
  const response = await app.request('/api/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ name: 'client_error', route: '/list?token=secret', dorm: 'guiyuan', eventId, status: 0, kind: 'vue', message: 'secret', stack: 'secret', userId: 'secret' }] }) })
  assert.equal(response.status, 202)
  const result = await app.request('/api/admin/telemetry?days=1', { headers: { 'x-admin-token': 'local-admin' } })
  const summary = await result.json()
  assert.equal(summary.recentErrors[0].eventId, eventId)
  assert.equal(summary.recentErrors[0].status, 0)
  assert.doesNotMatch(JSON.stringify(summary), /secret|message|stack|userId/)
})

test('后台错误面板编译通过并明确展示客户端0状态与事件关联', async () => {
  const source = await readFile(new URL('../frontend/src/components/AdminTelemetry.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'client-trace-admin' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'AdminTelemetry.vue', id: 'client-trace-admin', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  assert.match(source, /Number\.isInteger\(e\.status\)/)
  assert.match(source, /状态 0（客户端）/)
  assert.match(source, /\{\{ e\.eventId \}\}/)
  assert.equal(source.includes('v-html'), false)
})
