import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { assistantConfig, callAssistant } from '../packages/core/assistant.js'
import { createMemoryStore } from '../packages/core/store.js'
import { registerAssistantRoutes } from '../server/assistant.js'
import { registerRequestSafety } from '../server/request-safety.js'

const encode = new TextEncoder()
const sse = (data, line = '\r\n') => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${line}${line}`
const stream = body => new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
const json = data => new Response(JSON.stringify(data))
const output = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const responses = (...output) => ({ type: 'response.completed', response: { output } })
const responseDelta = delta => ({ type: 'response.output_text.delta', delta })
const completion = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] })
const anthropicStart = (index, content_block) => ({ type: 'content_block_start', index, content_block })
const anthropicDelta = (index, delta) => ({ type: 'content_block_delta', index, delta })
const anthropicStop = index => ({ type: 'content_block_stop', index })
const config = { enabled: true, model: 'fixture-model', apiKey: 'example-private-key', endpoint: 'https://provider.vendor.net/v1' }

// Break framing and UTF-8 code points across every conceivable chunk boundary.
function fragmentedProvider(events) {
  const input = encode.encode(events.map(event => sse(event)).join(''))
  let offset = 0
  return stream(new ReadableStream({
    pull(controller) {
      if (offset === input.length) controller.close()
      else controller.enqueue(input.subarray(offset, ++offset))
    },
  }))
}

test('Responses, Chat Completions and Anthropic stream visible deltas and continue read-only tools safely', async () => {
  const suffix = '有空闲洗衣机'
  const provisional = '查询前的草稿'
  const tool = { type: 'function_call', name: 'get_machine_status', call_id: 'tool1', arguments: '{"kind":"washer"}' }
  const fixtures = {
    responses: [[responseDelta(provisional), { type: 'response.reasoning_summary_text.delta', delta: 'private-thought' }, responses(tool)],
      [responseDelta('本楼'), responseDelta(suffix), responses(output('本楼' + suffix))]],
    'chat-completions': [[completion({ content: provisional, reasoning_content: 'private-thought' }),
      completion({ tool_calls: [{ index: 0, id: 'tool1', type: 'function', function: { name: 'get_machine_status', arguments: '{"kind":' } }] }),
      completion({ tool_calls: [{ index: 0, function: { arguments: '"washer"}' } }] }), completion({}, 'tool_calls'), '[DONE]'],
    [completion({ content: '本楼' }), completion({ content: suffix }), completion({}, 'stop'), '[DONE]']],
    anthropic: [[anthropicStart(0, { type: 'thinking', thinking: '' }),
      anthropicDelta(0, { type: 'thinking_delta', thinking: 'private-thought' }),
      anthropicDelta(0, { type: 'signature_delta', signature: 'signed' }), anthropicStop(0),
      anthropicStart(1, { type: 'text', text: provisional }), anthropicStop(1),
      anthropicStart(2, { type: 'tool_use', id: 'tool1', name: 'get_machine_status', input: {} }),
      anthropicDelta(2, { type: 'input_json_delta', partial_json: '{"kind":"washer"}' }), anthropicStop(2), { type: 'message_stop' }],
    [anthropicStart(0, { type: 'text', text: '' }), anthropicDelta(0, { type: 'text_delta', text: '本楼' }),
      anthropicDelta(0, { type: 'text_delta', text: suffix }), anthropicStop(0), { type: 'message_stop' }]],
  }
  for (const [protocol, rounds] of Object.entries(fixtures)) {
    const requests = [], received = [], queried = []
    const reply = await callAssistant({ config: assistantConfig({ ...config, protocol }), input: '查询洗衣机',
      onDelta: text => received.push(text), onReset: () => received.push('RESET'),
      getStatus: async kind => { queried.push(kind); return { idle: 2 } },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body)
        assert.equal(body.stream, true)
        assert.equal(options.redirect, 'error')
        assert.match(options.headers.Accept, /text\/event-stream/)
        requests.push(body)
        return fragmentedProvider(rounds[requests.length - 1])
      },
    })
    assert.equal(reply, '本楼' + suffix, protocol)
    assert.deepEqual(received, [provisional, 'RESET', '本楼', suffix], protocol)
    assert.deepEqual(queried, ['washer'], protocol)
    assert.match(JSON.stringify(requests[1]), /tool1/)
    if (protocol === 'anthropic') assert.match(JSON.stringify(requests[1]), /"signature":"signed"/)
  }
})

async function fixture(fetchImpl) {
  const store = createMemoryStore()
  await store.put('user:member', { id: 'member', dormBuilding: 'guiyuan' })
  const app = new Hono()
  const authenticate = c => c.req.header('x-test-user')
  registerRequestSafety(app, { store, authenticate })
  registerAssistantRoutes(app, { store, authenticate, checkAdmin: () => false, getBoard: async () => ({}), fetchImpl,
    env: { ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: config.model, ASSISTANT_API_KEY: config.apiKey } })
  const request = (user = 'member', input = '洗衣建议', path = '/api/assistant/chat/stream') => app.request(path, { method: 'POST',
    headers: { 'x-test-user': user, 'content-type': 'application/json', 'idempotency-key': 'fixture-idempotency' }, body: JSON.stringify({ input }) })
  return { store, request }
}

test('delivers the first delta before upstream closes and persists the canonical result only when complete', async (t) => {
  let upstream, streamBody
  const opened = new Promise(resolve => { streamBody = new ReadableStream({ start(output) { upstream = output; resolve() } }) })
  await opened
  const { store, request } = await fixture(async () => stream(streamBody))
  assert.equal((await request('invalid')).status, 401)
  assert.equal((await request('member', '')).status, 400)
  const response = await request()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.match(response.headers.get('cache-control'), /no-transform/)
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const decode = value => new TextDecoder().decode(value)
  assert.match(decode((await reader.read()).value), /^: connected/)
  upstream.enqueue(encode.encode(sse(responseDelta('第一段'))))
  assert.match(decode((await reader.read()).value), /event: delta\ndata: {"text":"第一段"}/)
  assert.equal(await store.get('assistant:history:member'), null)
  upstream.enqueue(encode.encode(sse(responseDelta('。')) + sse(responses(output('第一段。')))))
  upstream.close()
  assert.match(decode((await reader.read()).value), /event: delta/)
  await assert.doesNotReject(async () => {
    const event = decode((await reader.read()).value)
    assert.match(event, /^event: done/)
    const body = JSON.parse(event.split('\n')[1].slice(6))
    assert.equal(body.reply, '第一段。')
    assert.equal(body.usage.used, 1)
    assert.equal(body.messages[1].content, '第一段。')
  })
  assert.equal((await reader.read()).done, true)
  assert.equal((await store.get('assistant:history:member')).length, 2)
})

test('drops partial history and reports a tracked error if the provider disconnects before completion', async () => {
  const { store, request } = await fixture(async () => fragmentedProvider([responseDelta('未完成')]))
  const response = await request()
  const body = await response.text()
  assert.match(body, /event: delta/)
  assert.match(body, /event: error/)
  assert.match(body, new RegExp(response.headers.get('x-event-id')))
  assert.doesNotMatch(body, /event: done|example-private-key/)
  assert.equal(await store.get('assistant:history:member'), null)
})

test('cancelling a stream aborts upstream and releases the chat slot for a retry', async (t) => {
  let upstreamSignal, attempts = 0, notifyAbort
  const aborted = new Promise(resolve => { notifyAbort = resolve })
  const { store, request } = await fixture(async (_url, options) => {
    attempts++
    if (attempts > 1) return json({ output: [output('重试成功')] })
    upstreamSignal = options.signal
    upstreamSignal.addEventListener('abort', notifyAbort, { once: true })
    return stream(new ReadableStream({ start(output) { output.enqueue(encode.encode(sse(responseDelta('未完成')))) } }))
  })
  const reader = (await request()).body.getReader()
  t.after(() => reader.cancel())
  await reader.read()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: delta/)
  await reader.cancel()
  await aborted
  assert.equal(upstreamSignal.aborted, true)
  assert.equal(await store.get('assistant:history:member'), null)
  const retry = await request('member', '重试', '/api/assistant/chat')
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).reply, '重试成功')
})
