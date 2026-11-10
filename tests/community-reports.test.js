import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createApp } from '../server/app.js'
import { registerCommunityRoutes } from '../server/community.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const env={BUILDING_ID:'b1',AUTH_SECRET:'reports-synthetic-auth-secret-32',ADMIN_TOKEN:'reports-synthetic-admin',HAIER_MODE:'mock'}
async function fixture(t,{integrated=true}={}){
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('No external network is permitted')})
  const memory=createMemoryStore()
  const store={get:async(key,fallback=null)=>structuredClone(await memory.get(key,fallback)),put:(key,value)=>memory.put(key,structuredClone(value)),del:memory.del,list:async(prefix)=>structuredClone(await memory.list(prefix))}
  let clock=Date.now();const tokens={}
  for(const [id,dormBuilding] of [['a','guiyuan'],['b','liuyuan'],['author','guiyuan'],['admin','guiyuan'],['volunteer','guiyuan'],['operator','guiyuan']]){
    await store.put('user:'+id,{id,nick:id+'同学',dormBuilding,notifyOn:false})
    tokens[id]=await issueToken(id,env.AUTH_SECRET)
  }
  await store.put('meta:siteAdmins',[{userId:'admin',role:'admin'},{userId:'volunteer',role:'volunteer',buildings:['guiyuan']},{userId:'operator',role:'operator'}])
  await store.put('messages:b1',Array.from({length:12},(_,i)=>({id:'m'+i,userId:'author',nick:'原作者',text:'举报快照 '+i,channel:i===11?'liuyuan':'guiyuan',at:new Date(clock).toISOString()})))
  const app=integrated?createApp({store,env}):new Hono()
  if(!integrated)registerCommunityRoutes(app,{store,env,authenticate:c=>c.req.header('x-user'),now:()=>clock})
  const call=async(path,{user='a',method='GET',body,bootstrap=false,key}={})=>{
    const headers={'content-type':'application/json',...(integrated?user?{authorization:'Bearer '+tokens[user]}:{}:user?{'x-user':user}:{})}
    if(bootstrap)headers['x-admin-token']=env.ADMIN_TOKEN
    if(key)headers['Idempotency-Key']=key
    const response=await app.request(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)})
    return {status:response.status,data:await response.json(),headers:response.headers}
  }
  const report=(id='m0',options={})=>call('/api/messages/'+id+'/report',{method:'POST',body:{reason:'spam',detail:'请核实'},...options})
  return {store,app,call,report,advance:(ms)=>{clock+=ms}}
}

test('real JWT reports require current channel access; receipt and public messages never reveal reporter identity',async(t)=>{
  const {report,call,store}=await fixture(t)
  assert.equal((await report('m0',{user:null})).status,401)
  assert.equal((await report('m11')).status,403)
  assert.equal((await report('m0',{user:'author'})).status,400)
  const accepted=await report()
  assert.equal(accepted.status,200);assert.match(accepted.data.report.id,/^report_/)
  assert.deepEqual(Object.keys(accepted.data.report).sort(),['at','id','status'])
  assert.equal(JSON.stringify(accepted.data).includes('reporter'),false)
  assert.equal((await call('/api/admin/community-reports')).status,403)
  for(const user of ['operator','volunteer'])assert.equal((await call('/api/admin/community-reports',{user})).status,403)
  const publicRows=await call('/api/messages?channel=guiyuan',{user:'author'})
  assert.doesNotMatch(JSON.stringify(publicRows.data),/reporter|report_|请核实/)
  await store.put('user:a',{id:'a',dormBuilding:'guiyuan',disabled:true,notifyOn:false})
  assert.notEqual((await report('m1')).status,200)
})

test('concurrent and repeated reports persist once; snapshots survive message deletion and only admins can resolve',async(t)=>{
  const {report,call,store}=await fixture(t)
  const results=await Promise.all(Array.from({length:8},()=>report()))
  assert.ok(results.every(row=>row.status===200));assert.equal(new Set(results.map(row=>row.data.report.id)).size,1)
  assert.equal((await store.get('community:reports:b1')).length,1)
  assert.equal((await store.get('community:report-rate:a')).length,1)
  const id=results[0].data.report.id
  assert.equal((await call('/api/messages/m0',{user:'author',method:'DELETE'})).status,200)
  const listing=await call('/api/admin/community-reports',{user:'admin'})
  assert.equal(listing.status,200);assert.equal(listing.data.reports[0].snapshot.text,'举报快照 0')
  assert.equal(listing.data.reports[0].reporterId,undefined)
  const path='/api/admin/community-reports/'+id
  assert.equal((await call(path,{user:'volunteer',method:'PATCH',body:{status:'resolved',resolution:'已核实'}})).status,403)
  assert.equal((await call(path,{user:'admin',method:'PATCH',body:{status:'resolved'}})).status,400)
  const updated=await call(path,{user:'admin',method:'PATCH',body:{status:'resolved',resolution:'已核实并删除原消息'}})
  assert.equal(updated.status,200);assert.equal(updated.data.report.status,'resolved')
  assert.equal(updated.data.report.resolution,'已核实并删除原消息')
  const audit=(await store.list('auditlog:')).flatMap(row=>row.value).find(row=>row.detail?.route==='/api/admin/community-reports/:id'&&row.detail?.status===200)
  assert.equal(audit.detail.eventId,updated.headers.get('x-event-id'))
  assert.doesNotMatch(JSON.stringify(audit),/已核实并删除原消息|请核实|举报快照/)
})

