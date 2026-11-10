import test from 'node:test'
import assert from 'node:assert/strict'
import { boundedDingTalkFetch, dingTalkResponseDiagnostics, createDingTalk } from '../packages/core/dingtalk.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createApp } from '../server/app.js'

const env={AUTH_SECRET:'synthetic-runtime-auth-secret-32',ADMIN_TOKEN:'synthetic-runtime-admin',DINGTALK_APP_KEY:'synthetic-runtime-client',DINGTALK_APP_SECRET:'synthetic-runtime-secret',DINGTALK_ROBOT_CODE:'synthetic-runtime-robot'}
function timers(t){
  const active=new Map();let created=0,cleared=0
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{assert.equal(delay,8000);const id=++created;active.set(id,callback);return id})
  t.mock.method(globalThis,'clearTimeout',id=>{if(active.delete(id))cleared++})
  return {active,get created(){return created},get cleared(){return cleared},expire(){const callback=active.values().next().value;assert.ok(callback);callback()}}
}
function withoutTimeout(t){
  const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout')
  Object.defineProperty(AbortSignal,'timeout',{configurable:true,writable:true,value:undefined})
  t.after(()=>Object.defineProperty(AbortSignal,'timeout',descriptor))
}

test('OAuth and both credentials-only probes work without AbortSignal.timeout and clean their timers',async(t)=>{
  withoutTimeout(t)
  const clock=timers(t),paths=[]
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    const path=new URL(String(input)).pathname;paths.push(path)
    assert.equal(options.redirect,'manual')
    assert.ok(options.signal instanceof AbortSignal)
    if(path==='/v1.0/oauth2/userAccessToken')return Response.json({accessToken:'synthetic-user-token'})
    if(path==='/gettoken')return Response.json({errcode:0,access_token:'synthetic-app-token'})
    if(path==='/v1.0/oauth2/accessToken')return Response.json({accessToken:'synthetic-app-token'})
    assert.fail('must not call a message endpoint')
  })
  assert.equal((await createDingTalk(env).exchangeUserCode('synthetic-code')).ok,true)
  const response=await createApp({store:createMemoryStore(),env}).request('/api/debug/dingtalk?credentialsOnly=1',{headers:{'x-admin-token':env.ADMIN_TOKEN}})
  const data=await response.json()
  assert.deepEqual(data.runtime,{abortController:true,abortSignalTimeout:false})
  assert.equal(data.oapi.ok,true);assert.equal(data.newApi.ok,true);assert.equal(data.robot.skipped,true)
  assert.deepEqual(paths,['/v1.0/oauth2/userAccessToken','/gettoken','/v1.0/oauth2/accessToken'])
  assert.equal(clock.created,3);assert.equal(clock.cleared,3);assert.equal(clock.active.size,0)
  assert.doesNotMatch(JSON.stringify(data),/synthetic-user-token|synthetic-app-token|synthetic-runtime-secret/)
})

test('the request deadline covers a slow body and reports a timeout without leaving a timer',async(t)=>{
  withoutTimeout(t)
  const clock=timers(t)
  let bodyStarted
  const started=new Promise(resolve=>bodyStarted=resolve)
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>new Response(new ReadableStream({
    start(controller){
      signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')),{once:true})
      bodyStarted()
    },
  })))
  const pending=createDingTalk(env).exchangeUserCode('synthetic-code')
  await started
  assert.equal(clock.active.size,1)
  clock.expire()
  assert.deepEqual(await pending,{ok:false,err:'request_timeout',status:0})
  assert.equal(clock.active.size,0);assert.equal(clock.cleared,1)
})

test('caller cancellation is forwarded and its listener is removed on completion and abort',async(t)=>{
  const clock=timers(t),external=new AbortController()
  let internal,started
  const arrived=new Promise(resolve=>started=resolve)
  const add=t.mock.method(external.signal,'addEventListener',external.signal.addEventListener.bind(external.signal))
  const remove=t.mock.method(external.signal,'removeEventListener',external.signal.removeEventListener.bind(external.signal))
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>{
    internal=signal
    return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});started()})
  })
  const pending=boundedDingTalkFetch('https://api.dingtalk.com/test',{signal:external.signal})
  await arrived
  assert.notEqual(internal,external.signal)
  external.abort()
  await assert.rejects(pending,error=>error.name==='AbortError')
  assert.equal(internal.aborted,true)
  assert.equal(add.mock.callCount(),1);assert.equal(remove.mock.callCount(),1)
  assert.equal(clock.active.size,0)
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>{internal=signal;assert.equal(signal.aborted,true);throw new DOMException('aborted','AbortError')})
  await assert.rejects(()=>boundedDingTalkFetch('https://api.dingtalk.com/test',{signal:external.signal}),error=>error.name==='AbortError')
  assert.equal(clock.active.size,0);assert.equal(clock.created,clock.cleared)
})

