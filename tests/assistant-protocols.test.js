import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { createMemoryStore } from '../packages/core/store.js'
import { assistantConfig, patchAssistantConfig, callAssistant, discoverAssistantModels, prepareAssistantContext } from '../packages/core/assistant.js'
import { registerAssistantRoutes, deleteAssistantUserData } from '../server/assistant.js'

const base={enabled:true,endpoint:'https://provider.vendor.net/v1',apiKey:'fixture-key-only',model:'fixture-model'}
const json=value=>new Response(JSON.stringify(value))
const final={responses:()=>json({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'本楼有空闲机器'}]}]}),'chat-completions':()=>json({choices:[{message:{role:'assistant',content:'本楼有空闲机器'}}]}),anthropic:()=>json({content:[{type:'text',text:'本楼有空闲机器'}]})}
const tool={responses:()=>json({output:[{type:'reasoning',id:'r1',summary:[]},{type:'function_call',name:'get_machine_status',call_id:'c1',arguments:'{"kind":"washer"}'}]}),'chat-completions':()=>json({choices:[{message:{role:'assistant',content:null,tool_calls:[{type:'function',id:'c1',function:{name:'get_machine_status',arguments:'{"kind":"washer"}'}}]}}]}),anthropic:()=>json({content:[{type:'thinking',thinking:'private-reasoning',signature:'signed-block'},{type:'tool_use',name:'get_machine_status',id:'c1',input:{kind:'washer'}}]})}

for(const protocol of Object.keys(final))test(`${protocol} preserves its tool-chain format and counts every outbound request`,async()=>{
  const requests=[];let count=0,queries=0
  const config=assistantConfig({...base,protocol})
  const reply=await callAssistant({config,input:'查询洗衣机',getStatus:async kind=>{queries++;assert.equal(kind,'washer');return{machines:[{id:'own-only',state:'idle'}]}},beforeRequest:async()=>{count++},fetchImpl:async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return requests.length===1?tool[protocol]():final[protocol]()}})
  assert.equal(reply,'本楼有空闲机器');assert.equal(count,2);assert.equal(queries,1)
  assert.equal(requests[0].options.redirect,'error')
  assert.ok(requests[0].url.endsWith(protocol==='responses'?'/responses':protocol==='anthropic'?'/messages':'/chat/completions'))
  if(protocol==='anthropic'){
    assert.equal(requests[0].options.headers['x-api-key'],base.apiKey)
    assert.equal(requests[0].options.headers.Authorization,undefined)
    const sent=requests[1].body.messages
    assert.ok(sent.some(row=>Array.isArray(row.content)&&row.content.some(block=>block.signature==='signed-block')))
    assert.equal(sent.at(-1).content[0].tool_use_id,'c1')
    assert.equal(reply.includes('private-reasoning'),false)
  }else{
    assert.equal(requests[0].body.store,false)
    assert.equal(requests[0].options.headers.Authorization,'Bearer '+base.apiKey)
    const sent=protocol==='responses'?requests[1].body.input:requests[1].body.messages
    assert.equal(sent.at(-1)[protocol==='responses'?'call_id':'tool_call_id'],'c1')
  }
})

test('all protocol adapters reject unknown writes and cross-building tool arguments before querying',async()=>{
  for(const protocol of Object.keys(final)){
    for(const mutation of ['name','scope']){
      let queries=0
      const response=await tool[protocol]().json()
      const item=protocol==='responses'?response.output.at(-1):protocol==='anthropic'?response.content.at(-1):response.choices[0].message.tool_calls[0].function
      if(mutation==='name')item.name='send_notification'
      else if(protocol==='anthropic')item.input.dormBuilding='foreign'
      else item.arguments='{"kind":"all","dormBuilding":"foreign"}'
      await assert.rejects(callAssistant({config:assistantConfig({...base,protocol}),input:'x',getStatus:async()=>{queries++},fetchImpl:async()=>json(response)}),error=>['unsupported_tool','upstream_format'].includes(error.code))
      assert.equal(queries,0)
    }
  }
})

