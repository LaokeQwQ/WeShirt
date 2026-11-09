import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
const env={AUTH_SECRET:'announcement-test-secret-32-chars',ADMIN_TOKEN:'test-admin-only'}
test('公告发布、版本冲突、楼栋时间筛选和个人偏好独立',async()=>{
 const store=createMemoryStore();const app=createApp({store,env});await store.put('user:a',{id:'a'});await store.put('user:b',{id:'b'})
 const token=await issueToken('a',env.AUTH_SECRET)
 const call=(path,body,auth='admin',method='POST')=>app.request(path,{method,headers:{'content-type':'application/json',...(auth==='admin'?{'x-admin-token':env.ADMIN_TOKEN}:auth==='a'?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)})
 assert.equal((await call('/api/admin/announcements',{title:'a'},'')).status,401)
 const body={title:'测试公告',markdown:'# 标题\n\n**正文**',published:true,dormBuilding:'guiyuan'}
 const created=await(await call('/api/admin/announcements',body)).json();const a=created.announcement;assert.equal(a.version,1)
 assert.equal((await(await app.request('/api/announcements?dorm=liuyuan')).json()).announcements.length,0)
 assert.equal((await(await app.request('/api/announcements?dorm=guiyuan')).json()).announcements.length,1)
 assert.equal((await call('/api/admin/announcements',{...a,version:0})).status,409)
 assert.equal((await call('/api/user/announcements',{enabled:false,dismiss:{id:a.id,version:1}},'a','PATCH')).status,200)
 assert.equal((await store.get('user:a')).announcementsOn,false);assert.equal((await store.get('user:b')).announcementsOn,undefined)
 const updated=await(await call('/api/admin/announcements',{...a,title:'新版'})).json();assert.equal(updated.announcement.version,2)
 assert.equal((await call('/api/user/announcements',{dismiss:{id:a.id,version:1}},'a','PATCH')).status,400)
 assert.equal((await call('/api/admin/announcements',{...body,startsAt:'invalid'})).status,400)
})
