import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMemoryStore } from '../packages/core/store.js'
import { beijingDay } from '../packages/core/assistant.js'
import { registerAssistantRoutes, pruneAssistantStorage, deleteAssistantUserData } from '../server/assistant.js'

const env = { AUTH_SECRET: 'assistant-test-secret-at-least-16', ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'mock', ASSISTANT_API_KEY: 'keep-server-only' }
const result = (reply = '洗衣建议') => new Response(JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }] }))
const board = { updatedAt: new Date().toISOString(), floors: [{ code: '1F', machines: [{ id: '1F-01', name: '桂园一号', state: 'idle', holder: { nick: '不能上传的其他用户' } }, { id: 'liu-1', name: '柳园一号', state: 'idle' }] }] }

async function fixture(options = {}) {
  const store = options.store || createMemoryStore()
  await store.put('user:u_a', { id: 'u_a', nick: '甲', dormBuilding: 'guiyuan' })
  await store.put('user:u_b', { id: 'u_b', nick: '乙', dormBuilding: 'liuyuan' })
  const app = new Hono()
  registerAssistantRoutes(app, { store, env: options.env ?? env, authenticate: async (c) => c.req.header('x-user'), checkAdmin: async (c) => c.req.header('x-admin') === 'yes', getBoard: options.getBoard || (async () => board), fetchImpl: options.fetchImpl || (async () => result()) })
  async function req(path, body, method = body === undefined ? 'GET' : 'POST', user = 'u_a', admin = false) {
    const response = await app.request(path, { method, headers: { ...(user ? { 'x-user': user } : {}), ...(admin ? { 'x-admin': 'yes' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  return { store, app, req }
}

test('chat requires real stored identity, enabled configuration and bound dorm; no outbound call when closed', async () => {
  let calls = 0
  const { req, store } = await fixture({ env: {}, fetchImpl: async () => { calls++; return result() } })
  assert.equal((await req('/api/assistant/chat', { input: 'hi' }, 'POST', null)).status, 401)
  assert.equal((await req('/api/assistant/chat', { input: 'hi' }, 'POST', 'forged')).status, 401)
  assert.equal((await req('/api/assistant/chat', { input: 'hi' })).status, 503)
  assert.equal(calls, 0)
  const ready = await fixture()
  await ready.store.put('user:u_a', { id: 'u_a', dormBuilding: null })
  assert.equal((await ready.req('/api/assistant/chat', { input: 'hi' })).status, 409)
  assert.equal(await store.get('assistant:usage:u_a', null), null)
})

test('admin config is protected, write-only key updates preserve existing and invalid patch cannot mutate saved object', async () => {
  const { req, store } = await fixture()
  assert.equal((await req('/api/admin/assistant')).status, 401)
  const saved = await req('/api/admin/assistant', { apiKey: 'new-key-secret', model: 'other' }, 'PATCH', 'u_a', true)
  assert.equal(saved.status, 200)
  assert.equal(JSON.stringify(saved.data).includes('new-key-secret'), false)
  assert.equal(saved.data.keyConfigured, true)
  const invalid = await req('/api/admin/assistant', { model: 'not-saved', endpoint: 'https://127.0.0.1' }, 'PATCH', 'u_a', true)
  assert.equal(invalid.status, 400)
  assert.equal((await store.get('assistant:config')).model, 'other')
  assert.equal((await req('/api/admin/assistant', undefined, 'GET', 'u_a', true)).data.apiKey, undefined)
})

test('input and skill identity validated before consuming quota', async () => {
  const { req, store } = await fixture()
  for (const body of [{ input: '' }, { input: 'a'.repeat(1001) }, { input: 'hi', userId: 'u_b' }, { input: 'hi', skillId: 'someone-elses-skill' }]) assert.ok([400, 404].includes((await req('/api/assistant/chat', body)).status))
  assert.equal(await store.get('assistant:usage:u_a', null), null)
})

test('daily count persists across router recreation; minute rate and daily bound enforced separately', async () => {
  const { req, store } = await fixture()
  for (let i = 0; i < 3; i++) assert.equal((await req('/api/assistant/chat', { input: 'hi' })).status, 200)
  assert.equal((await req('/api/assistant/chat', { input: 'too fast' })).status, 429)
  const old = await store.get('assistant:usage:u_a')
  await store.put('assistant:usage:u_a', { ...old, count: 20, minute: old.minute - 1 })
  const second = await fixture({ store })
  assert.equal((await second.req('/api/assistant/chat', { input: 'new instance' })).status, 429)
  assert.equal((await second.req('/api/assistant/status')).data.usage.dailyRemaining, 0)
  await store.put('assistant:usage:u_a', { day: '2000-01-01', count: 20 })
  assert.equal((await second.req('/api/assistant/chat', { input: 'new day' })).status, 200)
  assert.equal((await store.get('assistant:usage:u_a')).day, beijingDay())
})

test('one concurrent chat per user, isolated from another user; failure counts bounded attempt and releases slot', async () => {
  let release, started
  const began = new Promise((resolve) => { started = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const { req } = await fixture({ fetchImpl: async () => { started(); await wait; return result() } })
  const first = req('/api/assistant/chat', { input: 'first' })
  await began
  assert.equal((await req('/api/assistant/chat', { input: 'duplicate' })).status, 429)
  release()
  assert.equal((await first).status, 200)
  assert.equal((await req('/api/assistant/chat', { input: 'other' }, 'POST', 'u_b')).status, 200)
  const failing = await fixture({ fetchImpl: async () => { throw new Error('keep-server-only') } })
  const failed = await failing.req('/api/assistant/chat', { input: 'first' })
  assert.equal(failed.status, 502)
  assert.equal(JSON.stringify(failed).includes('keep-server-only'), false)
  assert.equal((await failing.req('/api/assistant/status')).data.usage.used, 1)
  assert.equal((await failing.req('/api/assistant/chat', { input: 'retry' })).status, 502)
})

test('memory is opt in, own tasks only, disabled note excluded from model, delete forgets old habits', async () => {
  const payloads = []
  const { req, store } = await fixture({ fetchImpl: async (_, options) => { payloads.push(JSON.parse(options.body)); return result() } })
  const startAt = new Date(Date.now() - 1000).toISOString()
  await store.put('tasks:u_a', [{ kind: 'washer', startAt }])
  await store.put('tasks:u_b', [{ kind: 'washer', startAt }, { kind: 'washer', startAt }])
  assert.equal((await req('/api/assistant/memory')).data.enabled, false)
  await req('/api/assistant/memory', { enabled: true, note: '只用冷水，私密备注' }, 'PATCH')
  assert.equal((await req('/api/assistant/memory')).data.habits.count, 1)
  assert.equal((await req('/api/assistant/memory', undefined, 'GET', 'u_b')).data.note, '')
  await req('/api/assistant/chat', { input: '建议' })
  assert.ok(payloads[0].instructions.includes('私密备注'))
  assert.equal(payloads[0].instructions.includes('不能上传的其他用户'), false)
  await req('/api/assistant/memory', { enabled: false }, 'PATCH')
  await req('/api/assistant/chat', { input: '建议' })
  assert.equal(payloads[1].instructions.includes('私密备注'), false)
  assert.equal((await req('/api/assistant/memory', { note: 'x'.repeat(501) }, 'PATCH')).status, 400)
  await req('/api/assistant/memory', undefined, 'DELETE')
  await req('/api/assistant/memory', { enabled: true }, 'PATCH')
  const cleared = (await req('/api/assistant/memory')).data
  assert.equal(cleared.note, '')
  assert.equal(cleared.habits.count, 0)
})

test('tool can only see current bound dorm and sends no other occupant data', async () => {
  const calls = []
  const { req } = await fixture({ getBoard: async (scope) => { assert.deepEqual(scope, { userId: 'u_a', dormBuilding: 'guiyuan' }); return board }, fetchImpl: async (_, options) => { const input = JSON.parse(options.body); calls.push(input); return calls.length === 1 ? new Response(JSON.stringify({ output: [{ type: 'function_call', name: 'get_machine_status', call_id: 'same-id', arguments: '{"kind":"all"}' }] })) : result('桂园有空闲机器') } })
  assert.equal((await req('/api/assistant/chat', { input: '空闲机器' })).status, 200)
  const output = calls[1].input.find((item) => item.type === 'function_call_output')
  assert.equal(JSON.parse(output.output).machines.length, 1)
  assert.equal(output.output.includes('柳园'), false)
  assert.equal(output.output.includes('不能上传的其他用户'), false)
})

test('custom skill sharing contains template only, signed import creates owned copy, foreign delete denied', async () => {
  const { req } = await fixture()
  const created = await req('/api/assistant/skills', { title: '午后安排', description: '', prompt: '安排午后洗衣', command: 'not executable' })
  assert.equal(created.status, 201)
  assert.equal(created.data.skill.command, undefined)
  const id = created.data.skill.id
  assert.equal((await req('/api/assistant/skills/' + id, undefined, 'DELETE', 'u_b')).status, 404)
  const shared = await req('/api/assistant/skills/' + id + '/share', {})
  const imported = await req('/api/assistant/skills/import', { ticket: shared.data.ticket }, 'POST', 'u_b')
  assert.equal(imported.status, 201)
  assert.notEqual(imported.data.skill.id, id)
  assert.equal(imported.data.skill.prompt, '安排午后洗衣')
  assert.equal((await req('/api/assistant/skills/import', { ticket: shared.data.ticket + 'tampered' })).status, 400)
  assert.equal((await req('/api/assistant/skills/' + id, undefined, 'DELETE')).status, 200)
})

test('history is own-only, input context at most eight rounds and inactive account cleanup removes expired data', async () => {
  let sent
  const { req, store } = await fixture({ fetchImpl: async (_, options) => { sent = JSON.parse(options.body); return result() } })
  const at = new Date().toISOString()
  await store.put('assistant:history:u_a', Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i), at })))
  await store.put('assistant:history:u_b', [{ role: 'user', content: 'other-secret', at }])
  await req('/api/assistant/chat', { input: 'new' })
  assert.equal(sent.input.length, 17)
  assert.equal(JSON.stringify(sent).includes('other-secret'), false)
  assert.equal((await req('/api/assistant/history')).data.messages.length, 20)
  await store.put('assistant:history:inactive', [{ role: 'user', content: 'expired', at: '2000-01-01T00:00:00Z' }])
  assert.equal((await pruneAssistantStorage(store)).pruned, 1)
  assert.equal(await store.get('assistant:history:inactive', null), null)
  await req('/api/assistant/history', undefined, 'DELETE')
  assert.equal((await req('/api/assistant/history')).data.messages.length, 0)
  await deleteAssistantUserData(store, 'u_a')
  assert.equal(await store.get('assistant:usage:u_a', null), null)
})

test('MCP initializes and advertises a single readonly tool independent of LLM configuration', async () => {
  const { req } = await fixture({ env: {} })
  const initialized = await req('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  assert.equal(initialized.data.result.protocolVersion, '2025-06-18')
  assert.ok(initialized.data.result.capabilities.tools)
  assert.equal((await req('/api/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 204)
  const tools = await req('/api/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal(tools.data.result.tools.length, 1)
  assert.equal(tools.data.result.tools[0].annotations.readOnlyHint, true)
  const called = await req('/api/mcp', { jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'get_machine_status', arguments: { kind: 'all' } } })
  const status = JSON.parse(called.data.result.content[0].text)
  assert.equal(status.dormBuilding, 'guiyuan')
  assert.equal(status.machines.length, 1)
})

test('MCP uses JSONRPC error codes, rejects unknown/writing tools and auth failures, and rate limits', async () => {
  const { req, app, store } = await fixture()
  assert.equal((await req('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'POST', null)).data.error.code, -32001)
  const malformed = await app.request('/api/mcp', { method: 'POST', headers: { 'x-user': 'u_a' }, body: '{' })
  assert.equal((await malformed.json()).error.code, -32700)
  assert.equal((await req('/api/mcp', { id: 1, method: 'tools/list' })).data.error.code, -32600)
  assert.equal((await req('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'unknown' })).data.error.code, -32601)
  assert.equal((await req('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'register_task', arguments: { kind: 'all' } } })).data.error.code, -32602)
  assert.equal((await req('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_machine_status', arguments: { kind: 'all', dormBuilding: 'liuyuan' } } })).data.error.code, -32602)
  await store.put('assistant:mcp:u_a', { minute: Math.floor(Date.now() / 60000), count: 20 })
  assert.equal((await req('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 429)
})
