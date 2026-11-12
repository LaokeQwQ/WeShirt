import test from 'node:test'
import assert from 'node:assert/strict'
import {createMemoryStore} from '../packages/core/store.js'
import {evaluateMachineHealth,runOperations,resetHealthObservation,broadcastReviewWindow,normalizeOperationsConfig} from '../packages/core/operations.js'
import {processMachineFaultNotices} from '../packages/core/machine-fault-notices.js'
import {normalizeMachines} from '../packages/core/haier.js'
import {createMobilePush} from '../packages/core/mobile-push.js'
import {runSync} from '../server/app.js'

const AT=Date.parse('2026-11-10T00:00:00Z'),MINUTE=60000,EVENT='evt_1234567890abcdef12345678'
const catalog=[{code:'guiyuan',name:'桂园'},{code:'liuyuan',name:'柳园'}]
const board=(at=AT)=>({buildingId:'b1',updatedAt:new Date(at).toISOString(),floors:[{code:'1F',machines:[{id:'g1',name:'桂园洗衣机',dormBuilding:'guiyuan',state:'faulty',upstreamState:'faulty',health:{confirmedFault:true,eventId:EVENT}}]}]})
function atomicFixture(){const values=new Map();return {consistency:'linearizable',durable:true,async get(key){return structuredClone(values.get(key)||null)},async compareAndSet(key,version,value){if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:crypto.randomUUID(),value:structuredClone(value)});return true}}}
async function fixture({registered=true}={}){
 const store=createMemoryStore()
 await store.put('meta:site',{buildings:catalog})
 await store.put('meta:siteAdmins',[{userId:'chief',role:'super'},{userId:'manager',role:'admin'},{userId:'vg',role:'volunteer',buildings:['guiyuan']},{userId:'vl',role:'volunteer',buildings:['liuyuan']}])
 for(const id of ['chief','manager','vg','vl','owner'])await store.put('user:'+id,{id,notifyOn:true,dormBuilding:id==='vl'?'liuyuan':'guiyuan'})
 if(registered){await store.put('occupancy:b1',{g1:{userId:'owner',taskId:'task'}});await store.put('tasks:owner',[{id:'task',machineId:'g1',createdAt:new Date(AT-MINUTE).toISOString(),endAt:new Date(AT+MINUTE).toISOString()}])}
 await store.put('machines:b1',{board:board()})
 const users=[],groups=[]
 const args={store,board:board(),now:AT,notify:async(uid,notice)=>{users.push({uid,notice});return {ok:true}},broadcastTargets:async()=>catalog.map(row=>({key:row.code,dormBuilding:row.code,via:'group',conversationId:'fixture:'+row.code})),broadcast:async payload=>{groups.push(payload);return {ok:true}}}
 return {store,args,users,groups}
}

test('HTTP 405 is query failure, resets consecutive observations, and cannot become a hardware fault',async()=>{
 const raw={id:'g1',name:'桂园机器',state:3,queryStatus:405}
 assert.equal(normalizeMachines([raw])[0].state,'unknown')
 let first=evaluateMachineHealth({...board(),floors:[{machines:[{id:'g1',state:'faulty'}]}]}, {},AT)
 const failed=evaluateMachineHealth({...board(AT+MINUTE),upstreamQuery:{httpStatus:405}},first.health,AT+MINUTE)
 assert.equal(failed.health.machines.g1.count,0)
 assert.equal(failed.board.floors[0].machines[0].state,'unknown')
 first=evaluateMachineHealth({...board(AT+2*MINUTE),floors:[{machines:[{id:'g1',state:'faulty'}]}]},failed.health,AT+2*MINUTE)
 assert.equal(first.health.machines.g1.confirmedFault,false)
 const store=createMemoryStore();await store.put('operations:health:b1',first.health)
 await resetHealthObservation(store,'b1',{now:AT+3*MINUTE,status:405,eventId:EVENT})
 const health=await store.get('operations:health:b1')
 assert.equal(health.machines.g1.count,0);assert.equal(health.lastQueryFailure.status,405)
 const f=await fixture();await processMachineFaultNotices({...f.args,board:{...board(),upstreamQuery:{httpStatus:405}}})
 assert.equal(f.users.length+f.groups.length,0)
})

