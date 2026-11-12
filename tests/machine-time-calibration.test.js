import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../packages/core/store.js'
import { createApp } from '../server/app.js'
import { observeCalibration, projectCalibratedBoard, publicCalibration } from '../packages/core/machine-time-calibration.js'
import { issueToken } from '../packages/core/auth.js'

const M=60000, T=Date.parse('2026-11-12T12:00:00Z'), iso=n=>new Date(n).toISOString()
const machine=(state,at=T+10*M)=>({id:'m1',state,finishAt:iso(at),name:'洗衣机',floorCode:'1'})
test('manual signed calibration and repeated projection never compound offsets',()=>{
  const board={updatedAt:iso(T),floors:[{code:'1',machines:[machine('occupied')]}]}
  const settings={machines:{m1:{offsetMinutes:-2}}}
  const one=projectCalibratedBoard(board,settings,{now:T})
  assert.equal(one.floors[0].machines[0].leftMin,8)
  assert.equal(one.floors[0].machines[0].platformFinishAt,iso(T+10*M))
  assert.deepEqual(projectCalibratedBoard(one,settings,{now:T}),one)
  assert.equal(projectCalibratedBoard(board,{machines:{m1:{offsetMinutes:2}}},{now:T}).floors[0].machines[0].leftMin,12)
})
test('automatic calibration learns complete healthy cycles and rejects incomplete or interrupted observations',()=>{
  let value={autoEnabled:true}
  value=observeCalibration(value,machine('occupied'),{now:T,snapshotAt:iso(T),previousSnapshotAt:iso(T-M),previousMachine:machine('idle')})
  assert.equal(value.cycle.predictedDurationMs,10*M)
  for(let minute=1;minute<=7;minute++)value=observeCalibration(value,machine('occupied'),{now:T+minute*M,snapshotAt:iso(T+minute*M),previousSnapshotAt:iso(T+(minute-1)*M),previousMachine:machine('occupied')})
  const original=structuredClone(value)
  value=observeCalibration(value,machine('idle'),{now:T+8*M,snapshotAt:iso(T+8*M),previousSnapshotAt:iso(T+7*M),previousMachine:machine('occupied')})
  assert.deepEqual(original.cycle.idleAt,undefined,'learning must not mutate an earlier snapshot')
  value=observeCalibration(value,machine('idle'),{now:T+9*M,snapshotAt:iso(T+9*M),previousSnapshotAt:iso(T+8*M),previousMachine:machine('idle')})
  assert.equal(value.learnedOffsetMinutes,-2)
  assert.equal(value.samples.length,1)
  assert.equal(publicCalibration({...value,offsetMinutes:1}).effectiveOffsetMinutes,-1)
  const joined=observeCalibration({autoEnabled:true},machine('occupied'),{now:T,snapshotAt:iso(T),previousSnapshotAt:iso(T-M),previousMachine:machine('occupied')})
  assert.equal(joined.cycle,undefined)
  const failed=observeCalibration({...original}, {...machine('occupied'),queryFailed:true,queryStatus:405},{now:T+8*M,snapshotAt:iso(T+8*M),previousSnapshotAt:iso(T+7*M),previousMachine:machine('occupied')})
  assert.equal(failed.cycle,undefined)
  assert.equal(observeCalibration(original,machine('idle'),{now:T+20*M,snapshotAt:iso(T+20*M),previousSnapshotAt:iso(T+7*M),previousMachine:machine('occupied')}).cycle,undefined)
})

test('calibration API enforces auth, integers and per-building read/write scope',async()=>{
  const store=createMemoryStore(),env={AUTH_SECRET:'time-calibration-test-secret-only',ADMIN_TOKEN:'test-admin-only',BUILDING_ID:'b1',HAIER_MODE:'mock'}
  await store.put('machines:b1',{board:{updatedAt:iso(Date.now()),floors:[{code:'1',machines:[machine('occupied',Date.now()+10*M),{...machine('occupied'),id:'m2',dormBuilding:'liuyuan',name:'柳园洗衣机'}]}]}})
  await store.put('mapping:b1',{mapping:{'1':'m1'}})
  await store.put('meta:sync',{lastAttemptAt:Date.now()})
  await store.put('user:u1',{id:'u1',nick:'管理',dormBuilding:'guiyuan'})
  await store.put('identity:u1',{role:'admin',buildings:[]})
  const app=createApp({store,env}), token=await issueToken('u1',env.AUTH_SECRET)
  const request=async(path,body,header={})=>{const r=await app.fetch(new Request('https://laundry.example'+path,{method:body?'PATCH':'GET',headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID(),...header},...(body?{body:JSON.stringify(body)}:{})}));return{status:r.status,data:await r.json()}}
  assert.equal((await request('/api/admin/machine-time-calibration')).status,403)
  const auth={'x-admin-token':env.ADMIN_TOKEN}
  const read=await request('/api/admin/machine-time-calibration',null,auth)
  assert.equal(read.status,200)
  assert.equal(read.data.machines.length,2)
  for(const value of [1.5,121,-121,'-2'])assert.equal((await request('/api/admin/machine-time-calibration/m1',{offsetMinutes:value},auth)).status,400)
  assert.equal((await request('/api/admin/machine-time-calibration/m1',{offsetMinutes:-2,autoEnabled:true},auth)).status,200)
  const board=await request('/api/machines?dorm=guiyuan')
  assert.equal(board.data.board.floors[0].machines[0].timeOffsetMinutes,-2)
  assert.equal((await request('/api/admin/machine-time-calibration/m1',{autoEnabled:true,resetLearning:true},auth)).data.machine.sampleCount,0)
  // The account must not inherit the bootstrap credential merely by knowing a path.
  assert.equal((await request('/api/admin/machine-time-calibration/m1',{offsetMinutes:0},{Authorization:'Bearer '+token})).status,403)
  await store.put('meta:siteAdmins',[{userId:'u1',role:'admin'}])
  const scope={view:true,operate:true,viewBuildings:['guiyuan'],operateBuildings:['guiyuan']}
  await store.put('access:user:u1',{permissions:{adminMachines:scope}})
  const account={Authorization:'Bearer '+token}
  assert.equal((await request('/api/admin/machine-time-calibration/m1',{offsetMinutes:1},account)).status,200)
  assert.equal((await request('/api/admin/machine-time-calibration/m2',{offsetMinutes:1},account)).status,403)
  assert.equal((await request('/api/admin/machine-time-calibration',null,account)).data.machines.length,1)
})