test('network/body failures and oversized responses release deadlines; redirects remain unsuccessful',async(t)=>{
  const clock=timers(t);let response
  t.mock.method(globalThis,'fetch',async()=>{if(response instanceof Error)throw response;return response})
  response=new TypeError('private network detail')
  await assert.rejects(()=>boundedDingTalkFetch('https://api.dingtalk.com/test'))
  assert.equal(clock.active.size,0)
  response=new Response(new ReadableStream({start(controller){controller.error(new Error('private body error'))}}))
  await assert.rejects(()=>boundedDingTalkFetch('https://api.dingtalk.com/test'))
  assert.equal(clock.active.size,0)
  response=new Response('x'.repeat(64*1024+1))
  await assert.rejects(()=>boundedDingTalkFetch('https://api.dingtalk.com/test'),/response too large/)
  assert.equal(clock.active.size,0)
  response=new Response(null,{status:302,headers:{location:'https://untrusted.example/private'}})
  assert.deepEqual(await createDingTalk(env).exchangeUserCode('synthetic-code'),{ok:false,err:'upstream_rejected',status:302})
  assert.equal(clock.active.size,0);assert.equal(clock.created,clock.cleared)
})

test('successful completion removes the caller listener before subsequent caller cancellation',async(t)=>{
  const clock=timers(t),external=new AbortController();let internal
  const remove=t.mock.method(external.signal,'removeEventListener',external.signal.removeEventListener.bind(external.signal))
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>{internal=signal;return Response.json({ok:true})})
  const response=await boundedDingTalkFetch('https://api.dingtalk.com/test',{signal:external.signal})
  assert.deepEqual(await response.json(),{ok:true})
  external.abort()
  assert.equal(internal.aborted,false)
  assert.equal(remove.mock.callCount(),1);assert.equal(clock.active.size,0)
})

test('the shared helper uses ArrayBuffer with a restricted Edge-style Response constructor',async(t)=>{
  withoutTimeout(t)
  const NativeResponse=globalThis.Response,bodyTypes=[]
  class RestrictedResponse extends NativeResponse {
    constructor(body,options){
      assert.equal(ArrayBuffer.isView(body),false,'Edge-style constructor does not accept a typed array')
      assert.ok(body==null || typeof body==='string' || body instanceof ArrayBuffer || body instanceof ReadableStream)
      bodyTypes.push(body instanceof ArrayBuffer?'arraybuffer':typeof body)
      super(body,options)
    }
  }
  t.mock.method(globalThis,'fetch',async(input)=>{
    const path=new URL(String(input)).pathname
    if(path==='/gettoken')return NativeResponse.json({errcode:0,access_token:'synthetic-oapi-token'})
    return NativeResponse.json({accessToken:'synthetic-new-token'})
  })
  Object.defineProperty(globalThis,'Response',{configurable:true,writable:true,value:RestrictedResponse})
  t.after(()=>Object.defineProperty(globalThis,'Response',{configurable:true,writable:true,value:NativeResponse}))
  assert.equal((await createDingTalk(env).exchangeUserCode('synthetic-code')).ok,true)
  const response=await createApp({store:createMemoryStore(),env}).request('/api/debug/dingtalk?credentialsOnly=1',{headers:{'x-admin-token':env.ADMIN_TOKEN}})
  const data=await response.json()
  assert.equal(data.oapi.ok,true);assert.equal(data.newApi.ok,true)
  assert.equal(data.oapi.jsonParsed,true);assert.equal(data.newApi.jsonParsed,true)
  assert.equal(bodyTypes.filter(type=>type==='arraybuffer').length,3)
})

