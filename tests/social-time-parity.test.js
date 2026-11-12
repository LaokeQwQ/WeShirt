import test from 'node:test'
import assert from 'node:assert/strict'
import {createApp} from '../server/app.js'
import {createMemoryStore} from '../packages/core/store.js'
import {issueToken} from '../packages/core/auth.js'
import {updateCalibrationSettings} from '../packages/core/machine-time-calibration.js'

const M=60000,T=Date.parse('2026-11-12T12:00:00Z'),iso=n=>new Date(n).toISOString()
async function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:T})
 t.mock.method(globalThis,'fetch',async()=>{throw Error('External requests blocked by fixture')})
 const store=createMemoryStore(),env={AUTH_SECRET:'social-time-parity-fixture-secret',ADMIN_TOKEN:'synthetic-admin-only',BUILDING_ID:'b1',HAIER_MODE:'mock'}
 for(const id of ['owner','friend','outsider'])await store.put('user:'+id,{id,nick:id,dormBuilding:'guiyuan',mobile:'private-phone',dingUserId:'private-ding-id'})
 await store.put('meta:sync',{lastAttemptAt:T,lastFetchAt:iso(T)})
 await store.put('mapping:b1',{mapping:{'1':'m'}})
 await store.put('machines:b1',{board:{updatedAt:iso(T),floors:[{machines:[{id:'m',name:'洗衣机',state:'occupied',upstreamState:'occupied',rawState:2,finishAt:iso(T+6*M)}]}]}})
 await store.put('tasks:owner',[{id:'task',machineId:'m',machineName:'已登记机器',mode:'duration',platformSeenRunning:true,startAt:iso(T-M),endAt:iso(T+3*M),remark:'private-remark',disinfectant:true}])
 await store.put('occupancy:b1',{m:{userId:'owner',taskId:'task'}})
 await store.put('social:pickup:request',{id:'request',ownerId:'owner',friendId:'friend',taskId:'task',state:'accepted',createdAt:iso(T-M),updatedAt:iso(T-M)})
 await store.put('social:pickups:friend',['request']);await store.put('social:pickups:owner',['request'])
 const app=createApp({store,env}),tokens={}
 for(const id of ['owner','friend','outsider'])tokens[id]=await issueToken(id,env.AUTH_SECRET)
 const get=async(path,uid='friend')=>{const response=await app.request(path,{headers:{authorization:'Bearer '+tokens[uid]}}),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body}
 const pickup=async()=> (await get('/api/social/pickups')).received[0].task
 return {store,get,pickup}
}

test('pickup duration tasks share calibrated platform time with owner tasks and expose no private task or account data',async t=>{
 const {store,get,pickup}=await fixture(t)
 await updateCalibrationSettings(store,'b1',()=>({document:{machines:{m:{offsetMinutes:2}}}}))
 for(let repeat=0;repeat<2;repeat++){
  const friend=await pickup(),owner=(await get('/api/tasks','owner')).tasks[0]
  assert.equal(friend.endAt,iso(T+8*M));assert.equal(friend.endAt,owner.endAt);assert.equal(friend.leftMin,8);assert.equal(friend.leftMin,owner.leftMin)
  assert.equal(friend.timingSource,'upstream');assert.equal(friend.timeOffsetMinutes,2);assert.equal(friend.completionConfirmed,false)
  assert.equal(JSON.stringify(friend).includes('private-'),false);assert.equal(friend.disinfectant,undefined);assert.equal(friend.userId,undefined)
 }
 assert.deepEqual(await get('/api/social/pickups','outsider'),{received:[],sent:[]})
})

test('a pickup for an older registration cannot inherit the same owners next machine cycle or its completion',async t=>{
 const {store,pickup}=await fixture(t)
 await updateCalibrationSettings(store,'b1',()=>({document:{machines:{m:{offsetMinutes:2}}}}))
 await store.put('occupancy:b1',{m:{userId:'owner',taskId:'next-cycle'}})
 let task=await pickup()
 assert.equal(task.endAt,iso(T+3*M));assert.equal(task.leftMin,3);assert.equal(task.timingSource,'user_report');assert.equal(task.timeOffsetMinutes,0);assert.equal(task.state,'unknown')
 const entry=await store.get('machines:b1');Object.assign(entry.board.floors[0].machines[0],{state:'idle',upstreamState:'idle',rawState:1,finishAt:null,platformCompletionConfirmed:true});await store.put('machines:b1',entry)
 task=await pickup();assert.equal(task.completionConfirmed,false);assert.equal(task.endAt,iso(T+3*M));assert.equal(task.leftMin,3)
 await store.put('occupancy:b1',{m:{userId:'owner'}})
 assert.equal((await pickup()).timingSource,'user_report','an owner-only legacy holder cannot prove which task owns the current cycle')
})

test('fresh idle confirms an observed real finish but a newly registered idle machine remains pending and query failure falls back',async t=>{
 const {store,get,pickup}=await fixture(t)
 const entry=await store.get('machines:b1'),machine=entry.board.floors[0].machines[0]
 Object.assign(machine,{state:'idle',upstreamState:'idle',rawState:1,finishAt:null,platformCompletionConfirmed:true})
 await store.put('machines:b1',entry)
 let friend=await pickup(),owner=(await get('/api/tasks','owner')).tasks[0]
 assert.equal(friend.completionConfirmed,true);assert.equal(friend.endAt,owner.endAt);assert.equal(friend.leftMin,0)
 const tasks=await store.get('tasks:owner');tasks[0].platformSeenRunning=false;tasks[0].endAt=iso(T+30*M);await store.put('tasks:owner',tasks)
 delete machine.platformCompletionConfirmed;await store.put('machines:b1',entry)
 friend=await pickup();owner=(await get('/api/tasks','owner')).tasks[0]
 assert.equal(friend.completionConfirmed,false);assert.equal(friend.state,'occupied');assert.equal(friend.endAt,owner.endAt);assert.equal(friend.leftMin,30)
 Object.assign(machine,{state:'occupied',upstreamState:'occupied',rawState:2,finishAt:iso(T+6*M),queryFailed:true,queryStatus:405});await store.put('machines:b1',entry)
 friend=await pickup();assert.equal(friend.timingSource,'user_report');assert.equal(friend.timeStale,true);assert.equal(friend.endAt,iso(T+30*M));assert.equal(friend.completionConfirmed,false)
})
