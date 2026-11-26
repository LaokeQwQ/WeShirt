import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSingleFlight } from '../frontend/src/loginFlow.js'
import { readAssistantEvents } from '../frontend/src/assistantStream.js'

async function frontend(fetch, track = () => {}) {
  const source = await readFile(new URL('../frontend/src/api.js', import.meta.url), 'utf8')
  const map = new Map([['ws_token', 'initial-user-token']])
  const localStorage = { getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
  const body = source.replace(/^import[^\n]*\n/gm, '').replace(/import\.meta\.env\.VITE_API_BASE/g, "''").replace(/import\.meta\.env\.DEV/g, 'false').replace(/^export\s+(?=(?:async\s+)?function|const)/gm, '').replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
  return new Function('fetch', 'localStorage', 'createSingleFlight', 'readAssistantEvents', 'track', 'getTelemetryContext', body + '\nreturn { api, claimCode, startDingLogin, setToken, onNeedLogin, streamAssistantChat, NEED_LOGIN }')(fetch, localStorage, createSingleFlight, readAssistantEvents, track, () => ({}))
}
const reply = (data, status = 200, eventId = 'evt_1234567890abcdef12345678') => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Event-ID': eventId } })

const textEncoder = new TextEncoder()
const eventId = 'evt_1234567890abcdef12345678'
const sse = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`
const eventReply = body => new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Event-ID': eventId } })
const completedTurn = { reply: '最终回答', messages: [{ role: 'assistant', content: '最终回答', at: '2026-11-26T00:00:00.000Z' }], usage: { dailyRemaining: 3 }, context: {} }

test('助手只发一次已鉴权 POST，收到分片后立即更新，终态以 done 为准', async () => {
  const controller = new AbortController(), chunks = []
  let writer, fetches = 0, acceptDelta
  const receivedFirst = new Promise(resolve => { acceptDelta = resolve })
  const upstream = new ReadableStream({ start(output) { writer = output } })
  const client = await frontend(async (path, options) => {
    fetches++
    assert.equal(path, '/api/assistant/chat/stream')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer initial-user-token')
    assert.equal(options.headers['Idempotency-Key'], undefined)
    return eventReply(upstream)
  })
  const result = client.streamAssistantChat({ input: '洗衣建议' }, { signal: controller.signal,
    onDelta: text => { chunks.push(text); acceptDelta() }, onReset: () => chunks.push('RESET') })
  const first = textEncoder.encode(sse('delta', { text: '草稿' }))
  for (const byte of first) writer.enqueue(Uint8Array.of(byte))
  await receivedFirst
  assert.deepEqual(chunks, ['草稿'])
  writer.enqueue(textEncoder.encode(sse('reset', {}) + sse('delta', { text: '最终' }) + sse('done', completedTurn)))
  writer.close()
  assert.deepEqual(await result, completedTurn)
  assert.deepEqual(chunks, ['草稿', 'RESET', '最终'])
  assert.equal(fetches, 1)
})

test('流式请求遇到登录失效不会自动重发，截断不能被当成完成', async () => {
  const controller = new AbortController(), deltas = []
  const options = { signal: controller.signal, onDelta: text => deltas.push(text), onReset: () => {} }
  let requests = 0
  const denied = await frontend(async () => { requests++; return reply({ error: { code: 'unauthorized', message: '请先登录' } }, 401) })
  await assert.rejects(() => denied.streamAssistantChat({ input: 'question' }, options), { status: 401, eventId })
  assert.equal(requests, 1)

  const truncated = await frontend(async () => eventReply(sse('delta', { text: '半截' })))
  await assert.rejects(() => truncated.streamAssistantChat({ input: 'question' }, options), { code: 'stream_interrupted', eventId })
  assert.deepEqual(deltas, ['半截'])

  const failure = await frontend(async () => eventReply(sse('error', { error: { status: 429, code: 'rate_limit', message: '请稍后重试' } })))
  await assert.rejects(() => failure.streamAssistantChat({ input: 'question' }, options), { code: 'rate_limit', status: 429, eventId })
})

test('停止流式回答会取消连接，即使网络层未主动取消读流', async () => {
  const controller = new AbortController()
  let sentSignal, cancelled = false
  const client = await frontend(async (_path, options) => {
    sentSignal = options.signal
    return eventReply(new ReadableStream({
      start(output) { output.enqueue(textEncoder.encode(sse('delta', { text: '半截' }))) },
      cancel() { cancelled = true },
    }))
  })
  await assert.rejects(() => client.streamAssistantChat({ input: 'question' }, { signal: controller.signal,
    onDelta: () => controller.abort(), onReset: () => {} }), { name: 'AbortError' })
  assert.equal(sentSignal.aborted, true)
  assert.equal(cancelled, true)
})

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
