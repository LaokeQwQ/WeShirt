import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverTaskNotificationChannels } from '../packages/core/task-notification-channels.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createMobilePush } from '../packages/core/mobile-push.js'
import { runSync } from '../server/app.js'

const AT = Date.parse('2026-11-10T00:00:00Z'), MINUTE = 60000
const iso = at => new Date(at).toISOString()
function atomicFixture() {
  const records = new Map()
  return {consistency:'linearizable',durable:true,
    async get(key) { return structuredClone(records.get(key) || null) },
    async compareAndSet(key,version,value) {
      if ((records.get(key)?.version ?? null) !== version) return false
      records.set(key,{version:crypto.randomUUID(),value:structuredClone(value)})
      return true
    },
  }
}

test('DingTalk retries independently after another browser destination succeeds, even with a stale task copy',async()=>{
  const atomicStore = atomicFixture(), calls = {browserOne:0,browserTwo:0,ding:0}
  let dingReady = false, browserTwoReady = false
  const channels = [
    {id:'web:first',send:async()=>{calls.browserOne++;return {ok:true}}},
    {id:'web:second',send:async()=>{calls.browserTwo++;return {ok:browserTwoReady}}},
    {id:'ding',send:async()=>{calls.ding++;return {ok:dingReady}}},
  ]
  const first = await deliverTaskNotificationChannels({atomicStore,scope:'b|u|task|lead',channels,now:AT})
  assert.equal(first.complete,false)
  assert.equal(first.state['web:first'].complete,true)
  dingReady = true
  // A different worker reads an old KV task: durable channel receipts, rather
  // than that task snapshot, must prevent repeating the successful browser.
  const second = await deliverTaskNotificationChannels({atomicStore,scope:'b|u|task|lead',previous:{},channels,now:AT+MINUTE})
  assert.equal(second.complete,false)
  assert.deepEqual(calls,{browserOne:1,browserTwo:2,ding:2})
  browserTwoReady = true
  const third = await deliverTaskNotificationChannels({atomicStore,scope:'b|u|task|lead',previous:{},channels,now:AT+3*MINUTE})
  assert.equal(third.complete,true)
  assert.deepEqual(calls,{browserOne:1,browserTwo:3,ding:2})
})

test('two independent workers claim each destination once and unavailable atomic storage cannot send',async()=>{
  const atomicStore=atomicFixture();let calls=0
  const options={atomicStore,scope:'b|u|task|end',channels:[{id:'ding',send:async()=>{calls++;return {ok:true}}}],now:AT}
  await Promise.all([deliverTaskNotificationChannels(options),deliverTaskNotificationChannels({...options,previous:{}})])
  assert.equal(calls,1)
  const unavailable={async get(){throw Error('private storage failure')}}
  const blocked=await deliverTaskNotificationChannels({...options,atomicStore:unavailable})
  assert.equal(calls,1);assert.equal(blocked.complete,false)
  assert.equal(blocked.state.ding.error,'delivery_unavailable')
})

test('local fallback backs off each failing destination, caps retries, and gives the end phase its own attempt',async()=>{
  let calls=0,state={}
  const channels=[{id:'ding',send:async()=>{calls++;return {ok:false}}}]
  for (const minute of [0,0.5,1,2,3,7,20]) {
    const result=await deliverTaskNotificationChannels({scope:'b|u|task|lead',previous:state,channels,now:AT+minute*MINUTE})
    state=result.state
  }
  assert.equal(calls,4)
  assert.equal(state.ding.complete,false)
  await deliverTaskNotificationChannels({scope:'b|u|task|end',channels,now:AT+21*MINUTE})
  assert.equal(calls,5,'failed lead delivery must not throttle a separate confirmed end')
})

