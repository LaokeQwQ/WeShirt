import test from 'node:test'
import assert from 'node:assert/strict'
import { ASSISTANT_LIMITS, assistantConfig, patchAssistantConfig, publicAssistantConfig, normalizeEndpoint, isPublicHost, validateSkill, beijingDay, memoryHabits, pruneHistory, machineStatus, callAssistant } from '../packages/core/assistant.js'

const config = { enabled: true, endpoint: 'https://api.openai.com/v1/responses', model: 'mock-model', apiKey: 'secret-key' }
const textResponse = (text = '目前有空闲机器') => new Response(JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }), { headers: { 'content-type': 'application/json' } })
const callResponse = (extra = {}) => new Response(JSON.stringify({ output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'function_call', call_id: 'call_123', name: 'get_machine_status', arguments: '{"kind":"all"}', ...extra }] }))

test('Responses endpoint supports base/full URLs and denies local, private, credential and redirect URL forms', () => {
  assert.equal(normalizeEndpoint('https://api.openai.com/v1/'), config.endpoint)
  assert.equal(normalizeEndpoint(config.endpoint), config.endpoint)
  for (const endpoint of ['http://api.openai.com', 'https://localhost', 'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://10.1.1.1', 'https://172.31.1.1', 'https://169.254.169.254', 'https://192.168.1.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fc00::1]', 'https://metadata.google.internal', 'https://myhost.local', 'https://user:pw@api.openai.com/v1', 'https://api.openai.com:8443', 'https://api.openai.com/v1?key=hidden']) assert.throws(() => normalizeEndpoint(endpoint), undefined, endpoint)
  assert.equal(isPublicHost('8.8.8.8'), true)
  assert.equal(isPublicHost('2606:4700:4700::1111'), true)
  assert.equal(isPublicHost('2001:db8::1'), false)
})

test('configuration defaults closed and never serializes keys into admin/public result', () => {
  assert.equal(publicAssistantConfig(assistantConfig()).ready, false)
  const old = { ...config, dailyLimit: 20, minuteLimit: 3 }
  const next = patchAssistantConfig(old, { model: 'other', apiKey: '' })
  assert.equal(next.apiKey, old.apiKey)
  assert.equal(JSON.stringify(publicAssistantConfig(next)).includes('secret-key'), false)
  assert.throws(() => patchAssistantConfig(old, { dailyLimit: 10001 }))
  assert.throws(() => patchAssistantConfig(old, { minuteLimit: 31 }))
  assert.throws(() => patchAssistantConfig(old, { endpoint: 'https://localhost' }))
  assert.equal(old.model, 'mock-model')
})

test('skills are bounded inert text; extra executable metadata never survives normalization', () => {
  const skill = validateSkill({ title: '我的洗护', description: '', prompt: '按照衣物标签安排', command: 'execute()', tools: ['send_message'] })
  assert.deepEqual(Object.keys(skill), ['title', 'description', 'prompt'])
  assert.throws(() => validateSkill({ title: 'x', prompt: 'x'.repeat(1501) }))
})

test('history expires after 14 days, strips extra fields and keeps at most 256 messages', () => {
  const now = Date.now()
  const rows = Array.from({ length: 270 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i), at: new Date(now - i * 1000).toISOString(), secret: 'no' }))
  rows.unshift({ role: 'user', content: 'expired', at: new Date(now - 15 * 86400000).toISOString() })
  const history = pruneHistory(rows, now)
  assert.equal(history.length, 256)
  assert.equal(history[0].content, '14')
  assert.equal(JSON.stringify(history).includes('secret'), false)
})

test('habit hours and daily quota date use Beijing timezone and respect forget cutoff', () => {
  const now = Date.parse('2026-11-09T13:00:00Z')
  assert.equal(beijingDay(Date.parse('2026-11-08T16:01:00Z')), '2026-11-09')
  const tasks = [{ kind: 'washer', startAt: '2026-11-08T13:00:00Z' }, { kind: 'dryer', startAt: '2026-11-08T14:00:00Z' }, { startAt: '2026-10-01T13:00:00Z' }]
  assert.deepEqual(memoryHabits(tasks, now), { count: 1, commonHours: [21] })
  assert.deepEqual(memoryHabits(tasks, now, now), { count: 0, commonHours: [] })
})

