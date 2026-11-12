import test from 'node:test'
import assert from 'node:assert/strict'
import {createMemoryStore} from '../packages/core/store.js'
import {createApp} from '../server/app.js'
import {issueToken} from '../packages/core/auth.js'
import {updateCalibrationSettings} from '../packages/core/machine-time-calibration.js'

const T=Date.parse('2026-11-12T12:00:00Z'),M=60000,iso=n=>new Date(n).toISOString()
async function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:T})
 t.mock.method(globalThis,'fetch',async()=>{throw Error('Unexpected external request blocked by fixture')})
 const store=createMemoryStore(),env={AUTH_SECRET:'machine-time-parity-synthetic-secret',ADMIN_TOKEN:'synthetic-admin-only',BUILDING_ID:'b1',HAIER_MODE:'mock'}
 await store.put('operations:config',{broadcast:{enabled:false}})
 await store.put('meta:sync',{lastAttemptAt:T,lastFetchAt:iso(T)})
 await store.put('user:owner',{id:'owner',dormBuilding:'guiyuan'})
 await store.put('mapping:b1',{mapping:{'1':'m'}})
 await store.put('machines:b1',{board:{buildingId:'b1',updatedAt:iso(T),floors:[{code:'1F',machines:[{id:'m',name:'原洗衣机名',state:'occupied',upstreamState:'occupied',rawState:2,finishAt:iso(T+6*M)}]}]}})
 await store.put('tasks:owner',[{id:'old',machineId:'m',machineName:'登记机器',startAt:iso(T-M),endAt:iso(T+3*M)}])
 await store.put('occupancy:b1',{m:{userId:'owner',taskId:'old'}})
 const app=createApp({store,env}),token=await issueToken('owner',env.AUTH_SECRET)
 const get=async(path,admin=false)=>{const response=await app.request(path,{headers:admin?{'x-admin-token':env.ADMIN_TOKEN}:{authorization:'Bearer '+token}});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data}
 return {store,get,env}
}

test('tasks, public machine board and admin use one calibrated platform deadline after repeated refreshes',async t=>{
 const {store,get}=await fixture(t)
 await store.put('machineTimeCalibration:b1',{machines:{m:{offsetMinutes:2}}})
 for(let i=0;i<2;i++){
  const task=(await get('/api/tasks')).tasks[0]
  const machine=(await get('/api/machines?dorm=guiyuan')).board.floors[0].machines[0]
  const admin=(await get('/api/admin/machines',true)).rows[0]
  assert.equal(task.endAt,iso(T+8*M));assert.equal(task.leftMin,8);assert.equal(task.timingSource,'upstream')
  assert.equal(machine.finishAt,task.endAt);assert.equal(machine.leftMin,task.leftMin)
  assert.equal(admin.finishAt,task.endAt);assert.equal(admin.leftMin,task.leftMin)
  assert.equal(machine.platformFinishAt,iso(T+6*M));assert.equal(admin.platformFinishAt,machine.platformFinishAt)
  assert.equal(task.registrationEndAt,iso(T+3*M))
 }
 await updateCalibrationSettings(store,'b1',()=>({document:{machines:{m:{offsetMinutes:-2}}}}))
 assert.equal((await get('/api/tasks')).tasks[0].leftMin,4)
 assert.equal((await get('/api/machines?dorm=guiyuan')).board.floors[0].machines[0].leftMin,4)
 assert.equal((await get('/api/admin/machines',true)).rows[0].leftMin,4)
})

test('a previous task cannot inherit a new occupancy deadline after another registration takes the slot',async t=>{
 const {store,get}=await fixture(t)
 const list=await store.get('tasks:owner');list.push({...list[0],id:'new',endAt:iso(T+30*M)});await store.put('tasks:owner',list)
 await store.put('occupancy:b1',{m:{userId:'owner',taskId:'new'}})
 const tasks=(await get('/api/tasks')).tasks
 assert.equal(tasks.find(x=>x.id==='old').endAt,iso(T+3*M));assert.equal(tasks.find(x=>x.id==='old').timingSource,'user_report')
 assert.equal(tasks.find(x=>x.id==='new').endAt,iso(T+6*M));assert.equal(tasks.find(x=>x.id==='new').timingSource,'upstream')
 await store.put('occupancy:b1',{m:{userId:'someone_else',taskId:'other'}})
 assert.equal((await get('/api/tasks')).tasks.find(x=>x.id==='new').endAt,iso(T+30*M))
})

test('a new registration on an idle platform remains pending while a confirmed real finish beats a late local registration timer',async t=>{
 const {store,get}=await fixture(t)
 const entry=await store.get('machines:b1'),machine=entry.board.floors[0].machines[0]
 Object.assign(machine,{state:'idle',upstreamState:'idle',rawState:1,finishAt:null})
 await store.put('machines:b1',entry)
 let task=(await get('/api/tasks')).tasks[0]
 assert.equal(task.completionConfirmed,false);assert.equal(task.takeState,'waiting');assert.equal(task.timingSource,'user_report')
 assert.equal((await get('/api/machines?dorm=guiyuan')).board.floors[0].machines[0].registrationPending,true)
 const tasks=await store.get('tasks:owner');tasks[0].platformSeenRunning=true;tasks[0].endAt=iso(T+30*M);await store.put('tasks:owner',tasks)
 machine.platformCompletionConfirmed=true;await store.put('machines:b1',entry)
 task=(await get('/api/tasks')).tasks[0]
 assert.equal(task.completionConfirmed,true);assert.equal(task.takeState,'pending');assert.equal(task.leftMin,0)
 assert.equal((await get('/api/machines?dorm=guiyuan')).board.floors[0].machines[0].state,'idle')
})
