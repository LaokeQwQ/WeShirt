import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET='building-management-integration-secret'
const PHOTO='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8kQAAAAASUVORK5CYII='
const buildings=[{code:'guiyuan',name:'桂园'},{code:'liuyuan',name:'柳园',enabled:false},{code:'meiyuan',name:'梅园'},{code:'zhuyuan',name:'竹园'}]
const clone=value=>value===undefined?undefined:structuredClone(value)
async function fixture(t,{broadcast=false,dm=false}={}){
 const backing=createMemoryStore()
 const store={get:async(key,fallback=null)=>clone(await backing.get(key,fallback)),put:async(key,value)=>backing.put(key,clone(value)),del:key=>backing.del(key),list:async prefix=>clone(await backing.list(prefix))}
 const sent=[]
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(broadcast&&String(url)==='https://notify.example.test/group'){sent.push(JSON.parse(options.body));return new Response(JSON.stringify({errcode:0}))}
  if(dm&&String(url)==='https://api.dingtalk.com/v1.0/oauth2/accessToken')return Response.json({accessToken:'local-building-notifications-token',expireIn:300})
  if(dm&&String(url)==='https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'){sent.push(JSON.parse(options.body));return Response.json({ok:true})}
  throw Error('Unexpected outbound request blocked by local fixture')
 })
 const env={AUTH_SECRET:SECRET,ADMIN_TOKEN:'building-management-bootstrap',BUILDING_ID:'b1',HAIER_MODE:'mock',...(broadcast?{DINGTALK_WEBHOOK:'https://notify.example.test/group'}:{}),...(dm?{DINGTALK_APP_KEY:'local-building-notifications-app',DINGTALK_APP_SECRET:'local-fixture-secret',DINGTALK_ROBOT_CODE:'local-fixture-robot'}:{})}
 await store.put('meta:site',{buildings})
 await store.put('meta:siteAdmins',[{userId:'chief',role:'super'},{userId:'manager',role:'admin'},{userId:'volunteer',role:'volunteer',buildings:['guiyuan','liuyuan']}])
 const tokens={}
 for(const id of ['user','resident','manager','chief','volunteer']){
  await store.put('user:'+id,{id,nick:'管理测试-'+id,dingUserId:'synthetic-'+id,notifyOn:false,dormBuilding:id==='resident'?'liuyuan':id==='user'?null:'guiyuan'})
  tokens[id]=await issueToken(id,SECRET)
 }
 const now=new Date().toISOString()
 await store.put('meta:sync',{lastAttemptAt:Date.now(),lastFetchAt:now})
 await store.put('operations:config',{broadcast:{enabled:broadcast,startHour:8,endHour:22}})
 await store.put('mapping:b1',{mapping:{'1':'g1'}})
 await store.put('machines:b1',{board:{buildingId:'b1',updatedAt:now,floors:[{code:'1F',machines:[
  {id:'g1',name:'桂园机器',dormBuilding:'guiyuan',state:'idle',rawState:'1',kind:'washer'},
  {id:'l_anonymous',name:'设备A',dormBuilding:'liuyuan',state:'idle',rawState:'1',kind:'washer'},
  {id:'l_named',name:'柳园停用机器',dormBuilding:'liuyuan',state:'idle',rawState:'1',kind:'washer'},
 ]}]}})
 const app=createApp({store,env})
 const call=async(path,{user,bootstrap=false,method='GET',body}={})=>{
  const headers={'content-type':'application/json'}
  if(user)headers.authorization='Bearer '+tokens[user]
  if(bootstrap)headers['x-admin-token']=env.ADMIN_TOKEN
  const response=await app.request(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)})
  return {status:response.status,data:await response.json(),headers:response.headers}
 }
 return {call,store,sent,env}
}
const ids=result=>result.data.board.floors.flatMap(f=>f.machines).map(m=>m.id)
const rejected=result=>assert.ok(result.status>=400&&result.status<500,JSON.stringify(result))

test('disabled buildings disappear from public catalog and implicit machine reads, including anonymous devices',async t=>{
 const {call}=await fixture(t)
 assert.deepEqual((await call('/api/site')).data.buildings.map(b=>b.code),['guiyuan','meiyuan','zhuyuan'])
 assert.deepEqual(ids(await call('/api/machines')),['g1'])
 assert.deepEqual(ids(await call('/api/machines',{user:'resident'})),['g1'])
 rejected(await call('/api/machines?dorm=liuyuan'))
})

test('disabled machine IDs cannot bypass task registration or queue creation by omitting dorm',async t=>{
 const {call,store}=await fixture(t)
 for(const machineId of ['l_anonymous','l_named']){
  rejected(await call('/api/tasks',{user:'user',method:'POST',body:{machineId,minutes:30}}))
  rejected(await call('/api/queue',{user:'user',method:'POST',body:{machineId}}))
 }
 assert.deepEqual(await store.get('tasks:user',[]),[])
 assert.deepEqual(await store.get('queue:b1',[]),[])
})

