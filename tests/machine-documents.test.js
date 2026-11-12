import test from 'node:test'
import assert from 'node:assert/strict'
import {createMemoryStore} from '../packages/core/store.js'
import {assertMobileAtomicKey} from '../packages/core/mobile-store.js'
import {configureMachineDocuments,readMachineDocument,updateMachineDocument} from '../packages/core/machine-documents.js'
import {calibrationKey,readCalibrationSettings,updateCalibrationSettings,calibrateMachineBoard,invalidateMachineCalibration} from '../packages/core/machine-time-calibration.js'
import {createApp,runSync} from '../server/app.js'
import {issueToken} from '../packages/core/auth.js'

const clone=value=>structuredClone(value),M=60000,T=Date.parse('2026-11-12T12:00:00Z'),iso=n=>new Date(n).toISOString()
function fixture(){
 const values=new Map(),backing=createMemoryStore(),stats={pageWrites:0,pageReads:0,maxBytes:0,activeReads:0,peakReads:0}
 const atomic={consistency:'linearizable',durable:true,values,stats,
  async get(key){assertMobileAtomicKey(key);if(key.includes('machine-page:'))stats.pageReads++;stats.activeReads++;stats.peakReads=Math.max(stats.peakReads,stats.activeReads);await new Promise(resolve=>setTimeout(resolve,1));stats.activeReads--;return clone(values.get(key)||null)},
  async compareAndSet(key,version,value){assertMobileAtomicKey(key);const bytes=new TextEncoder().encode(JSON.stringify(value)).length;stats.maxBytes=Math.max(stats.maxBytes,bytes);assert.ok(bytes<48000);await Promise.resolve();if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:crypto.randomUUID(),value:clone(value)});if(key.includes('machine-page:'))stats.pageWrites++;return true},
 }
 const worker=()=>{const store={get:async(k,d)=>clone(await backing.get(k,d)),put:async(k,v)=>backing.put(k,clone(v)),del:k=>backing.del(k),list:prefix=>backing.list(prefix)};configureMachineDocuments(store,{env:{HAIER_MODE:'real'},atomicStore:atomic});return store}
 return {atomic,backing,worker}
}

test('separate edge workers preserve all concurrent mutations and ignore a stale compatibility projection',async()=>{
 const f=fixture(),a=f.worker(),b=f.worker(),key='fixture:document'
 await f.backing.put(key,{count:0})
 await Promise.all(Array.from({length:16},(_,index)=>updateMachineDocument({store:index%2?a:b,key},async value=>({document:{count:value.count+1}}))))
 assert.equal((await readMachineDocument({store:a,key})).count,16)
 await f.backing.put(key,{count:0})
 assert.equal((await readMachineDocument({store:b,key})).count,16)
})

test('1000 feedback records fit bounded immutable pages and editing one record reuses all unchanged pages',async()=>{
 const f=fixture(),store=f.worker(),key='machine-feedback:b1'
 const rows=Array.from({length:1000},(_,i)=>({id:'mf_'+i,detail:'说明'.repeat(150),resolution:'处理'.repeat(150),at:iso(T),status:'open'}))
 await f.backing.put(key,rows)
 assert.deepEqual(await readMachineDocument({store,key,paged:true,fallback:[]}),rows)
 assert.ok(f.atomic.stats.pageWrites>20);assert.ok(f.atomic.stats.maxBytes<48000);assert.ok(f.atomic.stats.peakReads<=6)
 const writes=f.atomic.stats.pageWrites,reads=f.atomic.stats.pageReads
 await updateMachineDocument({store,key,paged:true},current=>{current[500].status='resolved';return {document:current}})
 assert.equal(f.atomic.stats.pageWrites,writes+1)
 assert.equal(f.atomic.stats.pageReads-reads,writes+1,'unchanged pages are read once, without a second probe before commit')
 assert.equal((await readMachineDocument({store:f.worker(),key,paged:true}))[500].status,'resolved')
})

test('failed atomic access is safely unavailable and a production KV store never falls back to process locks',async()=>{
 const key='fixture:document',opaque={get:async()=>({secret:'private'}),put:async()=>assert.fail('No unsafe fallback write')}
 configureMachineDocuments(opaque,{env:{HAIER_MODE:'real'}})
 await assert.rejects(readMachineDocument({store:opaque,key}),error=>error.status===503&&error.code==='machine_store_unavailable'&&!error.message.includes('private'))
 const f=fixture(),store=f.worker();configureMachineDocuments(store,{atomicStore:{consistency:'linearizable',durable:true,get:async()=>{throw Error('private token')},compareAndSet:async()=>true}})
 await assert.rejects(updateMachineDocument({store,key},()=>({document:{}})),error=>error.status===503&&!error.message.includes('private'))
})

