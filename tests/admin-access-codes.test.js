import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createAdminAccessCodes } from '../packages/core/admin-access-codes.js'
import { issueToken } from '../packages/core/auth.js'
import { createMobileAtomicHttpHandler, createRemoteMobileAtomicStore } from '../packages/core/mobile-store.js'

const env={AUTH_SECRET:'access-code-test-signing-secret-32',ADMIN_TOKEN:'access-code-bootstrap-test',BUILDING_ID:'b1',HAIER_MODE:'mock'}
function atomicFixture(){const records=new Map();return {consistency:'linearizable',durable:true,records,async get(key){const row=records.get(key);return row?.expiresAt>Date.now()?structuredClone({version:row.version,value:row.value}):null},async compareAndSet(key,version,value,{expiresAt}){const row=records.get(key),current=row?.expiresAt>Date.now()?row:null;if((current?.version??null)!==version)return false;records.set(key,{version:crypto.randomUUID(),value:structuredClone(value),expiresAt});return true}}}
async function setup({atomic=true}={}){
  const store=createMemoryStore(),atomicStore=atomic?atomicFixture():undefined
  for(const [id,dorm] of [['chief','guiyuan'],['manager','guiyuan'],['gui','guiyuan'],['liu','liuyuan']])await store.put('user:'+id,{id,nick:id,dormBuilding:dorm})
  await store.put('meta:siteAdmins',[{userId:'chief',role:'super'},{userId:'manager',role:'admin'}])
  const app=createApp({store,env,mobile:{atomicStore}})
  const call=async(path,{method='GET',body,session,bootstrap=false,user,key,application=app}={})=>{
    const headers={'content-type':'application/json'}
    if(bootstrap||session)headers['x-admin-token']=session||env.ADMIN_TOKEN
    if(user)headers.authorization='Bearer '+await issueToken(user,env.AUTH_SECRET)
    if(key)headers['Idempotency-Key']=key
    const response=await application.request(path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})})
    const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=null}
    return {status:response.status,data,text,headers:response.headers}
  }
  const create=async(body={name:'值班口令'},extra={})=>call('/api/admin/access-codes',{method:'POST',body,bootstrap:true,key:crypto.randomUUID(),...extra})
  const login=async(code)=>call('/api/admin/login',{method:'POST',body:{token:code}})
  return {store,atomicStore,app,call,create,login}
}

test('temporary code is returned once, hashed at rest, and defaults to 12-hour admin permissions',async()=>{
  const f=await setup(),created=await f.create({name:'值班',note:'本次巡查'})
  assert.equal(created.status,200,created.text)
  assert.match(created.data.code,/^wac1\.ac_[a-f0-9]{32}\.[a-f0-9]{64}$/)
  assert.equal(created.data.accessCode.expiresAt-created.data.accessCode.createdAt,12*3600000)
  const persisted=JSON.stringify([...f.atomicStore.records])+JSON.stringify(await f.store.list(''))
  assert.equal(persisted.includes(created.data.code),false)
  assert.equal(persisted.includes(created.data.code.split('.')[2]),false)
  const listed=await f.call('/api/admin/access-codes',{bootstrap:true})
  assert.equal(listed.status,200);assert.equal(listed.text.includes(created.data.code),false)
  assert.equal(listed.data.codes[0].prefix,created.data.accessCode.prefix)
  const logged=await f.login(created.data.code)
  assert.equal(logged.status,200,logged.text);assert.equal(logged.data.role,'admin')
  assert.equal(logged.data.permissions.adminUsers.operate,true)
  assert.equal(logged.data.permissions.adminSystem.view,false)
  assert.equal(logged.data.permissions.adminAssistant.operate,false)
  const session=logged.data.session
  assert.equal((await f.call('/api/admin/users',{session})).status,200)
  const state=await f.call('/api/admin/session',{session});assert.equal(state.data.kind,'temporary');assert.equal(state.data.identity.role,'admin')
  assert.ok(state.data.expAt<=created.data.accessCode.expiresAt)
  for(const path of ['/api/admin/access-codes','/api/admin/permissions','/api/admin/accounts','/api/admin/diag-haier']){
    assert.equal((await f.call(path,{session,user:'chief'})).status,403,path)
  }
  assert.equal((await f.call('/api/admin/site',{session,user:'chief',method:'PATCH',body:{credentials:{appSecret:'must-not-save'}}})).status,403)
  assert.equal((await f.call('/api/admin/user/chief',{session,user:'chief',method:'POST',body:{nick:'must-not-change'}})).status,403)
  assert.equal((await f.store.get('user:chief')).nick,'chief')
})

test('only super can manage codes; duration, role escalation and invalid scopes are rejected',async()=>{
  const f=await setup()
  assert.equal((await f.create({name:'拒绝'}, {bootstrap:false,user:'manager'})).status,403)
  assert.equal((await f.call('/api/admin/access-codes',{user:'chief'})).status,200)
  for(const body of [{name:'x',ttlHours:721},{name:'x',ttlHours:0},{name:'x',role:'super'},{name:'x',permissions:{adminSystem:{view:true}}},{name:'x',permissions:{adminUsers:{viewBuildings:['unknown']}}}]){
    const result=await f.create(body);assert.equal(result.status,400,result.text);assert.ok(result.data.error.eventId);assert.equal(result.data.error.status,400)
  }
  assert.equal((await f.create({name:'最长',ttlHours:720})).status,200)
})

