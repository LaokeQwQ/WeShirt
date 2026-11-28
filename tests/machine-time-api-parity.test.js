import test from 'node:test'
import assert from 'node:assert/strict'
import {createMemoryStore} from '../packages/core/store.js'
import {createApp,runSync} from '../server/app.js'
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
 await store.put('occupancy:b1',{m:{userId:'owner',taskId:'old',startAt:iso(T-M),endAt:iso(T+3*M)}})
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
  assert.equal(task.currentTask,true)
  assert.equal(task.machineState,'occupied')
  assert.equal(task.timingObservedAt,machine.timeObservedAt)
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
 assert.equal(tasks.find(x=>x.id==='old').currentTask,false)
 assert.equal(tasks.find(x=>x.id==='old').timingObservedAt,null)
 assert.equal(tasks.find(x=>x.id==='new').currentTask,true)
 await store.put('occupancy:b1',{m:{userId:'someone_else',taskId:'other'}})
 assert.equal((await get('/api/tasks')).tasks.find(x=>x.id==='new').endAt,iso(T+30*M))
})

test('a cycle that runs past the local registration time adopts the longer refreshed platform deadline',async t=>{
 const {store,get}=await fixture(t)
 t.mock.timers.setTime(T+9*M)
 await store.put('meta:sync',{lastAttemptAt:T+9*M})
 const earlier=(await get('/api/tasks')).tasks[0]
 assert.equal(earlier.leftMin,0)
 const entry=await store.get('machines:b1')
 entry.board.updatedAt=iso(T+9*M)
 entry.board.floors[0].machines[0].finishAt=iso(T+35*M)
 await store.put('machines:b1',entry)
 const machine=(await get('/api/machines')).board.floors[0].machines[0]
 const next=(await get('/api/tasks')).tasks[0]
 assert.equal(next.leftMin,26)
 assert.equal(next.endAt,machine.finishAt)
 assert.equal(next.timingObservedAt,machine.timeObservedAt)
 assert.equal(next.completionConfirmed,false)
 assert.equal(next.takeState,'waiting')
 assert.equal((await get('/api/occupancy')).occupancy.m.suspectedUncollected,false)
 await store.put('occupancy:b1',{m:{userId:'owner'}})
 const legacy=(await get('/api/tasks')).tasks[0]
 assert.equal(legacy.currentTask,false)
 assert.equal(legacy.timingObservedAt,null)
 Object.assign(entry.board.floors[0].machines[0],{state:'idle',upstreamState:'idle',rawState:1,finishAt:null})
 await store.put('machines:b1',entry)
 await store.put('occupancy:b1',{m:{userId:'owner',taskId:'old',endAt:iso(T+3*M)}})
 assert.equal((await get('/api/occupancy')).occupancy.m.suspectedUncollected,true)
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

test('a synced idle edge fixes the old task deadline even if another person immediately starts', async t => {
  const { store, get, env } = await fixture(t)
  await runSync(env, store, { raws: [{ id: 'm', state: 'occupied', finishAt: iso(T + 6 * M) }] })
  t.mock.timers.setTime(T + 6 * M)
  await runSync(env, store, { raws: [{ id: 'm', state: 'idle' }] })
  assert.equal((await get('/api/tasks')).tasks[0].completionConfirmed, true)
  t.mock.timers.setTime(T + 7 * M)
  await runSync(env, store, { raws: [{ id: 'm', state: 'occupied', finishAt: iso(T + 47 * M) }] })
  const task = (await get('/api/tasks')).tasks[0]
  const machine = (await get('/api/machines')).board.floors[0].machines[0]
  assert.equal(task.endAt, iso(T + 6 * M))
  assert.equal(task.leftMin, 0)
  assert.equal(task.takeState, 'pending')
  assert.equal(task.currentTask, false)
  assert.equal(machine.finishAt, iso(T + 47 * M))
})

test('only affirmative cycle evidence separates continuous busy snapshots and a longer same cycle stays attached', async t => {
  const { get, store, env } = await fixture(t)
  const sync = (minutes, orderId, end) => {
    t.mock.timers.setTime(T + minutes * M)
    return runSync(env, store, { raws: [{ id: 'm', state: 'occupied', orderId, finishAt: iso(T + end * M) }] })
  }
  await sync(0, 'previous-private-order', 6)
  await sync(7, 'previous-private-order', 33)
  assert.equal((await get('/api/tasks')).tasks[0].leftMin, 26)
  await sync(8, 'replacement-private-order', 43)
  const data = await get('/api/machines')
  assert.equal(JSON.stringify(data).includes('replacement-private-order'), false)
  assert.equal(JSON.stringify(data).includes('platformCycleKey'), false)
  const task = (await get('/api/tasks')).tasks[0]
  assert.equal(task.endAt, iso(T + 8 * M))
  assert.equal(task.completionConfirmed, true)
  assert.equal(task.currentTask, false)
})

test('a registered six-minute drum clean can remain occupied while the platform stays idle', async t => {
  const { store, get } = await fixture(t)
  t.mock.timers.setTime(T + 3 * M)
  await store.put('meta:sync', { lastAttemptAt: T + 3 * M })
  const [task] = await store.get('tasks:owner')
  await store.put('tasks:owner', [{ ...task, startAt: iso(T), endAt: iso(T + 6 * M), program: 'self_clean' }])
  const board = (await store.get('machines:b1')).board
  board.updatedAt = iso(T + 3 * M)
  Object.assign(board.floors[0].machines[0], { state: 'idle', upstreamState: 'idle', rawState: 1, finishAt: null })
  await store.put('machines:b1', { board })
  const machine = (await get('/api/machines')).board.floors[0].machines[0]
  assert.equal(machine.state, 'occupied')
  assert.equal(machine.availabilitySource, 'user_report')
  assert.equal(machine.leftMin, 3)
  assert.equal((await get('/api/tasks')).tasks[0].completionConfirmed, false)
})

test('a previous idle edge is not applied to a new drum clean after subsequent idle refreshes', async t => {
  const { store, get, env } = await fixture(t)
  t.mock.timers.setTime(T + M)
  await runSync(env, store, { raws: [{ id: 'm', state: 'idle' }] })
  t.mock.timers.setTime(T + 2 * M)
  await store.put('tasks:owner', [{ id: 'new-clean', machineId: 'm', startAt: iso(T + 2 * M), endAt: iso(T + 8 * M), program: 'self_clean' }])
  await store.put('occupancy:b1', { m: { userId: 'owner', taskId: 'new-clean' } })
  t.mock.timers.setTime(T + 5 * M)
  await runSync(env, store, { raws: [{ id: 'm', state: 'idle' }] })
  const machine = (await get('/api/machines')).board.floors[0].machines[0]
  const task = (await get('/api/tasks')).tasks[0]
  assert.equal(machine.platformCompletionAt, iso(T + M))
  assert.equal(machine.registrationPending, true)
  assert.equal(machine.leftMin, 3)
  assert.equal(task.completionConfirmed, false)
  assert.equal(task.leftMin, 3)
})
