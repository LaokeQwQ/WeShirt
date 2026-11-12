import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const secret = 'assistant-integration-test-secret-32'
const env = { AUTH_SECRET: secret, ADMIN_TOKEN: 'test-admin-secret', BUILDING_ID: 'b1', HAIER_MODE: 'mock', ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'mock', ASSISTANT_API_KEY: 'test-only-ai-key', ASSISTANT_RESOLVE_HOST: async () => [{ address: '8.8.8.8' }] }

test('integrated assistant derives identity from Bearer and excludes foreign memory and machine occupants', async () => {
  const store = createMemoryStore()
  await store.put('user:u_a', { id: 'u_a', nick: '本人', dormBuilding: 'guiyuan' })
  await store.put('user:u_b', { id: 'u_b', nick: '其他人私密昵称', dormBuilding: 'liuyuan' })
  await store.put('assistant:memory:u_a', { enabled: true, note: '本人参考备注' })
  await store.put('assistant:memory:u_b', { enabled: true, note: '不应上传的他人备注' })
  await store.put('assistant:history:u_b', [{ role: 'user', content: '他人聊天内容', at: new Date().toISOString() }])
  await store.put('machines:b1', { board: { updatedAt: new Date().toISOString(), floors: [{ code: '1F', machines: [{ id: '1F-01', name: '桂园一号', state: 'idle', holder: { userId: 'u_b', nick: '其他人私密昵称', mobile: 'not-a-real-phone' } }, { id: 'other-machine', name: '柳园一号', state: 'idle' }] }] } })
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.openai.com')
    requests.push(JSON.parse(options.body))
    const output = requests.length === 1 ? [{ type: 'function_call', name: 'get_machine_status', call_id: 'test-call', arguments: '{"kind":"all"}' }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '本楼有空闲机器' }] }]
    return new Response(JSON.stringify({ output }))
  }
  try {
    const app = createApp({ store, env })
    const token = await issueToken('u_a', secret)
    const response = await app.request('/api/assistant/chat', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ input: '查空闲机器' }) })
    assert.equal(response.status, 200)
    const sent = JSON.stringify(requests)
    for (const foreign of ['不应上传的他人备注', '他人聊天内容', '其他人私密昵称', 'not-a-real-phone']) assert.equal(sent.includes(foreign), false)
    assert.ok(sent.includes('本人参考备注'))
    const output = requests[1].input.find((item) => item.type === 'function_call_output')
    assert.equal(JSON.parse(output.output).machines.length, 1)
    assert.equal(output.output.includes('柳园'), false)
    assert.equal((await store.get('assistant:history:u_b')).length, 1)
  } finally { globalThis.fetch = originalFetch }
})

test('integrated AI config is unavailable to normal user; admins see key presence only', async () => {
  const store = createMemoryStore()
  await store.put('user:u_a', { id: 'u_a', dormBuilding: 'guiyuan' })
  const app = createApp({ store, env })
  const token = await issueToken('u_a', secret)
  assert.equal((await app.request('/api/admin/assistant', { headers: { authorization: 'Bearer ' + token } })).status, 401)
  const response = await app.request('/api/admin/assistant', { headers: { 'x-admin-token': env.ADMIN_TOKEN } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.keyConfigured, true)
  assert.equal(JSON.stringify(body).includes(env.ASSISTANT_API_KEY), false)
  assert.equal(body.apiKey, undefined)
  const mcp = await app.request('/api/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'register_task', arguments: {} } }) })
  assert.equal((await mcp.json()).error.code, -32602)
})

test('DingTalk account admin reads AI configuration without bootstrap token; model discovery stays super-only',async()=>{
  const store=createMemoryStore()
  for(const id of ['chief','manager'])await store.put('user:'+id,{id,nick:id,dormBuilding:'guiyuan'})
  await store.put('meta:siteAdmins',[{userId:'chief',role:'super'},{userId:'manager',role:'admin'}])
  const app=createApp({store,env})
  const chief=await issueToken('chief',secret),manager=await issueToken('manager',secret)
  const read=await app.request('/api/admin/assistant',{headers:{authorization:'Bearer '+manager}})
  assert.equal(read.status,200);assert.equal((await read.json()).keyConfigured,true)
  const forbidden=await app.request('/api/admin/assistant/models',{method:'POST',headers:{authorization:'Bearer '+manager,'content-type':'application/json'},body:JSON.stringify({endpoint:'https://provider.vendor.net/v1'})})
  assert.equal(forbidden.status,403);const error=(await forbidden.json()).error;assert.ok(error.eventId);assert.equal(error.status,403)
  const original=globalThis.fetch
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://provider.vendor.net/v1/models');assert.equal(options.redirect,'error');return new Response(JSON.stringify({data:[{id:'fixture-discovered'}]}))}
  try{
    const discoveryApp=createApp({store,env})
    const discover=await discoveryApp.request('/api/admin/assistant/models',{method:'POST',headers:{authorization:'Bearer '+chief,'content-type':'application/json'},body:JSON.stringify({endpoint:'https://provider.vendor.net/v1',apiKey:'explicit-provider-fixture-key'})})
    assert.equal(discover.status,200);assert.equal((await discover.json()).models[0].id,'fixture-discovered')
    assert.equal((await store.get('assistant:config',{})).endpoint,undefined)
  }finally{globalThis.fetch=original}
})
