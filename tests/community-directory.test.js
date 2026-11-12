import test from 'node:test'
import assert from 'node:assert/strict'
import {createApp} from '../server/app.js'
import {createMemoryStore} from '../packages/core/store.js'
import {createProcessMachineAtomicStore,configureMachineDocuments} from '../packages/core/machine-documents.js'
import {registerCommunityRoutes} from '../server/community.js'
import {Hono} from 'hono'
import {issueToken} from '../packages/core/auth.js'
import {enqueueCommunityNotice,readCommunityNotices} from '../packages/core/community-notices.js'
import {communityMessageDigest,acknowledgeCommunityMessages,readCommunityReadState} from '../packages/core/community-reads.js'

const T=Date.parse('2026-11-12T14:00:00Z'),iso=new Date(T).toISOString()
const entry=(id,channel='guiyuan',userId='author',extra={})=>({id,channel,userId,nick:'旧昵称',text:'消息 '+id,at:iso,...extra})
async function fixture(t,{atomicStore,integrated=true}={}){
 t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden')})
 const store=createMemoryStore(),rawGet=store.get,counts=new Map(),lists=[]
 store.get=async(key,fallback)=>{counts.set(key,(counts.get(key)||0)+1);return rawGet(key,fallback)}
 const rawList=store.list;store.list=async prefix=>{lists.push(prefix);return rawList(prefix)}
 for(const [id,dormBuilding,nick] of [['a','guiyuan','本人'],['b','liuyuan','另一楼同学'],['author','guiyuan','李小明'],['admin','guiyuan','管理员'],['hidden','liuyuan','隐私姓名']])await store.put('user:'+id,{id,dormBuilding,nick,mobile:'private-phone',dingUserId:'private-ding-id'})
 await store.put('meta:siteAdmins',[{userId:'admin',role:'admin'}])
 await store.put('meta:site',{buildings:[{code:'guiyuan',name:'桂园'},{code:'liuyuan',name:'柳园'},{code:'closed',name:'已停用楼',enabled:false}]})
 await store.put('machines:b1',{board:{updatedAt:iso,floors:[{machines:[{id:'g',name:'桂园洗衣机',dormBuilding:'guiyuan'},{id:'l',name:'柳园洗衣机',dormBuilding:'liuyuan'}]}]}})
 await store.put('mapping:b1',{mapping:{'1':'g'}})
 await store.put('messages:b1',[])
 const env={AUTH_SECRET:'directory-fixture-only-secret-32chars',BUILDING_ID:'b1',HAIER_MODE:'mock'},tokens={}
 for(const id of ['a','b','admin'])tokens[id]=await issueToken(id,env.AUTH_SECRET)
 const app=integrated?createApp({store,env,mobile:atomicStore?{atomicStore}:{}}):new Hono()
 if(!integrated){if(atomicStore)configureMachineDocuments(store,{atomicStore});registerCommunityRoutes(app,{store,env,authenticate:c=>c.req.header('x-user')||null,now:()=>T})}
 const call=async(path,{user='a',body,method=body?'POST':'GET'}={})=>{
  const response=await app.request(path,{method,headers:{'content-type':'application/json',...(user?(integrated?{authorization:'Bearer '+tokens[user]}:{'x-user':user}):{})},...(body?{body:JSON.stringify(body)}:{})}),data=await response.json()
  return {status:response.status,data}
 }
 const directory=async(user='a')=>{const result=await call('/api/messages/channels',{user});assert.equal(result.status,200,JSON.stringify(result.data));return result.data.channels}
 const acknowledge=(ids,channel='guiyuan',user='a')=>call('/api/messages/read',{user,body:{channel,messageIds:ids}})
 return {store,rawGet,counts,lists,env,call,directory,acknowledge}
}

test('directory returns only authorized summaries with current masked names, media placeholders, insertion order and own-message exclusion',async t=>{
 const f=await fixture(t)
 await f.store.put('messages:b1',[
  entry('old','guiyuan','author',{pinned:true}),entry('public','public'),entry('hidden','liuyuan','hidden',{text:'private-channel-body'}),entry('disabled','closed','hidden'),
  entry('deleted','guiyuan','hidden',{deleted:true,text:'private-deleted-body'}),entry('new','guiyuan','a'),
 ])
 f.counts.clear()
 let channels=await f.directory(),own=channels.find(row=>row.code==='guiyuan')
 assert.deepEqual(channels.map(row=>row.code),['public','guiyuan']);assert.equal(own.unreadCount,1);assert.equal(own.summary.messageId,'new');assert.equal(own.summary.nick,'本**同学')
 assert.equal(JSON.stringify(channels).includes('private-'),false);assert.equal(f.counts.get('user:hidden')||0,0)
 assert.equal((await f.directory(null))[0].unreadCount,0)
 const messages=await f.rawGet('messages:b1');messages.push(entry('picture','guiyuan','author',{text:'private-caption',media:{id:'private-media-id',kind:'image',url:'private-url'}}));await f.store.put('messages:b1',messages)
 own=(await f.directory()).find(row=>row.code==='guiyuan')
 assert.deepEqual(own.summary,{messageId:'picture',nick:'李**同学',text:'[图片]',kind:'image',at:iso});assert.equal(own.unreadCount,2)
 messages.push(entry('video','guiyuan','author',{media:{kind:'video'}}));await f.store.put('messages:b1',messages)
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').summary.text,'[视频]')
 messages.push(entry('announcement','guiyuan','author',{type:'announcement',text:'管理公告'}));await f.store.put('messages:b1',messages)
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').summary.kind,'announcement')
})

