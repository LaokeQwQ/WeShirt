import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref } from 'vue'
import { createDingTalk } from '../packages/core/dingtalk.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueTicket, verifyTicket } from '../packages/core/auth.js'
import { listEvents } from '../packages/core/auditlog.js'
import { createApp } from '../server/app.js'
import { safeLoginTarget, canAutoDingLogin } from '../frontend/src/loginFlow.js'

const env = { AUTH_SECRET:'synthetic-oauth-secret-at-least-32', ADMIN_TOKEN:'synthetic-admin-secret', DINGTALK_APP_KEY:'synthetic-oauth-client', DINGTALK_APP_SECRET:'synthetic-oauth-client-secret' }
const device='a'.repeat(32), providerRequestId='12345678-1234-1234-1234-123456789abc'
const client=()=>createDingTalk(env)
const stateTicket=(patch={})=>issueTicket({role:'login_state',d:device,nonce:crypto.randomUUID(),exp:Date.now()+60000,...patch},env.AUTH_SECRET)
const callback=(app,state,code='synthetic-code',options={})=>app.request('/api/dingtalk/oauth-callback?authCode='+encodeURIComponent(code)+'&state='+encodeURIComponent(state),options)
const query=(response)=>new URLSearchParams(new URL(response.headers.get('location')).hash.split('?')[1])
async function setup(){
  const memory=createMemoryStore()
  // Structured clones expose read/modify/write bugs hidden by shared objects.
  const store={get:async(key,fallback)=>structuredClone(await memory.get(key,fallback)),put:async(key,value)=>memory.put(key,structuredClone(value)),del:memory.del,list:memory.list}
  await store.put('user:existing',{id:'existing',nick:'手动昵称',nickAuto:false,dingUserId:'synthetic-ding-id',dingUnionId:'synthetic-union',mobile:'synthetic-mobile',notifyOn:false})
  await store.put('userByUnionId:synthetic-union','existing')
  return {store,app:createApp({store,env})}
}
function mockSuccess(t){
  let exchanges=0, profiles=0
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    const url=new URL(String(input))
    if(url.pathname==='/v1.0/oauth2/userAccessToken'){
      exchanges++
      assert.equal(options.method,'POST')
      assert.equal(options.redirect,'manual')
      assert.ok(options.signal)
      assert.deepEqual(JSON.parse(options.body),{clientId:env.DINGTALK_APP_KEY,clientSecret:env.DINGTALK_APP_SECRET,code:'synthetic-code',grantType:'authorization_code'})
      return Response.json({accessToken:'synthetic-user-token'})
    }
    if(url.pathname==='/v1.0/contact/users/me'){
      profiles++
      assert.equal(options.headers['x-acs-dingtalk-access-token'],'synthetic-user-token')
      return Response.json({unionId:'synthetic-union',nick:'上游昵称',mobile:'synthetic-mobile'})
    }
    assert.fail('unexpected endpoint: '+url.pathname)
  })
  return ()=>({exchanges,profiles})
}

test('OAuth exchange follows documented JSON fields, normalizes config, and never follows redirects',async(t)=>{
  let calls=0
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++
    assert.equal(url,'https://api.dingtalk.com/v1.0/oauth2/userAccessToken')
    assert.equal(options.redirect,'manual')
    assert.equal(options.headers['content-type'],'application/json')
    assert.deepEqual(JSON.parse(options.body),{clientId:'client',clientSecret:'secret',code:'temporary-code',grantType:'authorization_code'})
    return Response.json({accessToken:'synthetic-user-token',corpId:'synthetic-corp'})
  })
  assert.deepEqual(await createDingTalk({DINGTALK_APP_KEY:' client\n',DINGTALK_APP_SECRET:' secret\r\n'}).exchangeUserCode('temporary-code'),{ok:true,accessToken:'synthetic-user-token',corpId:'synthetic-corp'})
  for(const code of ['',null,'with space','x'.repeat(2049)])assert.equal((await client().exchangeUserCode(code)).err,'invalid_code')
  assert.deepEqual(await createDingTalk({DINGTALK_APP_KEY:'client'}).exchangeUserCode('code'),{ok:false,err:'not_configured',status:0})
  assert.equal(calls,1)
})