test('credentials-only diagnostics distinguish malformed JSON from upstream rejection without returning headers or body',async(t)=>{
  const app=createApp({store:createMemoryStore(),env})
  let fixture
  t.mock.method(globalThis,'fetch',async()=>new Response(fixture.body,{status:fixture.status,headers:{'content-type':fixture.type,'content-encoding':fixture.encoding}}))
  for(fixture of [
    {body:'private-upstream-page',status:200,type:'text/html; private=header',encoding:'gzip',contentType:'html',contentEncoding:'gzip',jsonParsed:false,err:'invalid_response'},
    {body:'{}',status:200,type:'application/problem+json',encoding:'identity',contentType:'json',contentEncoding:'identity',jsonParsed:true,err:'invalid_response'},
    {body:'{"errcode":40096,"code":"invalid_client","message":"private-provider-message"}',status:400,type:'application/json',encoding:'private-header-value',contentType:'json',contentEncoding:'other',jsonParsed:true,err:'upstream_rejected'},
  ]){
    const response=await app.request('/api/debug/dingtalk?credentialsOnly=1',{headers:{'x-admin-token':env.ADMIN_TOKEN}})
    const data=await response.json()
    for(const result of [data.oapi,data.newApi]){
      assert.equal(result.ok,false);assert.equal(result.err,fixture.err)
      assert.equal(result.jsonParsed,fixture.jsonParsed)
      assert.equal(result.contentType,fixture.contentType)
      assert.equal(result.contentEncoding,fixture.contentEncoding)
      assert.equal(result.bodyBytes,new TextEncoder().encode(fixture.body).byteLength)
      assert.equal(result.bodyChunkType,'uint8array')
    }
    assert.doesNotMatch(JSON.stringify(data),/private-|invalid_client|40096/)
    assert.equal(data.robot.skipped,true)
  }
})

test('documented ArrayBuffer, offset views, strings and mixed chunks preserve exact bytes and OAuth tokens',async(t)=>{
  const body=JSON.stringify({accessToken:'synthetic-chunk-token',hint:'中文'})
  const bytes=new TextEncoder().encode(body)
  const backing=new Uint8Array(bytes.byteLength+8)
  backing.fill(120);backing.set(bytes,4)
  const cases=[
    {type:'arraybuffer',chunks:[bytes.buffer]},
    {type:'uint8array',chunks:[new Uint8Array(backing.buffer,4,bytes.byteLength)]},
    {type:'view',chunks:[new DataView(backing.buffer,4,bytes.byteLength)]},
    {type:'string',chunks:[body]},
    {type:'mixed',chunks:[bytes.buffer.slice(0,10),new DataView(bytes.buffer,10,8),new Uint8Array(bytes.buffer,18,bytes.byteLength-18)]},
  ]
  let fixture
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){for(const chunk of fixture.chunks)controller.enqueue(chunk);controller.close()}}),{headers:{'content-type':'application/json'}}))
  for(fixture of cases){
    const response=await boundedDingTalkFetch('https://api.dingtalk.com/test')
    const diagnostic=dingTalkResponseDiagnostics(response)
    assert.equal(diagnostic.bodyBytes,bytes.byteLength)
    assert.equal(Number.isInteger(diagnostic.bodyBytes),true)
    assert.equal(diagnostic.bodyChunkType,fixture.type)
    assert.deepEqual(await response.json(),JSON.parse(body),fixture.type)
    assert.deepEqual(await createDingTalk(env).exchangeUserCode('synthetic-code'),{ok:true,accessToken:'synthetic-chunk-token',corpId:''},fixture.type)
  }
})

test('unsupported and oversized string chunks fail safely, cancel the stream and clean timers',async(t)=>{
  const clock=timers(t);let chunk,cancelled=0
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){controller.enqueue(chunk)},cancel(){cancelled++}})))
  for(chunk of [{private:'must-not-appear'},'汉'.repeat(64*1024),'x'.repeat(64*1024+1)]){
    await assert.rejects(()=>boundedDingTalkFetch('https://api.dingtalk.com/test'),error=>{
      assert.match(error.message,/^DingTalk response (?:has an unsupported chunk type|too large)$/)
      return true
    })
    assert.equal(clock.active.size,0)
  }
  assert.equal(cancelled,3);assert.equal(clock.created,clock.cleared)
})