test('implicit queue reads exclude existing disabled machine records',async t=>{
 const {call,store}=await fixture(t)
 const at=new Date().toISOString(),endAt=new Date(Date.now()+30*60000).toISOString()
 await store.put('queue:b1',[{id:'q_disabled',userId:'resident',machineId:'l_named',nick:'测试',at,durationMin:30}])
 await store.put('tasks:resident',[{id:'task_disabled',machineId:'l_named',startAt:at,endAt,done:false}])
 await store.put('occupancy:b1',{l_named:{userId:'resident',taskId:'task_disabled',nick:'测试',startAt:at,endAt}})
 assert.deepEqual((await call('/api/queue')).data.queue,[])
 rejected(await call('/api/queue?dorm=liuyuan'))
})

test('implicit occupancy reads exclude existing disabled machine records',async t=>{
 const {call,store}=await fixture(t)
 const at=new Date().toISOString(),endAt=new Date(Date.now()+30*60000).toISOString()
 await store.put('tasks:resident',[{id:'task_disabled',machineId:'l_named',startAt:at,endAt,done:false}])
 await store.put('occupancy:b1',{l_named:{userId:'resident',taskId:'task_disabled',nick:'测试',startAt:at,endAt}})
 assert.deepEqual((await call('/api/occupancy')).data.occupancy,{})
 assert.deepEqual((await call('/api/occupancy?machineId=l_named')).data.occupancy,{})
})

test('disabled building cannot leak into implicit inspection machine lists',async t=>{
 const {call,store}=await fixture(t)
 for(const user of ['manager','volunteer']){
  const list=await call('/api/inspections',{user})
  assert.equal(list.status,200)
  assert.deepEqual(list.data.machines.map(m=>m.id),['g1'])
 }
})

test('disabled building cannot receive new inspection reports even through a still-existing volunteer scope',async t=>{
 const {call,store}=await fixture(t)
 for(const user of ['manager','volunteer']){
  for(const machineId of ['l_anonymous','l_named'])rejected(await call('/api/inspections',{user,method:'POST',body:{machineId,status:'normal',note:'仅限已启用楼栋',photoData:PHOTO}}))
 }
 assert.deepEqual(await store.get('inspections:b1',[]),[])
})

test('disabled resident favorites remain stored but cannot be viewed as available or modified',async t=>{
 const {call,store}=await fixture(t)
 await store.put('laundry-preferences:resident',{favorites:['l_named'],enabled:false,timeWindows:[]})
 const view=await call('/api/user/laundry-preferences',{user:'resident'})
 assert.equal(view.status,200);assert.deepEqual(view.data.machines,[])
 rejected(await call('/api/user/favorites/toggle',{user:'resident',method:'POST',body:{machineId:'l_named'}}))
 rejected(await call('/api/user/profile',{user:'user',method:'POST',body:{dormBuilding:'liuyuan'}}))
 assert.equal((await store.get('user:resident')).dormBuilding,'liuyuan')
 assert.deepEqual((await store.get('laundry-preferences:resident')).favorites,['l_named'])
})

test('admin can identify and filter residents of a disabled building and reassign without spending a user change',async t=>{
 const {call,store}=await fixture(t)
 const resident=await store.get('user:resident');resident.dormChangeCount=1;await store.put('user:resident',resident)
 const detail=await call('/api/admin/user/resident',{user:'manager'})
 assert.equal(detail.status,200);assert.equal(detail.data.user.dormBuilding,'liuyuan')
 const filtered=await call('/api/admin/users?dorm=liuyuan',{user:'manager'})
 assert.equal(filtered.status,200);assert.deepEqual(filtered.data.items.map(u=>u.id),['resident'])
 const machines=await call('/api/admin/machines?dorm=liuyuan',{user:'manager'})
 assert.equal(machines.status,200);assert.deepEqual(machines.data.rows.map(m=>m.id).sort(),['l_anonymous','l_named'])
 const changed=await call('/api/admin/user/resident',{user:'manager',method:'POST',body:{dormBuilding:'meiyuan'}})
 assert.equal(changed.status,200,JSON.stringify(changed.data))
 assert.equal((await store.get('user:resident')).dormChangeCount,1)
 assert.equal((await call('/api/auth/me',{user:'resident'})).data.user.dormChangesRemaining,0)
 const free=await call('/api/admin/user/user',{user:'manager',method:'POST',body:{dormBuilding:'guiyuan'}})
 assert.equal(free.status,200)
 assert.equal((await call('/api/auth/me',{user:'user'})).data.user.dormChangesRemaining,1)
})

test('first selection is free, parallel changes consume exactly one allowance, and client counters cannot reset it',async t=>{
 const {call,store}=await fixture(t)
 assert.equal((await call('/api/user/profile',{user:'user',method:'POST',body:{dormBuilding:'guiyuan'}})).data.user.dormChangesRemaining,1)
 const results=await Promise.all(['meiyuan','zhuyuan'].map(dormBuilding=>call('/api/user/profile',{user:'user',method:'POST',body:{dormBuilding,dormChangeCount:-100}})))
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409])
 assert.equal((await store.get('user:user')).dormChangeCount,1)
 const latest=(await store.get('user:user')).dormBuilding
 assert.equal((await call('/api/user/profile',{user:'user',method:'POST',body:{dormBuilding:latest,dormChangeCount:0}})).status,200)
 const other=latest==='guiyuan'?'meiyuan':'guiyuan'
 const denied=await call('/api/user/profile',{user:'user',method:'POST',body:{dormBuilding:other,dormChangeCount:0,nick:'不得部分写入'}})
 assert.equal(denied.status,409);assert.equal(denied.data.error.code,'dorm_change_limit')
 assert.equal((await store.get('user:user')).nick,'管理测试-user')
})