test('OAuth exchange rejects HTTP/business failures and retains only fixed safe diagnostics',async(t)=>{
  const cases=[
    [400,{code:'invalidParameter.authCode.notFound'},'invalid_code'],
    [200,{code:'invalidParameter.authCode.expired',accessToken:'should-not-be-accepted'},'invalid_code'],
    [401,{code:'invalidParameter.clientSecret'},'invalid_client'],
    [403,{code:'Forbidden.AccessDenied.AccessTokenPermissionDenied'},'permission_denied'],
    [429,{code:'unknown'},'rate_limited'],[503,{},'upstream_unavailable'],
    [400,{accessToken:'should-not-be-accepted'},'upstream_rejected'],[200,{},'invalid_response'],
    [200,{accessToken:{}},'invalid_response'],
  ]
  let current
  t.mock.method(globalThis,'fetch',async()=>Response.json({...current[1],message:'never-retain-client-secret-or-code',requestId:providerRequestId},{status:current[0]}))
  for(current of cases){
    const result=await client().exchangeUserCode('synthetic-code')
    assert.deepEqual(result,{ok:false,err:current[2],status:current[0],requestId:providerRequestId})
    assert.doesNotMatch(JSON.stringify(result),/never-retain|should-not-be-accepted/)
  }
})

test('OAuth exchange bounds body size, rejects malformed JSON, and does not retry timeouts',async(t)=>{
  let calls=0,response
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(response instanceof Error)throw response;return response})
  response=new Response('not-json',{status:200})
  assert.equal((await client().exchangeUserCode('synthetic-code')).err,'invalid_response')
  response=Response.json({accessToken:'x'.repeat(40000),requestId:'private-credential-like-value'})
  assert.deepEqual(await client().exchangeUserCode('synthetic-code'),{ok:false,err:'invalid_response',status:200})
  response=new DOMException('https://host.invalid/private?clientSecret=secret','TimeoutError')
  assert.deepEqual(await client().exchangeUserCode('synthetic-code'),{ok:false,err:'request_timeout',status:0})
  assert.equal(calls,3)
})

test('HEAD and explicit tokenized prefetch never exchange a code; subsequent normal GET succeeds',async(t)=>{
  const {app}=await setup(),counts=mockSuccess(t),state=await stateTicket()
  for(const options of [{method:'HEAD'},{headers:{Purpose:'prefetch'}},{headers:{'Sec-Purpose':'prefetch;prerender'}}]){
    const response=await callback(app,state,'synthetic-code',options)
    assert.equal(response.status,204)
    assert.equal(await response.text(),'')
    assert.equal(response.headers.get('cache-control'),'no-store')
  }
  assert.deepEqual(counts(),{exchanges:0,profiles:0})
  const response=await callback(app,state)
  assert.ok(query(response).get('k'))
  assert.deepEqual(counts(),{exchanges:1,profiles:1})
})