test('a real HTTP 405 capture keeps the last board and records a traceable query failure instead of fault delivery',async t=>{
 const f=await fixture(),before=structuredClone(await f.store.get('machines:b1'))
 await f.store.put('operations:health:b1',{machines:{g1:{candidate:'fault',count:1,firstAt:AT,lastSnapshotAt:AT,confirmedFault:false}}})
 t.mock.method(globalThis,'fetch',async()=>new Response('',{status:405}))
 const result=await runSync({BUILDING_ID:'b1',HAIER_MODE:'real',HAIER_URL:'https://fixture.example.test',HAIER_POSITION_ID:'fixture'},f.store)
 assert.equal(result.errorStage,'upstream_fetch');assert.match(result.error,/HAIER HTTP 405/)
 assert.match(result.eventId,/^evt_[a-f0-9]{24}$/);assert.deepEqual(await f.store.get('machines:b1'),before)
 const health=await f.store.get('operations:health:b1');assert.equal(health.machines.g1.count,0);assert.equal(health.lastQueryFailure.status,405)
 assert.equal(await f.store.get('faults:notification-outbox:b1'),null)
})

test('confirmed faults notify only the active owner and that building volunteers, never global admins or other groups',async()=>{
 const f=await fixture();await Promise.all([processMachineFaultNotices(f.args),processMachineFaultNotices(f.args)])
 assert.deepEqual(f.users.map(x=>x.uid),['owner','vg']);assert.equal(f.groups.length,1)
 assert.equal(f.groups[0].target.dormBuilding,'guiyuan')
 assert.equal(f.users.every(x=>x.notice.eventId===EVENT),true)
 const store=createMemoryStore();await store.put('operations:config',{broadcast:{enabled:false}})
 let global=0;const source=at=>({...board(at),floors:[{machines:[{id:'g1',name:'桂园机器',state:'faulty'}]}]})
 await runOperations({store,board:source(AT),now:AT,notify:async()=>{global++}})
 await runOperations({store,board:source(AT+MINUTE),now:AT+MINUTE,notify:async()=>{global++}})
 assert.equal(global,0);assert.equal((await store.get('operations:alerts'))[0].kind,'machine_fault')
})

test('unregistered faults wait for the scheduled group summary and permissions are rechecked before individual delivery',async()=>{
 const f=await fixture({registered:false});await processMachineFaultNotices(f.args)
 assert.deepEqual(f.users.map(x=>x.uid),['vg']);assert.equal(f.groups.length,0)
 const g=await fixture();await processMachineFaultNotices({...g.args,notify:async uid=>{
   g.users.push({uid});await g.store.put('access:user:vg',{permissions:{inspections:{view:false,operate:false,viewBuildings:[],operateBuildings:[]}}});return {ok:true}
 }})
 assert.deepEqual(g.users.map(x=>x.uid),['owner'])
})