test('machine tool strips occupancy/user data and keeps only bound dorm with mapping authoritative', () => {
  const board = { updatedAt: '2026-11-09T13:00:00Z', floors: [{ code: '1F', machines: [{ id: 'alias', name: '柳园 别名', kind: 'washer', state: 'occupied', holder: { userId: 'other', nick: 'secret' }, finishAt: '2026-11-09T13:30:00Z' }, { id: 'liu', name: '柳园一号', state: 'idle', userId: 'other' }] }] }
  const result = machineStatus({ board, mapping: { '1F-D1': 'alias' } }, { dormBuilding: 'guiyuan' }, 'all', Date.parse('2026-11-09T13:00:00Z'))
  assert.equal(result.machines.length, 1)
  assert.equal(result.machines[0].kind, 'dryer')
  assert.equal(result.machines[0].remainingMinutes, 30)
  assert.equal(result.machines[0].timeLabel, '预计剩余 30 分钟')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('other'), false)
  assert.throws(() => machineStatus(board, { dormBuilding: null }))
})

test('machine query honors custom catalog and reports stale snapshots as unknown', () => {
  const now = Date.now()
  const result = { buildings: [{ code: 'custom', name: '自定义宿舍' }], board: { updatedAt: new Date(now - 8 * 60000).toISOString(), floors: [{ code: '1F', machines: [{ id: 'custom-device', name: '自定义宿舍一号', state: 'idle' }] }] } }
  const status = machineStatus(result, { dormBuilding: 'custom' }, 'all', now)
  assert.equal(status.buildingName, '自定义宿舍')
  assert.equal(status.stale, true)
  assert.equal(status.machines[0].state, 'unknown')
  result.board.updatedAt = new Date(now).toISOString()
  assert.equal(machineStatus(result, { dormBuilding: 'custom' }, 'all', now).machines[0].state, 'idle')
})

test('machine tool keeps overdue running states and exposes a confirmation label instead of zero-minute prose', () => {
  const now = Date.parse('2026-11-09T13:00:00Z')
  const board = { updatedAt: new Date(now).toISOString(), floors: [{ code: '1F', machines: ['occupied', 'busy', 'abnormal'].map((state, index) => ({ id: `custom-${index}`, name: '自定义宿舍一号', state, finishAt: new Date(now - index * 60000).toISOString() })) }] }
  const result = { buildings: [{ code: 'custom', name: '自定义宿舍' }], board }
  const rows = machineStatus(result, { dormBuilding: 'custom' }, 'all', now).machines
  assert.deepEqual(rows.map(row => row.state), ['occupied', 'busy', 'abnormal'])
  for (const row of rows) {
    assert.equal(row.remainingMinutes, 0)
    assert.equal(row.timeLabel, '即将完成，等待设备确认')
    assert.equal(Object.hasOwn(row, 'completionConfirmed'), false)
  }
  board.updatedAt = new Date(now - 8 * 60000).toISOString()
  for (const row of machineStatus(result, { dormBuilding: 'custom' }, 'all', now).machines) {
    assert.equal(row.state, 'unknown')
    assert.equal(row.remainingMinutes, null)
    assert.equal(row.timeLabel, null)
  }
})