test('scoped temporary admin cannot read, modify, export or batch outside its grant',async()=>{
  const f=await setup(),created=await f.create({name:'单楼管理员',permissions:{adminUsers:{view:true,operate:true,viewBuildings:['guiyuan'],operateBuildings:['guiyuan']},adminMachines:{view:false,operate:false}}})
  const {session}= (await f.login(created.data.code)).data
  const users=await f.call('/api/admin/users',{session,user:'chief'})
  assert.equal(users.status,200,users.text)
  assert.ok(users.data.items.every(row=>row.dormBuilding==='guiyuan'))
  assert.equal((await f.call('/api/admin/user/liu',{session})).status,403)
  assert.equal((await f.call('/api/admin/user/liu',{session,method:'POST',body:{nick:'不得改'}})).status,403)
  assert.equal((await f.call('/api/admin/machines',{session,user:'chief'})).status,403)
  const exported=await f.call('/api/admin/users.csv',{session});assert.equal(exported.status,200);assert.equal(exported.text.includes('liu'),false)
  const batch=await f.call('/api/admin/users/batch',{session,method:'POST',body:{action:'setNotify',ids:['gui','liu'],notifyOn:false,confirmed:true}})
  assert.equal(batch.status,200,batch.text)
  assert.equal((await f.store.get('user:liu')).notifyOn,undefined)
})

test('revocation invalidates every derived session on another app instance immediately',async()=>{
  const f=await setup(),created=await f.create(),first=await f.login(created.data.code),second=await f.login(created.data.code)
  const other=createApp({store:f.store,env,mobile:{atomicStore:f.atomicStore}})
  assert.equal((await f.call('/api/admin/users',{session:first.data.session,application:other})).status,200)
  const revoke=await f.call('/api/admin/access-codes/'+created.data.accessCode.id,{method:'DELETE',bootstrap:true})
  assert.equal(revoke.status,200,revoke.text)
  for(const session of [first.data.session,second.data.session]){
    const result=await f.call('/api/admin/users',{session,user:'chief',application:other})
    assert.equal(result.status,401,result.text);assert.ok(result.data.error.eventId)
  }
  assert.equal((await f.login(created.data.code)).status,401)
  assert.equal((await f.call('/api/admin/access-codes/'+created.data.accessCode.id,{method:'DELETE',bootstrap:true})).status,200)
})

test('concurrent creation is idempotent without storing or replaying the one-time credential',async()=>{
  const f=await setup(),key='same-creation-request',results=await Promise.all(Array.from({length:8},()=>f.create({name:'只创建一次'},{key})))
  assert.equal(results.filter(row=>row.status===200).length,1)
  assert.ok(results.filter(row=>row.status!==200).every(row=>row.status===409))
  const created=results.find(row=>row.status===200),rows=(await f.call('/api/admin/access-codes',{bootstrap:true})).data.codes
  assert.equal(rows.length,1)
  assert.equal(JSON.stringify(await f.store.list('')).includes(created.data.code),false)
  assert.equal((await f.create({name:'换内容'},{key})).data.error.code,'idempotency_conflict')
})

test('expiry and unavailable atomic authority fail closed while static ADMIN_TOKEN remains compatible',async()=>{
  const f=await setup(),created=await f.create(),logged=await f.login(created.data.code)
  const registry=f.atomicStore.records.get('mobile:admin-access-codes:registry')
  registry.value.codes[0].expiresAt=Date.now()-1
  assert.equal((await f.call('/api/admin/users',{session:logged.data.session})).status,401)
  f.atomicStore.get=async()=>{throw new Error('fixture outage')}
  assert.equal((await f.call('/api/admin/users',{session:logged.data.session,user:'chief'})).status,503)
  assert.equal((await f.call('/api/admin/users',{bootstrap:true})).status,200)
  const unconfigured=await setup({atomic:false})
  assert.equal((await unconfigured.create()).status,503)
  assert.equal((await unconfigured.call('/api/admin/users',{bootstrap:true})).status,200)
})

test('atomic bridge admits only the reserved admin-code namespace and never returns plaintext',async()=>{
  const atomicStore=atomicFixture(),secret='internal-bridge-test-secret-at-least32'
  const handler=createMobileAtomicHttpHandler({atomicStore,secret})
  const remote=createRemoteMobileAtomicStore({MOBILE_ATOMIC_STORE_URL:'https://bridge.invalid',MOBILE_ATOMIC_STORE_SECRET:secret},async(url,options)=>{
    const result=await handler({httpMethod:'POST',headers:options.headers,body:options.body})
    return new Response(result.body,{status:result.statusCode,headers:result.headers})
  })
  const service=createAdminAccessCodes({atomicStore:remote,authSecret:env.AUTH_SECRET})
  const created=await service.create({name:'桥接创建'},{actor:'bootstrap',key:'bridge-test-request',buildings:[]})
  assert.equal((await service.list()).length,1)
  assert.equal(JSON.stringify([...atomicStore.records]).includes(created.code),false)
  await assert.rejects(remote.get('admin-access-codes:registry'))
})
