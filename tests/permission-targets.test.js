import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET='permission-targets-local-test-secret'
const scoped=()=>({view:true,operate:true,viewBuildings:['guiyuan'],operateBuildings:['guiyuan']})
async function fixture(t){
  const store=createMemoryStore(),env={AUTH_SECRET:SECRET,ADMIN_TOKEN:'permission-targets-bootstrap',BUILDING_ID:'b1',HAIER_MODE:'mock',SYNC_STALE_MS:86400000}
  for(const [id,dormBuilding] of [['chief','guiyuan'],['manager','guiyuan'],['u_gui','guiyuan'],['u_liu','liuyuan'],['vol_gui','guiyuan'],['vol_liu','liuyuan'],['delete_gui','guiyuan'],['delete_liu','liuyuan']])await store.put('user:'+id,{id,nick:id,dormBuilding,notifyOn:false})
  await store.put('meta:siteAdmins',[{userId:'chief',role:'super'},{userId:'manager',role:'admin'},{userId:'vol_gui',role:'volunteer',buildings:['guiyuan']},{userId:'vol_liu',role:'volunteer',buildings:['liuyuan']}])
  const machines=[{id:'g1',name:'Gui washer',state:'idle',dormBuilding:'guiyuan',kind:'washer'},{id:'l1',name:'Liu washer',state:'idle',dormBuilding:'liuyuan',kind:'washer'}]
  await store.put('machines:b1',{board:{floors:[{code:'1',machines}],total:2,idle:2,updatedAt:new Date().toISOString()}})
  await store.put('meta:sync',{lastAttemptAt:Date.now(),lastFetchAt:new Date().toISOString()})
  await store.put('mapping:b1',{mapping:{'1':'g1'},updatedAt:new Date().toISOString()})
  await store.put('occupancy:b1',{g1:{userId:'u_gui'},l1:{userId:'u_liu'}})
  await store.put('queue:b1',[{id:'q_gui',machineId:'g1',userId:'u_gui'},{id:'q_liu',machineId:'l1',userId:'u_liu'}])
  await store.put('messages:b1',[
    {id:'m_gui',userId:'vol_gui',channel:'guiyuan',text:'Gui notice',at:new Date().toISOString()},
    {id:'m_liu',userId:'vol_liu',channel:'liuyuan',text:'Liu notice',at:new Date().toISOString()},
    {id:'m_public',userId:'vol_gui',channel:'public',text:'Public notice',at:new Date().toISOString()},
  ])
  await store.put('announcements',[
    {id:'a_gui',version:1,title:'Gui notice',markdown:'original',dormBuilding:'guiyuan'},
    {id:'a_liu',version:1,title:'Liu notice',markdown:'original',dormBuilding:'liuyuan'},
  ])
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('No external requests')})
  const tokens={chief:await issueToken('chief',SECRET),manager:await issueToken('manager',SECRET)}
  const app=createApp({store,env})
  const call=async(path,{user='manager',method='GET',body}={})=>{
    const response=await app.request(path,{method,headers:{authorization:'Bearer '+tokens[user],'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
    return {status:response.status,data:await response.json()}
  }
  const grant=await call('/api/admin/permissions/manager',{user:'chief',method:'PATCH',body:{permissions:Object.fromEntries(['adminUsers','adminMachines','adminMessages','adminAnnouncements'].map(key=>[key,scoped()]))}})
  assert.equal(grant.status,200,JSON.stringify(grant.data))
  return {store,call,fetch}
}
const snapshot=async(store,keys)=>structuredClone(await Promise.all(keys.map(async key=>[key,await store.get(key,null)])))

test('scoped admin global writes reject missing or forged dorm targets and preserve all affected records',async t=>{
  const {store,call,fetch}=await fixture(t)
  const keys=['messages:b1','mapping:b1',...(await store.list('user:')).map(row=>row.key)]
  const before=await snapshot(store,keys)
  for(const extra of [undefined,{}, {dormBuilding:'guiyuan'}, {dorm:'guiyuan',channel:'guiyuan',dormBuilding:'guiyuan',machineId:'g1',userId:'u_gui',id:'a_gui'}]){
    for(const [path,method,body] of [
      ['/api/admin/messages','DELETE',extra],
      ['/api/admin/backfill-ding-profile?apply=1','POST',extra],
      ['/api/mapping','POST',{mapping:{'1':'l1'},...extra}],
    ]){
      const denied=await call(path,{method,body})
      assert.equal(denied.status,403,path+' '+JSON.stringify(extra))
      assert.equal(denied.data.error.code,'forbidden')
      assert.deepEqual(await snapshot(store,keys),before,path)
    }
  }
  assert.equal(fetch.mock.callCount(),0)
})

test('single-user writes derive the saved user scope and check destination buildings',async t=>{
  const {store,call}=await fixture(t)
  assert.equal((await call('/api/admin/user/u_gui',{method:'POST',body:{nick:'Allowed'}})).status,200)
  assert.equal((await store.get('user:u_gui')).nick,'Allowed')
  const outside=structuredClone(await store.get('user:u_liu'))
  assert.equal((await call('/api/admin/user/u_liu',{method:'POST',body:{nick:'Forbidden',dormBuilding:'guiyuan'}})).status,403)
  assert.deepEqual(await store.get('user:u_liu'),outside)
  assert.equal((await call('/api/admin/user/u_gui',{method:'POST',body:{dormBuilding:'liuyuan'}})).status,403)
  assert.equal((await call('/api/admin/user/missing',{method:'POST',body:{nick:'Missing',dormBuilding:'guiyuan'}})).status,403)
  for(const prefix of ['user','users']){
    assert.equal((await call('/api/admin/'+prefix+'/delete_liu',{method:'DELETE',body:{dormBuilding:'guiyuan'}})).status,403)
    assert.ok(await store.get('user:delete_liu'))
  }
  assert.equal((await call('/api/admin/users/delete_gui',{method:'DELETE'})).status,200)
  assert.equal(await store.get('user:delete_gui',null),null)
})

test('single-machine actions authorize the saved machine, never machineId or dorm supplied in the body',async t=>{
  const {store,call}=await fixture(t)
  for(const action of ['clear-occupancy','clear-queue']){
    const before=await snapshot(store,['occupancy:b1','queue:b1'])
    assert.equal((await call('/api/admin/machine/l1/'+action,{method:'POST',body:{machineId:'g1',dormBuilding:'guiyuan'}})).status,403)
    assert.equal((await call('/api/admin/machine/missing/'+action,{method:'POST',body:{machineId:'g1',dormBuilding:'guiyuan'}})).status,403)
    assert.deepEqual(await snapshot(store,['occupancy:b1','queue:b1']),before)
    assert.equal((await call('/api/admin/machine/g1/'+action,{method:'POST',body:{}})).status,200)
  }
  assert.equal((await store.get('occupancy:b1')).g1,undefined)
  assert.ok((await store.get('occupancy:b1')).l1)
  assert.deepEqual((await store.get('queue:b1')).map(row=>row.machineId),['l1'])
})

test('message delete and pin routes use the existing message channel for scope',async t=>{
  const {store,call}=await fixture(t)
  const before=structuredClone(await store.get('messages:b1'))
  for(const [path,method] of [['/api/admin/message/m_liu','DELETE'],['/api/messages/m_liu','DELETE'],['/api/messages/m_liu/pin','POST'],['/api/messages/m_liu/pin','PATCH'],['/api/admin/message/missing','DELETE'],['/api/messages/m_public/pin','POST']]){
    assert.equal((await call(path,{method,body:{pinned:true,channel:'guiyuan',dormBuilding:'guiyuan',userId:'u_gui'}})).status,403,path)
    assert.deepEqual(await store.get('messages:b1'),before)
  }
  assert.equal((await call('/api/messages/m_gui/pin',{method:'POST',body:{pinned:true}})).status,200)
  assert.equal((await store.get('messages:b1')).find(row=>row.id==='m_gui').pinned,true)
  assert.equal((await call('/api/admin/message/m_gui',{method:'DELETE'})).status,200)
  assert.deepEqual((await store.get('messages:b1')).map(row=>row.id),['m_liu','m_public'])
})

test('mute and unmute derive the current target user building, including body spoofing and moved users',async t=>{
  const {store,call}=await fixture(t)
  assert.equal((await call('/api/moderation/mutes',{method:'POST',body:{userId:'u_gui',durationMinutes:60}})).status,200)
  const before=structuredClone(await store.get('moderation:mutes'))
  assert.equal((await call('/api/moderation/mutes',{method:'POST',body:{userId:'u_liu',durationMinutes:null,dormBuilding:'guiyuan'}})).status,403)
  assert.deepEqual(structuredClone(await store.get('moderation:mutes')),before)
  await store.put('moderation:mutes',{...before,u_liu:{userId:'u_liu',until:null,at:new Date().toISOString()}})
  const both=structuredClone(await store.get('moderation:mutes'))
  for(const uid of ['u_liu','missing']){
    assert.equal((await call('/api/moderation/mutes/'+uid,{method:'DELETE',body:{userId:'u_gui',dormBuilding:'guiyuan'}})).status,403)
    assert.deepEqual(structuredClone(await store.get('moderation:mutes')),both)
  }
  assert.equal((await call('/api/moderation/mutes/u_gui',{method:'DELETE'})).status,200)
  assert.equal((await store.get('moderation:mutes')).u_gui,undefined)
  assert.ok((await store.get('moderation:mutes')).u_liu)
  await store.put('user:u_liu',{...await store.get('user:u_liu'),dormBuilding:'guiyuan'})
  assert.equal((await call('/api/moderation/mutes/u_liu',{method:'DELETE'})).status,200)
  assert.deepEqual(Object.keys(await store.get('moderation:mutes')),[])
})

test('scoped admin targets cannot switch legacy data namespaces through the building query',async t=>{
  const {store,call}=await fixture(t)
  await store.put('occupancy:other-source',{g1:{userId:'u_liu'}})
  await store.put('messages:other-source',[{id:'m_gui',userId:'u_liu',channel:'liuyuan',text:'Other source'}])
  const keys=['occupancy:other-source','messages:other-source'],before=await snapshot(store,keys)
  for(const [path,method] of [['/api/admin/machine/g1/clear-occupancy?building=other-source','POST'],['/api/admin/message/m_gui?building=other-source','DELETE']]){
    assert.equal((await call(path,{method,body:{dormBuilding:'guiyuan'}})).status,403)
    assert.deepEqual(await snapshot(store,keys),before)
  }
})

test('announcement edits retain original/destination bounds and DELETE cannot spoof the URL target with body.id',async t=>{
  const {store,call}=await fixture(t)
  const before=structuredClone(await store.get('announcements'))
  for(const fields of [{id:'a_liu',dormBuilding:'guiyuan'},{id:'a_gui',dormBuilding:'liuyuan'},{id:'a_gui',dormBuilding:null},{id:'a_gui'},{id:'missing',dormBuilding:'guiyuan'}]){
    assert.equal((await call('/api/admin/announcements',{method:'POST',body:{title:'Forbidden',markdown:'new',version:1,...fields}})).status,403)
    assert.deepEqual(await store.get('announcements'),before)
  }
  assert.equal((await call('/api/admin/announcements/a_liu',{method:'DELETE',body:{id:'a_gui',dormBuilding:'guiyuan'}})).status,403)
  assert.deepEqual(await store.get('announcements'),before)
  assert.equal((await call('/api/admin/announcements',{method:'POST',body:{id:'a_gui',version:1,title:'Allowed',markdown:'new',dormBuilding:'guiyuan'}})).status,200)
  assert.equal((await call('/api/admin/announcements/a_gui',{method:'DELETE'})).status,200)
  assert.deepEqual((await store.get('announcements')).map(row=>row.id),['a_liu'])
})

test('all-building admin grants retain global mutations',async t=>{
  const {store,call}=await fixture(t)
  await store.del('access:user:manager')
  assert.equal((await call('/api/admin/messages',{method:'DELETE'})).status,200)
  assert.deepEqual(await store.get('messages:b1'),[])
})