async function syncFixture(t,{nativeFirstFails=false,dingFirstFails=false}={}) {
  t.mock.timers.enable({apis:['Date'],now:AT})
  const store=createMemoryStore(),atomicStore=atomicFixture(),native=[],ding=[]
  let allowDing=!dingFirstFails,allowNative=!nativeFirstFails
  const env={BUILDING_ID:'b1',HAIER_MODE:'mock',MOBILE_PUSH_ENABLED:'true',DINGTALK_APP_KEY:'channel-fixture-app',DINGTALK_APP_SECRET:'fixture-only-secret',DINGTALK_ROBOT_CODE:'fixture-robot'}
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).endsWith('/oauth2/accessToken'))return Response.json({accessToken:'fixture-channel-token',expireIn:300})
    if(String(url).endsWith('/robot/oToMessages/batchSend')){ding.push(JSON.parse(options.body));return Response.json({ok:allowDing},{status:allowDing?200:503})}
    throw Error('Unexpected external request blocked by fixture')
  })
  const transports={fcm:async(_token,data)=>{native.push(data);return {ok:allowNative}}}
  await store.put('operations:config',{broadcast:{enabled:false}})
  await store.put('user:owner',{id:'owner',dingUserId:'fixture-owner',dormBuilding:'gui',notifyLeadMin:3,notifyOn:true})
  await store.put('tasks:owner',[{id:'task',machineId:'g1',machineName:'桂园机器',startAt:iso(AT-MINUTE),endAt:iso(AT+3*MINUTE)}])
  await store.put('occupancy:b1',{g1:{userId:'owner',taskId:'task'}})
  const push=createMobilePush({store,env,atomicStore,transports})
  await push.register('owner','channel_installation')
  await atomicStore.compareAndSet('mobile:installation:channel_installation',null,{userId:'owner',provider:'fcm',token:'fixture-token',notificationsEnabled:true})
  const run=(state=2)=>runSync(env,store,{raws:[{id:'g1',name:'桂园机器',state,finishAt:state===2?iso(AT+3*MINUTE):null}],mobileAtomicStore:atomicStore,mobilePushTransports:transports})
  return {store,atomicStore,native,ding,run,recoverDing(){allowDing=true},recoverNative(){allowNative=true}}
}

test('real sync: native success does not swallow a failed DingTalk lead notification',async t=>{
  const f=await syncFixture(t,{dingFirstFails:true})
  await f.run()
  assert.equal(f.native.length,1)
  const firstAttempts=f.ding.length;assert.ok(firstAttempts>0)
  let task=(await f.store.get('tasks:owner'))[0]
  assert.equal(task.notifyPhases?.lead,undefined)
  assert.equal(task.notifyChannels.lead.native.complete,true)
  assert.equal(task.notifyChannels.lead.ding.complete,false)
  f.recoverDing();t.mock.timers.setTime(AT+MINUTE);await f.run()
  assert.equal(f.native.length,1,'the successful native channel is not repeated')
  assert.ok(f.ding.length>firstAttempts)
  task=(await f.store.get('tasks:owner'))[0]
  assert.ok(task.notifyPhases.lead)
  assert.equal(task.notifyChannels.lead.ding.complete,true)
  const deliveredAttempts=f.ding.length
  t.mock.timers.setTime(AT+2*MINUTE);await f.run()
  assert.equal(f.ding.length,deliveredAttempts)
  assert.equal(f.native.length,1)
})

test('real sync: DingTalk success leaves native retry to its durable outbox without duplicate events',async t=>{
  const f=await syncFixture(t,{nativeFirstFails:true})
  await f.run()
  assert.equal(f.native.length,1);assert.equal(f.ding.length,1)
  assert.ok((await f.store.get('tasks:owner'))[0].notifyPhases.lead,'durable queue acceptance settles only the native channel')
  f.recoverNative();t.mock.timers.setTime(AT+MINUTE);await f.run()
  assert.equal(f.native.length,2);assert.equal(f.ding.length,1)
  assert.equal(f.native[0].eventId,f.native[1].eventId)
  assert.match(f.native[1].body,/2 分钟/)
  const row=await f.atomicStore.get('mobile:installation-index:owner')
  assert.equal(row.value.outbox.length,1)
})

test('real sync: an unresolved lead channel does not suppress the separate confirmed completion',async t=>{
  const f=await syncFixture(t,{dingFirstFails:true})
  await f.run()
  assert.equal((await f.store.get('tasks:owner'))[0].notifyPhases?.lead,undefined)
  f.recoverDing();t.mock.timers.setTime(AT+4*MINUTE);await f.run(1)
  const task=(await f.store.get('tasks:owner'))[0]
  assert.ok(task.notifyPhases.end)
  assert.equal(task.notifyChannels.end.ding.complete,true)
  assert.equal(task.notifyChannels.lead.ding.complete,false)
  assert.equal(f.native.length,2)
  assert.notEqual(f.native[0].eventId,f.native[1].eventId)
  assert.equal(f.native[1].serverConfirmed,'true')
})