test('reasoning follows capability metadata and unknown models omit unsupported parameters',async()=>{
  for(const protocol of Object.keys(final)){
    let body
    const config=assistantConfig({...base,protocol,reasoningEffort:'high'})
    await callAssistant({config,input:'x',getStatus:async()=>({}),fetchImpl:async(_,options)=>{body=JSON.parse(options.body);return final[protocol]()}})
    assert.equal(body.reasoning,undefined);assert.equal(body.reasoning_effort,undefined);assert.equal(body.thinking,undefined)
    config.reasoningMode='on';config.modelCapabilities={reasoning:true,effortLevels:['low','high'],thinkingModes:['adaptive']}
    await callAssistant({config,input:'x',getStatus:async()=>({}),fetchImpl:async(_,options)=>{body=JSON.parse(options.body);return final[protocol]()}})
    if(protocol==='anthropic'){assert.deepEqual(body.thinking,{type:'adaptive'});assert.equal(body.output_config.effort,'high')}
    else if(protocol==='responses')assert.deepEqual(body.reasoning,{effort:'high'})
    else assert.equal(body.reasoning_effort,'high')
    config.reasoningEffort='max'
    await assert.rejects(callAssistant({config,input:'x',getStatus:async()=>({}),fetchImpl:async()=>{throw new Error('must not fetch')}}),{code:'reasoning_unsupported'})
  }
})

test('model discovery is bounded, uses provider auth, normalizes metadata and never follows redirects',async()=>{
  let pages=0
  const result=await discoverAssistantModels({config:assistantConfig({...base,protocol:'anthropic'}),fetchImpl:async(url,options)=>{
    pages++;assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['x-api-key'],base.apiKey)
    if(pages>1)assert.equal(new URL(url).searchParams.get('after_id'),'last-'+(pages-1))
    return json({data:[{id:'custom-'+pages,display_name:'Custom',capabilities:{thinking:{supported:true,types:{adaptive:{supported:true}}},effort:{high:{supported:true}}}}],has_more:true,last_id:'last-'+pages})
  }})
  assert.equal(pages,3);assert.equal(result.models.length,3);assert.equal(result.models[0].capabilities.reasoning,true);assert.deepEqual(result.models[0].capabilities.effortLevels,['high'])
  assert.equal(JSON.stringify(result).includes(base.apiKey),false)
  await assert.rejects(discoverAssistantModels({config:assistantConfig(base),fetchImpl:async()=>new Response('debug '+base.apiKey,{status:404})}),error=>error.code==='models_unavailable'&&!error.message.includes(base.apiKey))
  let outbound=0
  await assert.rejects(discoverAssistantModels({config:assistantConfig(base),resolveHost:async()=>['127.0.0.1'],fetchImpl:async()=>{outbound++}}),{code:'unsafe_endpoint'})
  assert.equal(outbound,0)
  await assert.rejects(discoverAssistantModels({config:assistantConfig(base),timeoutMs:5,fetchImpl:async()=>new Promise(()=>{})}),{code:'timeout'})
})

test('128k compression is deterministic, keeps the newest turn and signals incomplete history without a summarizer call',async()=>{
  const history=Array.from({length:100},(_,i)=>({role:i%2?'assistant':'user',content:'第'+i+'轮 '+'洗'.repeat(2000)}))
  const context=prepareAssistantContext(history,'最后的问题','平台边界')
  assert.equal(context.compressed,true);assert.ok(context.removed>0)
  assert.equal(context.messages.at(-1).content,'最后的问题');assert.match(context.summary,/可能不完整/)
  let request,reported
  await callAssistant({config:assistantConfig(base),history,input:'最后的问题',getStatus:async()=>({}),onContext:value=>{reported=value},fetchImpl:async(_,options)=>{request=options.body;return final.responses()}})
  assert.ok(Buffer.byteLength(request)<128000);assert.equal(reported.compressed,true);assert.ok(request.includes('最后的问题'));assert.ok(request.includes('history_extract'))
})

