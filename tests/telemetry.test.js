import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { normalizeTelemetryEvent,telemetryDay } from '../packages/core/telemetry.js'
import { createTelemetryClient } from '../frontend/src/telemetryClient.js'
const env={AUTH_SECRET:'telemetry-local-test-secret-32-chars',ADMIN_TOKEN:'local-admin-test'}
const event={name:'api_request',route:'/task?token=secret',dorm:'guiyuan',endpoint:'/api/tasks/private-id/take?token=secret',durationMs:200,status:500,userId:'secret',message:'sensitive'}
test('遥测只保留白名单字段，路径去参数和个体ID',()=>{
 assert.deepEqual(normalizeTelemetryEvent(event),{name:'api_request',route:'/task',dorm:'guiyuan',endpoint:'/api/tasks/:id/take',durationMs:200,status:500})
 assert.equal(normalizeTelemetryEvent({...event,route:'/admin'}),null)
 assert.equal(normalizeTelemetryEvent({...event,endpoint:'/api/admin/users'}),null)
 assert.equal(normalizeTelemetryEvent({...event,durationMs:Infinity}),null)
})
test('遥测并发聚合不丢数据、后台鉴权、按楼筛选及14天清理',async()=>{
 const store=createMemoryStore();const app=createApp({store,env})
 await store.put('telemetryday:2000-01-01',{day:'2000-01-01',scopes:{}})
 const send=(events)=>app.request('/api/telemetry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events})})
 const rs=await Promise.all(Array.from({length:8},()=>send([event,{name:'page_view',route:'/list',dorm:'liuyuan'}])))
 assert.ok(rs.every((r)=>r.status===202));assert.equal(await store.get('telemetryday:2000-01-01'),null)
 const data=await store.get('telemetryday:'+telemetryDay());assert.equal(data.scopes.all.received,16)
 assert.doesNotMatch(JSON.stringify(data),/sensitive|private-id|secret|userId/)
 assert.equal((await app.request('/api/admin/telemetry')).status,401)
 const r=await app.request('/api/admin/telemetry?dorm=guiyuan&days=1',{headers:{'x-admin-token':env.ADMIN_TOKEN}})
 const d=await r.json();assert.equal(d.received,8);assert.equal(d.api.failed,8);assert.equal(d.api.avgMs,200)
 assert.equal((await send(Array(21).fill(event))).status,400)
 assert.equal((await app.request('/api/telemetry',{method:'POST',body:'x'.repeat(17000)})).status,413)
})
test('遥测客户端队列有上限，关闭时清空，失败批次不无限重试',async()=>{
 const batches=[];let on=true
 const client=createTelemetryClient({enabled:()=>on,context:()=>({route:'/list',dorm:'guiyuan'}),random:()=>0,send:async(b)=>{batches.push(b);throw new Error('offline')}})
 for(let i=0;i<100;i++)client.track('page_view')
 await client.flush();await client.flush();await client.flush();assert.equal(batches.length,2)
 on=false;client.clear();client.track('page_view');await client.flush();assert.equal(batches.length,2)
})