test('a failed page write cannot commit a partial feedback snapshot or revive the KV copy',async()=>{
 const f=fixture(),store=f.worker(),key='machine-feedback:b1',rows=[{id:'mf_1',detail:'原始内容'}]
 await f.backing.put(key,rows)
 await readMachineDocument({store,key,paged:true,fallback:[]})
 const commit=f.atomic.compareAndSet
 f.atomic.compareAndSet=async(key,...args)=>{if(key.includes('machine-page:'))throw Error('fixture page unavailable');return commit(key,...args)}
 await assert.rejects(updateMachineDocument({store,key,paged:true},current=>({document:[...current,{id:'mf_2'}]})),error=>error.status===503)
 await f.backing.put(key,[{id:'unsafe-stale-copy'}])
 assert.deepEqual(await readMachineDocument({store:f.worker(),key,paged:true}),rows)
})

test('reading an older manifest renews its referenced pages before extending authoritative retention',async()=>{
 const f=fixture(),store=f.worker(),key='machine-feedback:b1',now=Date.now(),rows=[{id:'mf_1',detail:'仍在保留期内'}]
 await f.backing.put(key,rows)
 await readMachineDocument({store,key,paged:true,fallback:[],now:now-46*86400000})
 const writes=f.atomic.stats.pageWrites
 await f.backing.put(key,[])
 assert.deepEqual(await readMachineDocument({store:f.worker(),key,paged:true,fallback:[],now}),rows)
 assert.equal(f.atomic.stats.pageWrites,writes+1)
 assert.ok([...f.atomic.values.values()].filter(row=>row.value.kind==='pages'||row.value.rows).every(row=>row.value.renewAt>now))
})

test('API storage failures return safe traceable 503 responses for feedback and all calibrated views',async()=>{
 const f=fixture(),store=f.worker(),env={AUTH_SECRET:'fixture-machine-failure-secret',ADMIN_TOKEN:'fixture-admin',BUILDING_ID:'b1',HAIER_MODE:'real'}
 await f.backing.put('user:u',{id:'u',dormBuilding:'guiyuan'})
 await f.backing.put('meta:sync',{lastAttemptAt:Date.now()})
 await f.backing.put('machines:b1',{board:{updatedAt:iso(Date.now()),floors:[{machines:[{id:'m',state:'idle',dormBuilding:'guiyuan'}]}]}})
 const atomic={consistency:'linearizable',durable:true,get:async()=>{throw Error('private provider exception')},compareAndSet:async()=>true}
 const app=createApp({store,env,mobile:{atomicStore:atomic}}),token=await issueToken('u',env.AUTH_SECRET)
 for(const path of ['/api/machines?dorm=guiyuan','/api/tasks','/api/admin/machines','/api/admin/machine-time-calibration','/api/admin/machine-feedback','/api/machines/m/feedback']){
  const post=path.endsWith('/feedback'),response=await app.request(path,{method:post?'POST':'GET',headers:{authorization:'Bearer '+token,'x-admin-token':env.ADMIN_TOKEN,'content-type':'application/json'},...(post?{body:JSON.stringify({type:'other',detail:'无法查询'})}:{})}),body=await response.json()
  assert.equal(response.status,503,path+': '+JSON.stringify(body));assert.equal(body.error.status,503);assert.equal(body.error.eventId,response.headers.get('x-event-id'));assert.match(body.error.eventId,/^evt_/);assert.equal(JSON.stringify(body).includes('private'),false)
 }
})

test('automatic learning cannot overwrite manual calibration and concurrent duplicate snapshots add one sample',async()=>{
 const f=fixture(),a=f.worker(),b=f.worker(),key=calibrationKey('b1')
 await f.backing.put(key,{machines:{m:{offsetMinutes:0,autoEnabled:true,lastObservation:T+8*M,cycle:{startAt:T,predictedDurationMs:10*M,predictedEndAt:T+10*M,idleAt:T+8*M}}}})
 const machine={id:'m',state:'idle',rawState:1},board={updatedAt:iso(T+9*M),floors:[{machines:[machine]}]},previousBoard={updatedAt:iso(T+8*M),floors:[{machines:[machine]}]}
 await Promise.all([
  updateCalibrationSettings(a,'b1',settings=>({document:{...settings,machines:{...settings.machines,m:{...settings.machines.m,offsetMinutes:5}}}})),
  calibrateMachineBoard({store:b,buildingId:'b1',board,previousBoard,now:T+9*M}),
  calibrateMachineBoard({store:a,buildingId:'b1',board,previousBoard,now:T+9*M}),
 ])
 const saved=(await readCalibrationSettings(b,'b1')).machines.m
 assert.equal(saved.offsetMinutes,5);assert.equal(saved.learnedOffsetMinutes,-2);assert.equal(saved.samples.length,1)
 await calibrateMachineBoard({store:b,buildingId:'b1',board,previousBoard,now:T+9*M})
 assert.equal((await readCalibrationSettings(a,'b1')).machines.m.samples.length,1)
 await invalidateMachineCalibration({store:b,buildingId:'b1',now:T+8*M})
 assert.equal((await readCalibrationSettings(a,'b1')).machines.m.lastObservation,T+9*M,'an older failed worker cannot rewind a newer observation')
})