test('fresh adminMessages scopes filter rows and counts and reject cross-building changes or revoked authority',async(t)=>{
  const {report,call,store}=await fixture(t)
  const own=await report(),other=await report('m11',{user:'b'})
  await store.put('access:user:admin',{permissions:{adminMessages:{viewBuildings:['guiyuan'],operateBuildings:['guiyuan']}}})
  const listing=await call('/api/admin/community-reports',{user:'admin'})
  assert.equal(listing.status,200);assert.equal(listing.data.pagination.total,1);assert.equal(listing.data.reports.length,1)
  assert.equal(listing.data.reports[0].id,own.data.report.id)
  assert.equal((await call('/api/admin/community-reports?channel=liuyuan',{user:'admin'})).status,403)
  const patch=id=>call('/api/admin/community-reports/'+id,{user:'admin',method:'PATCH',body:{status:'reviewing'}})
  assert.equal((await patch(other.data.report.id)).status,403)
  assert.equal((await patch(own.data.report.id)).status,200)
  await store.put('access:user:admin',{permissions:{adminMessages:{view:true,operate:false,viewBuildings:['guiyuan']}}})
  assert.equal((await patch(own.data.report.id)).status,403)
  await store.put('meta:siteAdmins',[])
  assert.equal((await call('/api/admin/community-reports',{user:'admin'})).status,403)
})

test('invalid inputs and disabled channels do not create reports; errors retain event ID and safe status',async(t)=>{
  const {report,call,store}=await fixture(t)
  for(const body of [{reason:'forged'},{reason:'other',detail:''},{reason:'spam',detail:'字'.repeat(301)}]){
    const result=await report('m0',{body})
    assert.equal(result.status,400);assert.equal(result.data.error.eventId,result.headers.get('x-event-id'));assert.equal(result.data.error.status,400)
  }
  assert.equal((await report('absent')).status,404)
  assert.equal(await store.get('community:reports:b1'),null)
  await store.put('meta:site',{buildings:[{code:'guiyuan',name:'测试楼',enabled:false},{code:'liuyuan',name:'另一楼'}]})
  assert.equal((await report()).status,403)
  assert.equal((await call('/api/admin/community-reports?limit=100',{user:'admin'})).status,400)
})

test('persistent frequency limits count distinct reports and remain effective after router recreation',async(t)=>{
  const {report,advance,store,app}=await fixture(t,{integrated:false})
  for(let i=0;i<3;i++)assert.equal((await report('m'+i)).status,200)
  assert.equal((await report('m3')).status,429)
  assert.equal((await report('m0')).status,200,'duplicate submissions use no additional quota')
  advance(60001)
  for(let i=3;i<10;i++){if(i===6||i===9)advance(60001);assert.equal((await report('m'+i)).status,200)}
  advance(60001)
  assert.equal((await report('m10')).status,429)
  assert.equal((await store.get('community:reports:b1')).length,10)
  const recreated=new Hono()
  registerCommunityRoutes(recreated,{store,env,authenticate:()=> 'a'})
  const response=await recreated.request('/api/messages/m10/report',{method:'POST',body:JSON.stringify({reason:'spam'})})
  assert.equal(response.status,429)
  assert.ok(app)
})

test('parallel reporters and moderator updates do not lose rows; idempotent retries retain one receipt',async(t)=>{
  const {report,call,store}=await fixture(t)
  const [first,second]=await Promise.all([report(),report('m0',{user:'admin'})])
  assert.equal(first.status,200);assert.equal(second.status,200)
  assert.notEqual(first.data.report.id,second.data.report.id)
  const results=await Promise.all([first,second].map((row,index)=>call('/api/admin/community-reports/'+row.data.report.id,{user:'admin',method:'PATCH',body:{status:'resolved',resolution:'处理结果'+index}})))
  assert.ok(results.every(row=>row.status===200))
  assert.ok((await store.get('community:reports:b1')).every(row=>row.status==='resolved'&&row.resolution))
  const replay=await report('m1',{key:'report-idempotency-key'})
  const repeated=await report('m1',{key:'report-idempotency-key'})
  assert.equal(repeated.headers.get('idempotency-replayed'),'true')
  assert.equal(replay.data.report.id,repeated.data.report.id)
  assert.equal((await report('m1',{key:'report-idempotency-key',body:{reason:'abuse',detail:'不同内容'}})).status,409)
})
