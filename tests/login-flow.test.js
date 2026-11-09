import test from 'node:test'
import assert from 'node:assert/strict'
import { safeLoginTarget,createSingleFlight } from '../frontend/src/loginFlow.js'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueTicket } from '../packages/core/auth.js'
test('登录回跳保留社交票据，拒绝跨站/登录循环',()=>{
 assert.equal(safeLoginTarget('/social?ticket=abc'),'/social?ticket=abc')
 for(const s of ['//evil.test','/\\evil.test','/login?k=a','https://evil.test','/\nother'])assert.equal(safeLoginTarget(s),'/')
})
test('并行续期共用一次请求，结束后可重新请求',async()=>{
 let calls=0,release;const fn=createSingleFlight(async()=>{calls++;await new Promise(r=>release=r);return 1})
 const a=fn(),b=fn();assert.equal(a,b);await Promise.resolve();release();await a;assert.equal(calls,1)
 const c=fn();await Promise.resolve();release();await c;assert.equal(calls,2)
})
test('新登录claim绑定设备并仅允许消费一次，角色不能混用',async()=>{
 const store=createMemoryStore(),env={AUTH_SECRET:'login-test-secret-long-enough-32'};await store.put('user:a',{id:'a'})
 const app=createApp({store,env}),device='a'.repeat(32)
 const code=await issueTicket({role:'login_claim',u:'a',d:device,nonce:'unique-nonce',exp:Date.now()+60000},env.AUTH_SECRET)
 const call=(body)=>app.request('/api/auth/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 assert.equal((await call({code,device:'wrong'})).status,400)
 const results=await Promise.all([call({code,device}),call({code,device})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400])
 const other=await issueTicket({role:'other',u:'a',exp:Date.now()+60000},env.AUTH_SECRET);assert.equal((await call({code:other,device})).status,400)
})