test('concurrent callbacks across apps sharing a store reuse one result and one device-bound claim',async(t)=>{
  const {app,store}=await setup(),second=createApp({store,env}),counts=mockSuccess(t),state=await stateTicket()
  const responses=await Promise.all([callback(app,state),callback(second,state),callback(app,state)])
  assert.deepEqual(counts(),{exchanges:1,profiles:1})
  const claims=responses.map(response=>query(response).get('k'))
  assert.ok(claims.every(claim=>claim && claim===claims[0]))
  const ticket=await verifyTicket(claims[0],env.AUTH_SECRET)
  assert.equal(ticket.role,'login_claim');assert.equal(ticket.d,device);assert.equal(ticket.u,'existing')
  assert.equal((await store.get('user:existing')).nick,'手动昵称')
  const reloaded=await callback(createApp({store,env}),state)
  assert.equal(query(reloaded).get('k'),claims[0])
  assert.deepEqual(counts(),{exchanges:1,profiles:1})
  const claim=()=>app.request('/api/auth/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:claims[0],device})})
  assert.equal((await claim()).status,200)
  assert.equal((await claim()).status,400,'replaying a callback must not mint a new claim nonce')
  const cache=JSON.stringify(await store.list('oauthcallbacks:'))
  assert.doesNotMatch(cache,/synthetic-user-token|synthetic-code|synthetic-oauth-client-secret/)
})

test('a genuine first login creates one persisted account without an execution context or any message request',async(t)=>{
  const store=createMemoryStore(),app=createApp({store,env}),paths=[]
  t.mock.method(globalThis,'fetch',async(input)=>{
    const path=new URL(String(input)).pathname;paths.push(path)
    if(path==='/v1.0/oauth2/userAccessToken')return Response.json({accessToken:'synthetic-new-user-token'})
    if(path==='/v1.0/contact/users/me')return Response.json({unionId:'synthetic-new-union',nick:'首次用户',mobile:'synthetic-new-mobile'})
    if(path==='/gettoken')return Response.json({errcode:0,access_token:'synthetic-new-app-token',expires_in:7200})
    if(path==='/topapi/user/getbyunionid')return Response.json({errcode:0,result:{userid:'synthetic-new-ding-user'}})
    assert.fail('first login must not call a real message endpoint: '+path)
  })
  const state=await stateTicket(),response=await callback(app,state),claim=query(response).get('k')
  assert.ok(claim,'first callback must not turn a successful account creation into an error')
  const ticket=await verifyTicket(claim,env.AUTH_SECRET)
  assert.equal((await store.get('user:'+ticket.u)).dingUserId,'synthetic-new-ding-user')
  assert.equal(await store.get('userByDevice:'+device),ticket.u)
  assert.equal(query(await callback(createApp({store,env}),state)).get('k'),claim)
  assert.equal((await store.list('user:')).length,1)
  assert.equal(paths.filter(path=>path==='/v1.0/oauth2/userAccessToken').length,1)
})

test('a consumed state rejects another code; expired/foreign states never contact DingTalk',async(t)=>{
  const {app}=await setup(),counts=mockSuccess(t),state=await stateTicket()
  await callback(app,state)
  assert.equal(query(await callback(app,state,'another-code')).get('e'),'state_used')
  for(const badState of [await stateTicket({exp:Date.now()-1}),await stateTicket({role:'login_claim'}),await stateTicket({d:'invalid-device'})]){
    assert.equal(query(await callback(app,badState)).get('e'),'state_invalid')
  }
  assert.deepEqual(counts(),{exchanges:1,profiles:1})
})

test('failed exchanges are not replayed upstream; a fresh authorization remains usable and diagnostics are correlated',async(t)=>{
  const {app,store}=await setup();let exchanges=0
  t.mock.method(globalThis,'fetch',async()=>{exchanges++;return Response.json({code:'invalidParameter.authCode.notFound',message:'private-upstream-message',requestId:providerRequestId},{status:400})})
  const state=await stateTicket(),first=await callback(app,state),params=query(first)
  assert.equal(params.get('e'),'code_expired');assert.equal(params.get('status'),'400')
  assert.match(params.get('eventId'),/^evt_[a-f0-9]{24}$/)
  const replay=await callback(createApp({store,env}),state)
  assert.equal(replay.headers.get('location'),first.headers.get('location'))
  assert.equal(exchanges,1)
  const {events}=await listEvents(store,{type:'auth'})
  assert.deepEqual(events[0].detail,{reason:'code_expired',eventId:params.get('eventId'),status:400,upstreamStatus:400,category:'invalid_code',requestId:providerRequestId})
  assert.doesNotMatch(JSON.stringify(events),/private-upstream|synthetic-code|synthetic-oauth-client-secret/)
  const counts=mockSuccess(t)
  assert.ok(query(await callback(app,await stateTicket())).get('k'))
  assert.equal(counts().exchanges,1)
})

test('HTTP 200 business failure uses application error status while preserving upstream status only in audit',async(t)=>{
  const {app,store}=await setup()
  t.mock.method(globalThis,'fetch',async()=>Response.json({code:'unknown',message:'do-not-retain'}))
  const response=await callback(app,await stateTicket())
  assert.equal(query(response).get('status'),'502')
  const {events}=await listEvents(store,{type:'auth'})
  assert.equal(events[0].detail.upstreamStatus,200)
  assert.equal(events[0].detail.category,'invalid_response')
})

test('fresh login URLs have unique states and incomplete credentials fail before authorization',async()=>{
  const {app}=await setup()
  const get=async()=>new URL((await (await app.request('/api/dingtalk/login-url?device='+device)).json()).url).searchParams.get('state')
  const [a,b]=await Promise.all([get(),get()])
  assert.notEqual(a,b)
  const missing=createApp({store:createMemoryStore(),env:{...env,DINGTALK_APP_SECRET:'  '}})
  assert.equal((await missing.request('/api/dingtalk/login-url?device='+device)).status,503)
})

test('credentialsOnly diagnosis calls just two token endpoints, never robot send, and strips upstream echoes',async(t)=>{
  const app=createApp({store:createMemoryStore(),env:{...env,DINGTALK_ROBOT_CODE:'synthetic-robot'}}),paths=[]
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    const path=new URL(String(input)).pathname;paths.push(path)
    assert.ok(options.signal);assert.equal(options.redirect,'manual')
    if(path==='/gettoken')return Response.json({errcode:0,access_token:'private-legacy-token',errmsg:'private-message'})
    if(path==='/v1.0/oauth2/accessToken')return Response.json({accessToken:'private-app-token',message:'private-message'})
    assert.fail('must not call a message endpoint')
  })
  const request=()=>app.request('/api/debug/dingtalk?credentialsOnly=1',{headers:{'x-admin-token':env.ADMIN_TOKEN}})
  assert.equal((await app.request('/api/debug/dingtalk?credentialsOnly=1')).status,403)
  const response=await request(),data=await response.json()
  assert.deepEqual(paths,['/gettoken','/v1.0/oauth2/accessToken'])
  assert.equal(data.oapi.ok,true);assert.equal(data.newApi.ok,true);assert.equal(data.robot.skipped,true)
  assert.match(response.headers.get('cache-control'),/(?:^|,\s*)no-store(?:$|,)/)
  assert.doesNotMatch(JSON.stringify(data),/private-|synthetic-oauth-client-secret/)
})

