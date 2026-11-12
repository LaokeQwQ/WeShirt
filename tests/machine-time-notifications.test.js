import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveMachineTime,projectMachineTime} from '../packages/core/machine-time.js'
import {createMemoryStore} from '../packages/core/store.js'
import {runSync} from '../server/app.js'
import {createMobilePush} from '../packages/core/mobile-push.js'

const AT=Date.parse('2026-11-10T00:00:00Z'),MINUTE=60000,iso=at=>new Date(at).toISOString()
test('platform deadlines override stale task timers; calibration is applied exactly once and never turns running into idle',()=>{
 const task={endAt:iso(AT+3*MINUTE)},machine={state:'occupied',rawState:2,finishAt:iso(AT+6*MINUTE)}
 const time=resolveMachineTime(machine,{task,now:AT,snapshotAt:iso(AT)})
 assert.equal(time.remainingMinutes,6);assert.equal(time.source,'upstream')
 const once=projectMachineTime(machine,{task,now:AT,snapshotAt:iso(AT),timeOffsetMinutes:2})
 const twice=projectMachineTime(once,{task,now:AT,snapshotAt:iso(AT),timeOffsetMinutes:2})
 assert.equal(once.finishAt,iso(AT+8*MINUTE));assert.equal(twice.finishAt,once.finishAt)
 assert.equal(resolveMachineTime(machine,{now:AT+8*MINUTE,snapshotAt:iso(AT+8*MINUTE)}).confirmedFinished,false)
 const fallback=resolveMachineTime({...machine,queryStatus:405},{task,now:AT,snapshotAt:iso(AT)})
 assert.equal(fallback.source,'user_report');assert.equal(fallback.remainingMinutes,3);assert.equal(fallback.stale,true)
 assert.equal(resolveMachineTime({state:'idle',rawState:2},{now:AT,snapshotAt:iso(AT)}).confirmedFinished,false)
 const ended=resolveMachineTime({state:'idle',rawState:1,platformCompletionConfirmed:true},{task:{...task,platformSeenRunning:true},now:AT,snapshotAt:iso(AT)})
 assert.equal(ended.confirmedFinished,true);assert.equal(ended.remainingMinutes,0)
})

test('sync sends the latest platform remaining time and waits for actual idle before completion',async t=>{
 t.mock.timers.enable({apis:['Date'],now:AT})
 const sent=[],store=createMemoryStore(),env={BUILDING_ID:'b1',HAIER_MODE:'mock',DINGTALK_APP_KEY:'machine-time-local-app',DINGTALK_APP_SECRET:'local-only-fixture',DINGTALK_ROBOT_CODE:'fixture-robot'}
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).endsWith('/oauth2/accessToken'))return Response.json({accessToken:'fixture-machine-time-token',expireIn:300})
  if(String(url).endsWith('/robot/oToMessages/batchSend')){sent.push(JSON.parse(options.body));return Response.json({ok:true})}
  throw Error('Unexpected external request blocked by fixture')
 })
 await store.put('operations:config',{broadcast:{enabled:false}})
 await store.put('user:owner',{id:'owner',dingUserId:'fixture-owner',notifyLeadMin:3,notifyOn:true})
 await store.put('tasks:owner',[{id:'task',machineId:'g1',machineName:'桂园机器',startAt:iso(AT-MINUTE),endAt:iso(AT+3*MINUTE)}])
 await store.put('occupancy:b1',{g1:{userId:'owner',taskId:'task'}})
 const run=state=>runSync(env,store,{raws:[{id:'g1',name:'桂园机器',state,finishAt:state===2?iso(AT+6*MINUTE):null}]})
 await run(2);assert.equal(sent.length,0,'old three-minute registration must not beat six-minute telemetry')
 const tasks=await store.get('tasks:owner');tasks[0].endAt=iso(AT+30*MINUTE);await store.put('tasks:owner',tasks)
 t.mock.timers.setTime(AT+4*MINUTE);await run(2);assert.equal(sent.length,1)
 const body=JSON.stringify(sent[0]);assert.match(body,/2 分钟/);assert.doesNotMatch(body,/3 分钟/)
 t.mock.timers.setTime(AT+6*MINUTE);await run(2);assert.equal(sent.length,1,'zero timer while running is not completion')
 t.mock.timers.setTime(AT+7*MINUTE);await run(1);assert.equal(sent.length,2,'fresh idle sends a separate confirmed end')
 assert.ok((await store.get('tasks:owner'))[0].notifyPhases.end)
 assert.equal((await store.get('tasks:owner'))[0].endAt,iso(AT+30*MINUTE),'a later registration deadline does not keep the real finished machine occupied')
})

test('native time retries refresh their countdown text and stop when the platform deadline moves outside the lead window',async()=>{
 let at=AT;const store=createMemoryStore(),records=new Map(),sent=[]
 const atomicStore={consistency:'linearizable',durable:true,async get(key){return structuredClone(records.get(key)||null)},async compareAndSet(key,version,value){if((records.get(key)?.version??null)!==version)return false;records.set(key,{version:crypto.randomUUID(),value:structuredClone(value)});return true}}
 await store.put('user:owner',{id:'owner',notifyOn:true})
 await store.put('tasks:owner',[{id:'task',machineId:'g1',endAt:iso(AT+10*MINUTE),platformSeenRunning:true}])
 const board=(finish)=>({updatedAt:iso(at),floors:[{machines:[{id:'g1',name:'桂园机器',state:'occupied',rawState:2,finishAt:iso(finish)}]}]})
 await store.put('machines:b1',{board:board(AT+3*MINUTE)})
 const push=createMobilePush({store,env:{MOBILE_PUSH_ENABLED:'true'},atomicStore,now:()=>at,transports:{fcm:async(_token,data)=>{sent.push(data);return {ok:false}}}})
 await push.register('owner','time_installation')
 await atomicStore.compareAndSet('mobile:installation:time_installation',null,{userId:'owner',provider:'fcm',token:'fixture-token',notificationsEnabled:true},{expiresAt:AT+86400000})
 await push.notify('owner',{nativeEventKey:'time-fixture',taskId:'task',text:'旧剩余3分钟',machineTime:{machineId:'g1',phase:'lead',leadMinutes:3}})
 assert.match(sent[0].body,/3 分钟/)
 at+=MINUTE;await store.put('machines:b1',{board:board(AT+3*MINUTE)});await push.drain();assert.match(sent[1].body,/2 分钟/)
 at+=2*MINUTE;await store.put('machines:b1',{board:board(AT+10*MINUTE)});await push.drain();assert.equal(sent.length,2)
})