test('GET prefetch never marks messages read; exact visible acknowledgements leave older unseen, newer and other @ notices unread',async t=>{
 const f=await fixture(t)
 await f.store.put('messages:b1',[entry('m1'),entry('m2'),entry('own','guiyuan','a')])
 for(const messageId of ['m1','m2'])await enqueueCommunityNotice(f.store,'a',{messageId,channel:'guiyuan',title:'有人@你',text:'查看频道'},T)
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').unreadCount,2)
 assert.equal((await f.call('/api/messages?channel=guiyuan')).status,200)
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').unreadCount,2)
 const shown=await f.acknowledge(['m2']);assert.equal(shown.status,200);assert.deepEqual(shown.data,{ok:true,channel:'guiyuan',unreadCount:1})
 let notices=await readCommunityNotices(f.store,'a');assert.ok(notices.find(row=>row.messageId==='m2').readAt);assert.equal(notices.find(row=>row.messageId==='m1').readAt,null)
 const messages=await f.rawGet('messages:b1');messages.push(entry('m3'));await f.store.put('messages:b1',messages)
 assert.equal((await f.acknowledge(['m2'])).data.unreadCount,2,'replaying the old acknowledgement never consumes a newer message')
 assert.equal((await f.call('/api/messages/read',{body:{channel:'guiyuan',throughMessageId:'m1'}})).data.unreadCount,1,'legacy alias acknowledges one actual ID only')
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').unreadCount,1)
 assert.equal((await f.directory('b')).find(row=>row.code==='liuyuan').unreadCount,0)
})

test('deletion, changed residence, disabled buildings and sparse view scopes cannot leak counts or grant acknowledgement authority',async t=>{
 const f=await fixture(t)
 await f.store.put('messages:b1',[entry('m1'),entry('m2'),entry('hidden','liuyuan','hidden')])
 assert.equal((await f.acknowledge(['hidden'])).status,404)
 assert.equal((await f.acknowledge(['hidden'],'liuyuan')).status,403)
 assert.equal((await f.acknowledge(['m1'],'guiyuan',null)).status,401)
 for(const body of [{channel:'guiyuan',messageIds:['unknown'],at:'2099-01-01'},{channel:'guiyuan',messageIds:[]},{channel:'guiyuan',messageIds:Array(51).fill('m1')}])assert.equal((await f.call('/api/messages/read',{body})).status,400)
 await f.acknowledge(['m2'])
 await f.store.put('messages:b1',[entry('m1')])
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').unreadCount,1,'deleting an acknowledged anchor cannot resurrect other or hide unread messages')
 assert.equal((await f.acknowledge(['m2'])).status,404)
 const user=await f.rawGet('user:a');await f.store.put('user:a',{...user,dormBuilding:'liuyuan'})
 assert.deepEqual((await f.directory()).map(row=>row.code),['public','liuyuan']);assert.equal((await f.acknowledge(['m1'])).status,403)
 await f.store.put('meta:site',{buildings:[{code:'guiyuan',name:'桂园'},{code:'liuyuan',name:'柳园',enabled:false}]})
 assert.deepEqual((await f.directory()).map(row=>row.code),['public']);assert.equal((await f.acknowledge(['hidden'],'liuyuan')).status,403)
 await f.store.put('access:user:admin',{permissions:{messages:{view:true,operate:true,viewBuildings:['guiyuan'],operateBuildings:['guiyuan']}}})
 assert.deepEqual((await f.directory('admin')).map(row=>row.code),['guiyuan'])
})

test('muted and view-only members can acknowledge displayed messages but remain unable to post',async t=>{
 const f=await fixture(t)
 await f.store.put('messages:b1',[entry('m1')])
 await f.store.put('access:user:a',{permissions:{messages:{view:true,operate:false,viewBuildings:['guiyuan'],operateBuildings:[]}}})
 await f.store.put('moderation:mutes',{a:{until:null,reason:'禁言'}})
 assert.equal((await f.directory())[0].unreadCount,1)
 const read=await f.acknowledge(['m1']);assert.equal(read.status,200,JSON.stringify(read.data));assert.equal(read.data.unreadCount,0)
 assert.equal((await f.call('/api/messages',{body:{channel:'guiyuan',text:'不能发送'}})).status,403)
 await f.store.put('access:user:a',{permissions:{messages:{view:false,operate:false,viewBuildings:[],operateBuildings:[]}}})
 assert.equal((await f.acknowledge(['m1'])).status,403)
})