test('all provider protocols receive the zero-countdown instruction outside personal prompt text', async () => {
  for (const protocol of ['responses', 'chat-completions', 'anthropic']) {
    let sent
    await callAssistant({ config: { ...config, protocol, endpoint: `https://example.com/v1/${protocol === 'responses' ? 'responses' : protocol === 'chat-completions' ? 'chat/completions' : 'messages'}` }, input: '还有多久', prompt: '请简单回答', getStatus: async () => ({}), fetchImpl: async (_, options) => {
      sent = JSON.parse(options.body)
      const result = protocol === 'responses' ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '即将完成，等待设备确认' }] }] } : protocol === 'chat-completions' ? { choices: [{ message: { role: 'assistant', content: '即将完成，等待设备确认' } }] } : { content: [{ type: 'text', text: '即将完成，等待设备确认' }] }
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
    } })
    const instructions = protocol === 'responses' ? sent.instructions : protocol === 'chat-completions' ? sent.messages[0].content : sent.system
    assert.ok(instructions.includes('倒计时归零不代表设备结束'))
    assert.ok(instructions.includes('不得显示“0分钟”或称机器已结束、已空闲'))
    assert.ok(instructions.indexOf('倒计时归零不代表设备结束') < instructions.indexOf('<prompt>'))
  }
})

test('Responses function loop retains reasoning/output and matches call_id, with store disabled', async () => {
  const requests = []
  const reply = await callAssistant({ config, input: '空闲吗', history: [{ role: 'assistant', content: '你好' }], getStatus: async (kind) => { assert.equal(kind, 'all'); return { machines: [] } }, fetchImpl: async (url, opts) => { requests.push({ url, opts, body: JSON.parse(opts.body) }); return requests.length === 1 ? callResponse() : textResponse() } })
  assert.equal(reply, '目前有空闲机器')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].opts.redirect, 'error')
  assert.equal(requests[0].body.store, false)
  assert.equal(requests[0].body.max_output_tokens, 800)
  assert.equal(requests[0].body.tools[0].strict, true)
  assert.ok(requests[1].body.input.some((item) => item.type === 'reasoning'))
  const output = requests[1].body.input.find((item) => item.type === 'function_call_output')
  assert.equal(output.call_id, 'call_123')
  assert.deepEqual(JSON.parse(output.output), { machines: [] })
})

test('tool call rounds bounded, unexpected write tools/foreign building args refused', async () => {
  for (const extra of [{ name: 'send_notification' }, { arguments: '{"kind":"all","dormBuilding":"liuyuan"}' }]) {
    let tools = 0
    await assert.rejects(callAssistant({ config, input: 'hi', getStatus: async () => { tools++; }, fetchImpl: async () => callResponse(extra) }), (error) => ['unsupported_tool', 'upstream_format'].includes(error.code))
    assert.equal(tools, 0)
  }
  let requests = 0, tools = 0
  await assert.rejects(callAssistant({ config, input: 'hi', getStatus: async () => { tools++; return {} }, fetchImpl: async () => { requests++; return callResponse() } }), { code: 'tool_limit' })
  assert.equal(requests, 3)
  assert.equal(tools, 2)
})

test('transport rejects oversized response, private DNS and errors without exposing key/provider response', async () => {
  await assert.rejects(callAssistant({ config, input: 'hi', getStatus: async () => ({}), fetchImpl: async () => new Response('x'.repeat(ASSISTANT_LIMITS.responseBytes + 1)) }), { code: 'upstream_size' })
  let requests = 0
  await assert.rejects(callAssistant({ config, input: 'hi', getStatus: async () => ({}), resolveHost: async () => [{ address: '10.0.0.5' }], fetchImpl: async () => { requests++; return textResponse() } }), { code: 'unsafe_endpoint' })
  assert.equal(requests, 0)
  await assert.rejects(callAssistant({ config, input: 'hi', getStatus: async () => ({}), fetchImpl: async () => new Response('secret-key: upstream debug', { status: 401 }) }), (error) => error.code === 'upstream_error' && !error.message.includes('secret-key'))
})

test('15-second overall budget covers hung fetch or body and has no retry', async () => {
  let calls = 0
  await assert.rejects(callAssistant({ config, input: 'hi', timeoutMs: 10, getStatus: async () => ({}), fetchImpl: async () => { calls++; return new Promise(() => {}) } }), { code: 'timeout' })
  assert.equal(calls, 1)
  let cancelled = false
  await assert.rejects(callAssistant({ config, input: 'hi', timeoutMs: 10, getStatus: async () => ({}), fetchImpl: async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true } })) }), { code: 'timeout' })
  assert.equal(cancelled, true)
})