test('a separate worker sees manual settings in tasks public admin and subsequent raw sync without offset compounding',async t=>{
 t.mock.timers.enable({apis:['Date'],now:T})
 t.mock.method(globalThis,'fetch',async()=>{throw Error('External request blocked by fixture')})
 const f=fixture(),a=f.worker(),b=f.worker(),env={AUTH_SECRET:'fixture-calibration-api-secret',ADMIN_TOKEN:'fixture-calibration-admin',BUILDING_ID:'b1',HAIER_MODE:'mock'}
 await f.backing.put('user:u',{id:'u',dormBuilding:'guiyuan'})
 await f.backing.put('meta:sync',{lastAttemptAt:T,lastFetchAt:iso(T)})
 await f.backing.put('operations:config',{broadcast:{enabled:false}})
 await f.backing.put('mapping:b1',{mapping:{'1':'m'}})
 await f.backing.put('machines:b1',{board:{updatedAt:iso(T),floors:[{machines:[{id:'m',name:'洗衣机',state:'occupied',upstreamState:'occupied',rawState:2,finishAt:iso(T+6*M)}]}]}})
 await f.backing.put('tasks:u',[{id:'t',machineId:'m',startAt:iso(T-M),endAt:iso(T+3*M)}])
 await f.backing.put('occupancy:b1',{m:{userId:'u',taskId:'t'}})
 const apps=[createApp({store:a,env,mobile:{atomicStore:f.atomic}}),createApp({store:b,env,mobile:{atomicStore:f.atomic}})],token=await issueToken('u',env.AUTH_SECRET),headers={authorization:'Bearer '+token,'x-admin-token':env.ADMIN_TOKEN,'content-type':'application/json'}
 const saved=await apps[0].request('/api/admin/machine-time-calibration/m',{method:'PATCH',headers,body:JSON.stringify({offsetMinutes:2})})
 assert.equal(saved.status,200)
 await f.backing.put(calibrationKey('b1'),{machines:{m:{offsetMinutes:-9}}})
 const check=async()=>{
  for(const [path,extract] of [['/api/tasks',body=>body.tasks[0]],['/api/machines?dorm=guiyuan',body=>body.board.floors[0].machines[0]],['/api/admin/machines',body=>body.rows[0]]]){
   const response=await apps[1].request(path,{headers}),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(extract(body).leftMin,8,path);assert.equal(extract(body).timeOffsetMinutes,2)
  }
 }
 await check()
 const sync=await runSync(env,b,{raws:[{id:'m',name:'洗衣机',state:2,finishTime:iso(T+6*M)}],mobileAtomicStore:f.atomic})
 assert.equal(sync.error,null,JSON.stringify(sync))
 await check()
 assert.equal((await readCalibrationSettings(a,'b1')).machines.m.offsetMinutes,2)
})

test('feedback API duplicate limits and admin handling remain atomic across two actual app instances',async()=>{
 const f=fixture(),a=f.worker(),b=f.worker(),env={AUTH_SECRET:'machine-document-api-fixture-secret',ADMIN_TOKEN:'fixture-admin-credential',BUILDING_ID:'b1',HAIER_MODE:'real'}
 await f.backing.put('user:u',{id:'u',dormBuilding:'guiyuan'})
 await f.backing.put('machines:b1',{board:{updatedAt:iso(Date.now()),floors:[{machines:[{id:'m',name:'桂园机器',dormBuilding:'guiyuan',state:'idle'}]}]}})
 const apps=[createApp({store:a,env,mobile:{atomicStore:f.atomic}}),createApp({store:b,env,mobile:{atomicStore:f.atomic}})],token=await issueToken('u',env.AUTH_SECRET)
 const call=async(app,path,body,method='POST')=>{const response=await app.request(path,{method,headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID(),authorization:'Bearer '+token,'x-admin-token':env.ADMIN_TOKEN},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()}}
 const same=await Promise.all(Array.from({length:8},(_,i)=>call(apps[i%2],'/api/machines/m/feedback',{type:'other',detail:'同一条反馈'})))
 assert.ok(same.every(row=>row.status===200),JSON.stringify(same));assert.equal(new Set(same.map(row=>row.data.feedback.id)).size,1)
 const more=await Promise.all(Array.from({length:4},(_,i)=>call(apps[i%2],'/api/machines/m/feedback',{type:'other',detail:'不同反馈'+i})))
 assert.deepEqual(more.map(row=>row.status).sort(),[200,200,429,429])
 const rows=await call(apps[1],'/api/admin/machine-feedback',undefined,'GET');assert.equal(rows.data.feedback.length,3)
 await Promise.all(rows.data.feedback.map((row,i)=>call(apps[i%2],'/api/admin/machine-feedback/'+row.id,{status:'resolved',resolution:'已处理'},'PATCH')))
 const handled=await call(apps[0],'/api/admin/machine-feedback',undefined,'GET');assert.equal(handled.data.feedback.every(row=>row.status==='resolved'),true)
})