test('protected ingest hourly broadcast excludes disabled building machines without deleting diagnostic snapshots',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,10,10,0,1)})
 const {call,store,sent}=await fixture(t,{broadcast:true})
 const ingested=await call('/api/cron/ingest',{bootstrap:true,method:'POST',body:{raws:[
  {id:'g1',name:'桂园启用机器',floorCode:'1F',state:1,categoryCode:'00',finishTime:null},
  {id:'l_named',name:'柳园停用机器',floorCode:'1F',state:1,categoryCode:'00',finishTime:null},
 ]}})
 assert.equal(ingested.status,200);assert.equal(ingested.data.ok,true,JSON.stringify(ingested.data))
 assert.ok(sent.length>0,'the local webhook mock should receive the enabled hourly summary')
 assert.equal(JSON.stringify(sent).includes('柳园停用机器'),false,'disabled machine must not enter a broadcast payload')
 assert.match(sent[0].text.content,/洗衣机 1\/1 空闲/,'summary counts must exclude disabled devices')
 assert.doesNotMatch(sent[0].text.content,/洗衣机 2\/2 空闲/)
 assert.equal((await store.get('machines:b1')).board.floors.flatMap(f=>f.machines).length,2,'diagnostic raw snapshot remains complete')
})

test('protected ingest sends only enabled queue reminders and suppresses old disabled task reminders',async t=>{
 const {call,store,sent}=await fixture(t,{dm:true})
 for(const id of ['user','resident']){const user=await store.get('user:'+id);await store.put('user:'+id,{...user,notifyOn:true})}
 const at=new Date(Date.now()-60000).toISOString(),finishTime=new Date(Date.now()+2*60000).toISOString()
 await store.put('queue:b1',[
  {id:'q_enabled',userId:'user',machineId:'g1',at},
  {id:'q_disabled',userId:'resident',machineId:'l_named',at},
 ])
 await store.put('tasks:resident',[{id:'old_disabled_task',machineId:'l_named',startAt:at,endAt:new Date(Date.now()-1000).toISOString(),done:false}])
 const result=await call('/api/cron/ingest',{bootstrap:true,method:'POST',body:{raws:[
  {id:'g1',name:'桂园启用机器',floorCode:'1F',state:2,categoryCode:'00',finishTime},
  {id:'l_named',name:'柳园停用机器',floorCode:'1F',state:2,categoryCode:'00',finishTime},
 ]}})
 assert.equal(result.status,200);assert.equal(result.data.ok,true,JSON.stringify(result.data))
 assert.equal(result.data.queueReminders.sent,1)
 assert.equal(result.data.notified,0)
 assert.deepEqual(sent.map(item=>item.userIds),[['synthetic-user']])
 assert.deepEqual(await store.get('queue-notices:resident',[]),[])
 assert.equal((await store.get('tasks:resident'))[0].notified,undefined)
 assert.equal((await store.get('machines:b1')).board.total,2)
})

test('site enabled state takes effect immediately in the same app and re-enabling preserves machine bindings',async t=>{
 const {call}=await fixture(t)
 const enabled=buildings.map(building=>({...building,enabled:true}))
 const changed=await call('/api/admin/site',{bootstrap:true,method:'PATCH',body:{buildings:enabled}})
 assert.equal(changed.status,200,JSON.stringify(changed.data))
 assert.deepEqual(ids(await call('/api/machines?dorm=liuyuan')).sort(),['l_anonymous','l_named'])
 const selected=await call('/api/user/profile',{user:'user',method:'POST',body:{dormBuilding:'liuyuan'}})
 assert.equal(selected.status,200)
 assert.equal((await call('/api/admin/site',{bootstrap:true,method:'PATCH',body:{buildings}})).status,200)
 rejected(await call('/api/machines?dorm=liuyuan'))
 assert.deepEqual(ids(await call('/api/machines')),['g1'])
})

test('a scoped authenticated board response is never publicly cacheable across accounts',async t=>{
 const {call}=await fixture(t)
 const saved=await call('/api/admin/permissions/user',{bootstrap:true,method:'PATCH',body:{permissions:{board:{view:true,operate:false,viewBuildings:['guiyuan'],operateBuildings:[]}}}})
 assert.equal(saved.status,200,JSON.stringify(saved.data))
 const scoped=await call('/api/machines',{user:'user'})
 assert.equal(scoped.status,200);assert.deepEqual(ids(scoped),['g1'])
 assert.match(scoped.headers.get('cache-control')||'',/private|no-store/)
 const anonymous=await call('/api/machines')
 assert.match(anonymous.headers.get('vary')||'',/authorization/i)
})