test('independent workers merge concurrent visible receipts without lost updates, timestamp assumptions or unsafe fallback',async t=>{
 const atomic=createProcessMachineAtomicStore(),f=await fixture(t,{atomicStore:atomic,integrated:false})
 const second=new Hono(),worker={get:(...args)=>f.store.get(...args),put:(...args)=>f.store.put(...args)}
 configureMachineDocuments(worker,{atomicStore:atomic});registerCommunityRoutes(second,{store:worker,env:f.env,authenticate:()=> 'a',now:()=>T})
 await f.store.put('messages:b1',Array.from({length:12},(_,i)=>entry('m'+i)))
 const requests=Array.from({length:12},(_,i)=>i%2?f.acknowledge(['m'+i]):second.request('/api/messages/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'guiyuan',messageIds:['m'+i]})}).then(async response=>({status:response.status,data:await response.json()})))
 assert.ok((await Promise.all(requests)).every(row=>row.status===200))
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').unreadCount,0)
 assert.equal((await f.directory('admin')).find(row=>row.code==='guiyuan').unreadCount,12,'read receipts are personal, including for administrators')
 const broken={consistency:'linearizable',durable:true,get:async()=>{throw Error('private-provider-failure')},compareAndSet:async()=>true}
 configureMachineDocuments(f.store,{atomicStore:broken})
 const unavailable=await f.acknowledge(['m0']);assert.equal(unavailable.status,503);assert.equal(unavailable.data.error.code,'community_read_unavailable');assert.equal(JSON.stringify(unavailable).includes('private-provider'),false)
 const directory=await f.call('/api/messages/channels');assert.equal(directory.status,503,'a bridge failure cannot silently claim zero unread')
})

test('CAS contention rechecks a changed residence and cannot acknowledge a now unauthorized channel',async t=>{
 const atomic=createProcessMachineAtomicStore(),f=await fixture(t,{atomicStore:atomic,integrated:false})
 await f.store.put('messages:b1',[entry('m1')])
 await f.directory()
 const compare=atomic.compareAndSet;let injected=false
 atomic.compareAndSet=async(...args)=>{
  if(!injected&&args[1]!==null){injected=true;const user=await f.rawGet('user:a');await f.store.put('user:a',{...user,dormBuilding:'liuyuan'});return false}
  return compare(...args)
 }
 assert.equal((await f.acknowledge(['m1'])).status,403)
 const user=await f.rawGet('user:a');await f.store.put('user:a',{...user,dormBuilding:'guiyuan'})
 assert.equal((await f.directory()).find(row=>row.code==='guiyuan').unreadCount,1)
})

test('bounded receipt compaction preserves a still-visible old pin while rotating through more than 1000 messages',async()=>{
 const store=createMemoryStore(),pin=await communityMessageDigest('public','old-pin')
 for(let batch=0;batch<12;batch++){
  const acknowledged=await Promise.all(Array.from({length:100},(_,i)=>communityMessageDigest('public','message-'+(batch*100+i))))
  await acknowledgeCommunityMessages({store,buildingId:'b1',userId:'a',validate:async()=>({acknowledged:batch?[...acknowledged]:[pin,...acknowledged],retained:new Set([pin,...acknowledged])})})
 }
 const seen=await readCommunityReadState(store,'b1','a')
 assert.ok(seen.size<=1000);assert.ok(seen.has(pin));assert.ok(seen.has(await communityMessageDigest('public','message-1199')))
})

test('directory and message loading use one collection/catalog/identity snapshot and one profile per distinct author',async t=>{
 const f=await fixture(t)
 await f.store.put('access:user:a',{permissions:{messages:{view:true,operate:true,viewBuildings:['public','guiyuan'],operateBuildings:['public','guiyuan']}}})
 await f.store.put('messages:b1',Array.from({length:50},(_,i)=>entry('m'+i,'guiyuan','author',{replyTo:i?'m0':null})))
 f.counts.clear();f.lists.length=0
 await f.directory()
 for(const key of ['meta:site','meta:siteAdmins','machines:b1','mapping:b1','messages:b1','user:a','user:author'])assert.equal(f.counts.get(key),1,key)
 assert.deepEqual(f.lists,[],'directory never scans the user namespace')
 f.counts.clear()
 const response=await f.call('/api/messages?channel=guiyuan&limit=50');assert.equal(response.status,200);assert.equal(response.data.messages.length,50)
 for(const key of ['meta:site','meta:siteAdmins','machines:b1','mapping:b1','messages:b1','user:a','user:author','community:mention-ref:guiyuan:author'])assert.equal(f.counts.get(key),1,key)
 assert.equal(new Set(response.data.messages.map(row=>row.mentionRef)).size,1)
 assert.deepEqual(f.lists,[])
})