test('Login displays only allowlisted callback errors and well-formed event/status correlation',async()=>{
  const source=await readFile(new URL('../frontend/src/views/Login.vue',import.meta.url),'utf8')
  const script=source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'')
  async function render(query){
    let mounted
    const storage={getItem(){return null},setItem(){},removeItem(){}}
    const bindings={ref,onMounted:fn=>mounted=fn,onUnmounted(){},watch(){},useRouter:()=>({replace(){}}),useRoute:()=>({query}),useUserStore:()=>({isLoggedIn:false,ready:true}),safeLoginTarget,canAutoDingLogin,sessionStorage:storage,localStorage:storage,navigator:{userAgent:'DingTalk Android'}}
    const panel=new Function(...Object.keys(bindings),script+'\nreturn {err,trace}')(...Object.values(bindings))
    await mounted()
    return {error:panel.err.value,trace:panel.trace.value}
  }
  const result=await render({e:'code_expired',eventId:'evt_'+'a'.repeat(24),status:'400'})
  assert.match(result.error,/授权码已失效/);assert.match(result.trace,/状态码 400/)
  const hostile=await render({e:'secret-value',eventId:'secret-value',status:'200.5'})
  assert.doesNotMatch(hostile.error,/secret-value/);assert.equal(hostile.trace,'')
})