function atomicFixture(){const rows=new Map();return{consistency:'linearizable',durable:true,async get(key){const row=rows.get(key);return row&&row.expiresAt>Date.now()?structuredClone(row):null},async compareAndSet(key,version,value,{expiresAt}){const row=rows.get(key);if((row?.version??null)!==version)return false;rows.set(key,{version:crypto.randomUUID(),value:structuredClone(value),expiresAt});return true}}}
async function fixture({store=createMemoryStore(),atomicStore,fetchImpl=async()=>final.responses()}={}){
  await store.put('user:one',{id:'one',dormBuilding:'guiyuan'});await store.put('user:two',{id:'two',dormBuilding:'liuyuan'})
  if(!await store.get('assistant:config',null))await store.put('assistant:config',assistantConfig(base))
  const app=new Hono();registerAssistantRoutes(app,{store,atomicStore,authenticate:c=>c.req.header('x-user'),checkAdmin:c=>c.req.header('x-admin')==='yes',getBoard:async()=>({board:{updatedAt:new Date().toISOString(),floors:[]}}),fetchImpl})
  const req=async(path,body,user='one',admin=false)=>{const response=await app.request(path,{method:body===undefined?'GET':'PATCH',headers:{'content-type':'application/json','x-user':user,...(admin?{'x-admin':'yes'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()}}
  const chat=async input=>{const response=await app.request('/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json','x-user':'one'},body:JSON.stringify({input})});return{status:response.status,data:await response.json()}}
  return{store,req,chat}
}

test('user prompt copies can be edited and switched privately and cannot replace read-only instructions',async()=>{
  const sent=[];const {store,req,chat}=await fixture({fetchImpl:async(_,options)=>{sent.push(JSON.parse(options.body));return final.responses()}})
  const initial=await req('/api/assistant/preferences');assert.equal(initial.data.customized,false)
  const profiles=[{id:'mine',name:'我的风格',text:'用户专属提示词'},{id:'second',name:'另一套',text:'另一套专属提示词'}]
  assert.equal((await req('/api/assistant/preferences',{promptProfiles:profiles,activePromptId:'mine'})).status,200)
  assert.equal((await req('/api/assistant/preferences',undefined,'two')).data.customized,false)
  await chat('hi');assert.ok(sent.at(-1).instructions.includes('用户专属提示词'));assert.ok(sent.at(-1).instructions.includes('不能执行登记'))
  await req('/api/assistant/preferences',{activePromptId:'second'});await chat('hi');assert.ok(sent.at(-1).instructions.includes('另一套专属提示词'))
  assert.equal((await req('/api/assistant/preferences',{activePromptId:'missing'})).status,400)
  await req('/api/assistant/preferences',{reset:true});assert.equal((await req('/api/assistant/preferences')).data.customized,false)
  await req('/api/assistant/preferences',{promptProfiles:profiles,activePromptId:'mine'});await deleteAssistantUserData(store,'one');assert.equal(await store.get('assistant:preferences:one',null),null)
})

test('30/min default is enforced across instances including tool followups and quota outages fail closed',async()=>{
  const store=createMemoryStore(),atomicStore=atomicFixture();let outbound=0
  const fetchImpl=async()=>{outbound++;return outbound%2?tool.responses():final.responses()}
  const first=await fixture({store,atomicStore,fetchImpl}),second=await fixture({store,atomicStore,fetchImpl})
  assert.equal((await first.req('/api/assistant/status')).data.usage.dailyLimit,1000)
  assert.equal((await first.req('/api/assistant/status')).data.usage.minuteLimit,30)
  for(let i=0;i<15;i++)assert.equal((await(i%2?first:second).chat('查询机器')).status,200)
  assert.equal(outbound,30);assert.equal((await second.chat('再次查询')).status,429);assert.equal(outbound,30)
  const usage=(await second.req('/api/assistant/status')).data.usage;assert.equal(usage.used,15);assert.equal(usage.minuteRemaining,0)
  const broken=await fixture({store,atomicStore:{async get(){throw Error('private storage detail')}}})
  assert.equal((await broken.chat('x')).status,503)
})

test('distributed chat lease prevents concurrent history loss and releases after provider failures',async()=>{
  const store=createMemoryStore(),atomicStore=atomicFixture()
  let begin,release
  const started=new Promise(resolve=>{begin=resolve}),wait=new Promise(resolve=>{release=resolve})
  const first=await fixture({store,atomicStore,fetchImpl:async()=>{begin();await wait;return final.responses()}})
  const second=await fixture({store,atomicStore})
  const pending=first.chat('first');await started
  assert.equal((await second.chat('concurrent')).status,429)
  release();assert.equal((await pending).status,200)
  assert.equal((await second.chat('after release')).status,200)
  assert.equal((await store.get('assistant:history:one')).length,4)
  const failing=await fixture({store,atomicStore,fetchImpl:async()=>new Response('secret debug',{status:500})})
  assert.equal((await failing.chat('provider failure')).status,502)
  assert.equal((await second.chat('retry')).status,200)
})

test('a tool continuation cannot emit the 31st provider request within one minute',async()=>{
  const {store,req,chat}=await fixture({fetchImpl:async()=>tool.responses()})
  await store.put('assistant:usage:one',{day:new Date(Date.now()+8*3600000).toISOString().slice(0,10),count:0,minute:Math.floor(Date.now()/60000),minuteCount:29})
  const response=await chat('query')
  assert.equal(response.status,429)
  const usage=(await req('/api/assistant/status')).data.usage
  assert.equal(usage.minuteRemaining,0);assert.equal(usage.used,1)
})

test('AI management sends optional DingTalk credentials rather than disabling account authorization',async()=>{
  const source=await readFile(new URL('../frontend/src/components/AdminAI.vue',import.meta.url),'utf8')
  assert.equal(/auth:\s*false/.test(source),false)
  assert.ok((source.match(/auth:'optional'/g)||[]).length>=3)
  assert.equal(patchAssistantConfig(assistantConfig(base),{dailyLimit:10000,minuteLimit:30}).dailyLimit,10000)
})

test('saved credentials can only be reused at the same canonical destination and protocol',()=>{
  const current=assistantConfig(base)
  for(const patch of [{endpoint:'https://other.vendor.net/v1'},{endpoint:'https://provider.vendor.net/another'},{protocol:'anthropic'},{protocol:'chat-completions'}])assert.throws(()=>patchAssistantConfig(current,patch),{code:'key_confirmation_required',status:409})
  assert.equal(patchAssistantConfig(current,{endpoint:'https://provider.vendor.net/v1/'}).apiKey,base.apiKey)
  assert.equal(patchAssistantConfig(current,{endpoint:'https://other.vendor.net/v1',apiKey:'explicit-other-key'}).apiKey,'explicit-other-key')
  assert.equal(patchAssistantConfig(current,{enabled:false,endpoint:'https://other.vendor.net/v1',clearKey:true}).apiKey,'')
})

test('model discovery refuses destination changes before outbound traffic or credential storage',async()=>{
  const store=createMemoryStore();await store.put('user:one',{id:'one',dormBuilding:'guiyuan'});await store.put('assistant:config',assistantConfig(base))
  let requests=0
  const app=new Hono();registerAssistantRoutes(app,{store,authenticate:()=> 'one',checkAdmin:()=>true,getBoard:async()=>({}),fetchImpl:async()=>{requests++;return json({data:[]})}})
  for(const path of ['/api/admin/assistant/models','/api/admin/assistant']){
    const response=await app.request(path,{method:path.endsWith('/models')?'POST':'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'https://unfamiliar.vendor.net/v1'})})
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,'key_confirmation_required')
  }
  assert.equal(requests,0);assert.equal((await store.get('assistant:config')).endpoint,'https://provider.vendor.net/v1/responses')
  const same=await app.request('/api/admin/assistant/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'https://provider.vendor.net/v1/'})})
  assert.equal(same.status,200);assert.equal(requests,1)
})

test('built-in and own skills participate automatically without sending another user template',async()=>{
  let instructions=''
  const {store,chat}=await fixture({fetchImpl:async(_,options)=>{instructions=JSON.parse(options.body).instructions;return final.responses()}})
  await store.put('assistant:skills:one',[{id:'own',title:'我的技能',prompt:'本人自动技能参考'}])
  await store.put('assistant:skills:two',[{id:'foreign',title:'他人技能',prompt:'不可上传的其他用户技能'}])
  await chat('现在能洗衣吗')
  assert.ok(instructions.includes('本人自动技能参考'));assert.ok(instructions.includes('查询空闲'));assert.ok(instructions.includes('洗护建议'));assert.ok(instructions.includes('时间安排'));assert.equal(instructions.includes('不可上传的其他用户技能'),false)
  const source=await readFile(new URL('../frontend/src/views/Assistant.vue',import.meta.url),'utf8')
  assert.equal(source.includes('selectedSkill'),false)
})
