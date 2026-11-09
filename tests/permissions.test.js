import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { getUserPermissions } from '../packages/core/permissions.js'

const SECRET='permissions-integration-secret-2026'
async function fixture(t){
 const store=createMemoryStore(),env={AUTH_SECRET:SECRET,ADMIN_TOKEN:'permissions-bootstrap',BUILDING_ID:'b1',HAIER_MODE:'mock',SYNC_STALE_MS:86400000}
 const users=[{id:'chief',role:'super'},{id:'admin',role:'admin'},{id:'reader',role:'operator'},{id:'student',role:'user'}]
 for(const {id} of users)await store.put('user:'+id,{id,nick:id,dormBuilding:'guiyuan',dingUserId:'ding-'+id,notifyOn:false})
 await store.put('meta:siteAdmins',users.filter(u=>u.role!=='user').map(u=>({userId:u.id,role:u.role})))
 await store.put('user:other',{id:'other',nick:'other',dormBuilding:'liuyuan'})
 const machines=[{id:'g1',name:'桂园1号机',state:'idle',dormBuilding:'guiyuan',kind:'washer'},{id:'l1',name:'柳园1号机',state:'idle',dormBuilding:'liuyuan',kind:'washer'}]
 await store.put('machines:b1',{board:{floors:[{code:'1',machines}],total:2,idle:2,updatedAt:new Date().toISOString()}})
 await store.put('meta:sync',{lastAttemptAt:Date.now(),lastFetchAt:new Date().toISOString()})
 const tokens=Object.fromEntries(await Promise.all(users.map(async u=>[u.id,await issueToken(u.id,SECRET)])))
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('no external fetch')})
 const app=createApp({store,env})
 const call=async(path,{user='chief',method='GET',body}={})=>{const response=await app.fetch(new Request('https://laundry.example'+path,{method,headers:{'content-type':'application/json',...(user?{authorization:'Bearer '+tokens[user]}:{})},body:body===undefined?undefined:JSON.stringify(body)}));return {status:response.status,data:await response.json()}}
 return {store,call}
}
const grant=(view=true,operate=true,viewBuildings=null,operateBuildings=viewBuildings)=>({view,operate,viewBuildings,operateBuildings})

test('only highest managers configure personal permissions; account settings visibility follows actual rights',async t=>{
 const {call}=await fixture(t)
 assert.equal((await call('/api/user/permissions',{user:'student'})).data.adminVisible,false)
 assert.equal((await call('/api/user/permissions',{user:'admin'})).data.adminVisible,true)
 assert.equal((await call('/api/admin/permissions',{user:'admin'})).status,403)
 assert.equal((await call('/api/admin/permissions?userId=student')).data.selected.user.id,'student')
 assert.equal((await call('/api/admin/permissions/student',{method:'PATCH',body:{permissions:{adminUsers:grant()}}})).status,400)
 assert.equal((await call('/api/admin/permissions/chief',{method:'PATCH',body:{permissions:{board:grant(false,false)}}})).status,403)
})

test('view/action flags and building bounds apply to actual JWT APIs, not only the menu',async t=>{
 const {call}=await fixture(t)
 const result=await call('/api/admin/permissions/student',{method:'PATCH',body:{permissions:{board:grant(true,false,['guiyuan'],[]),tasks:grant(true,true,['guiyuan']),messages:grant(true,false,['public','guiyuan'],[])}}})
 assert.equal(result.status,200,JSON.stringify(result.data))
 const board=await call('/api/machines',{user:'student'})
 assert.deepEqual(board.data.board.floors.flatMap(f=>f.machines).map(m=>m.id),['g1'])
 assert.equal(board.data.board.total,1)
 assert.equal((await call('/api/machines?dorm=liuyuan',{user:'student'})).status,403)
 assert.equal((await call('/api/tasks',{user:'student',method:'POST',body:{machineId:'l1',minutes:30}})).status,403)
 assert.equal((await call('/api/tasks',{user:'student',method:'POST',body:{machineId:'g1',minutes:30}})).status,200)
 assert.equal((await call('/api/messages',{user:'student',method:'POST',body:{channel:'guiyuan',text:'不能发送'}})).status,403)
 assert.equal((await call('/api/admin/permissions/student',{method:'DELETE'})).status,200)
 assert.equal((await call('/api/machines?dorm=liuyuan',{user:'student'})).status,200)
})

test('scoped manager reads filter machine/user lists and direct or bulk writes cannot escape bounds',async t=>{
 const {call}=await fixture(t)
 assert.equal((await call('/api/admin/permissions/admin',{method:'PATCH',body:{permissions:{adminUsers:grant(true,true,['guiyuan']),adminMachines:grant(true,true,['guiyuan']),adminDashboard:grant(true,false,['guiyuan'],[])}}})).status,200)
 const users=await call('/api/admin/users',{user:'admin'})
 assert.ok(users.data.items.every(u=>u.dormBuilding==='guiyuan'))
 const machines=await call('/api/admin/machines',{user:'admin'})
 assert.deepEqual(machines.data.rows.map(m=>m.id),['g1'])
 assert.equal((await call('/api/admin/user/other',{user:'admin'})).status,403)
 assert.equal((await call('/api/admin/user/other',{user:'admin',method:'POST',body:{nick:'不能改'}})).status,403)
 const status=await call('/api/admin/status',{user:'admin'})
 assert.equal(status.data.board.total,1)
 assert.ok(status.data.dormBuildings.every(b=>b.code==='guiyuan'))
})

test('invalid scope/operation combinations fail atomically and role changes immediately reduce saved grants',async t=>{
 const {store,call}=await fixture(t)
 for(const row of [grant(false,true),grant(true,true,['guiyuan'],['liuyuan']),grant(true,true,['missing']),grant(true,true,['guiyuan'],null)])assert.equal((await call('/api/admin/permissions/student',{method:'PATCH',body:{permissions:{board:row}}})).status,400)
 assert.equal(await store.get('access:user:student',null),null)
 await call('/api/admin/permissions/admin',{method:'PATCH',body:{permissions:{adminUsers:grant()}}})
 await store.put('meta:siteAdmins',[{userId:'chief',role:'super'}])
 const access=await getUserPermissions(store,await store.get('user:admin'),[{code:'guiyuan',name:'桂园'}])
 assert.equal(access.adminVisible,false)
 assert.equal((await call('/api/admin/users',{user:'admin'})).status,403)
})

test('missing eventual-consistency user record returns recoverable status and never replaces the nickname',async t=>{
 const {store,call}=await fixture(t)
 const saved=await store.get('user:student')
 await store.del('user:student')
 const missing=await call('/api/auth/me',{user:'student'})
 assert.equal(missing.status,409)
 assert.equal(missing.data.error.code,'account_out_of_sync')
 assert.equal(missing.data.user,undefined)
 assert.equal(await store.get('user:student',null),null)
 await store.put('user:student',{...saved,nick:'保持这个昵称'})
 for(let i=0;i<3;i++)assert.equal((await call('/api/auth/me',{user:'student'})).data.user.nick,'保持这个昵称')
})