test('durable claims deduplicate separate edge runtimes, retry failures, and fail closed on bridge outage',async()=>{
 const f=await fixture(),atomicStore=atomicFixture()
 const cloneStore=()=>({get:async(k,d)=>structuredClone(await f.store.get(k,d)),put:(k,v)=>f.store.put(k,structuredClone(v))})
 await Promise.all([processMachineFaultNotices({...f.args,store:cloneStore(),atomicStore}),processMachineFaultNotices({...f.args,store:cloneStore(),atomicStore})])
 assert.equal(f.users.filter(x=>x.uid==='owner').length,1);assert.equal(f.users.filter(x=>x.uid==='vg').length,1);assert.equal(f.groups.length,1)
 const g=await fixture();let attempts=0
 const args={...g.args,atomicStore:atomicFixture(),notify:async()=>({ok:++attempts>2})}
 await processMachineFaultNotices(args);await processMachineFaultNotices({...args,now:AT+1000});assert.equal(attempts,2)
 await processMachineFaultNotices({...args,now:AT+MINUTE,board:board(AT+MINUTE)});assert.equal(attempts,4)
 const outbox=await g.store.get('faults:notification-outbox:b1');assert.equal(outbox.g1.deliveries['user:owner'].eventId,EVENT)
 const h=await fixture();await processMachineFaultNotices({...h.args,atomicStore:{get:async()=>{throw Error('private failure')}}})
 assert.equal(h.users.length+h.groups.length,0)
})

test('hourly summary requires the preceding minute recheck; missed ticks require an independent later snapshot',async()=>{
 const config=normalizeOperationsConfig({});assert.equal(broadcastReviewWindow(config,AT-MINUTE),'2026-11-10T08');assert.equal(broadcastReviewWindow(config,AT-2*MINUTE),null)
 const healthy=at=>({...board(at),floors:[{machines:[{id:'g1',name:'桂园机器',state:'idle'}]}]})
 for(const prior of [true,false]){
  const store=createMemoryStore();let sent=0;const args={store,reviewRequired:true,broadcast:async()=>{sent++;return {ok:true}}}
  if(prior)await runOperations({...args,board:healthy(AT-MINUTE),now:AT-MINUTE})
  const first=await runOperations({...args,board:healthy(AT),now:AT})
  assert.equal(sent,prior?1:0)
  if(!prior){assert.equal(first.broadcast.reason,'awaiting_recheck');await runOperations({...args,board:healthy(AT),now:AT+MINUTE});assert.equal(sent,0);await runOperations({...args,board:healthy(AT+MINUTE),now:AT+MINUTE});assert.equal(sent,1)}
 }
})

test('an hourly summary has one durable claim across separate workers and unchanged later hours remain silent',async()=>{
 const atomicStore=atomicFixture(),backing=createMemoryStore(),store=()=>({get:async(k,d)=>structuredClone(await backing.get(k,d)),put:(k,v)=>backing.put(k,structuredClone(v))})
 let sent=0;const source=at=>({...board(at),floors:[{machines:[{id:'g1',name:'桂园机器',state:'idle'}]}]})
 await Promise.all([store(),store()].map(store=>runOperations({store,board:source(AT),now:AT,atomicStore,broadcast:async()=>{sent++;return {ok:true}}})))
 assert.equal(sent,1)
 // Even a stale KV reader without its success hash observes the atomic hash.
 const empty=createMemoryStore();await runOperations({store:empty,board:source(AT+3600000),now:AT+3600000,atomicStore,broadcast:async()=>{sent++;return {ok:true}}})
 assert.equal(sent,1)
})

test('a queued native fault is suppressed when its volunteer loses inspection rights before retry',async()=>{
 const f=await fixture(),atomicStore=atomicFixture();let at=AT,calls=0
 const push=createMobilePush({store:f.store,env:{MOBILE_PUSH_ENABLED:'true'},atomicStore,now:()=>at,transports:{fcm:async()=>{calls++;return {ok:false}}}})
 await push.register('vg','fault_installation')
 await atomicStore.compareAndSet('mobile:installation:fault_installation',null,{userId:'vg',provider:'fcm',token:'fixture-token',notificationsEnabled:true},{expiresAt:AT+86400000})
 await push.notify('vg',{title:'机器异常',eventId:EVENT,nativeKind:'ANNOUNCEMENT',machineFault:{machineId:'g1',eventId:EVENT,dormBuilding:'guiyuan'}})
 assert.equal(calls,1)
 await f.store.put('meta:siteAdmins',[]);at+=MINUTE;await push.drain();assert.equal(calls,1)
})
