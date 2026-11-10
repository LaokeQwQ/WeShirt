import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMobilePush, createMobilePushTransports, mobileNoticeData, umengMD5 } from '../packages/core/mobile-push.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createApp } from '../server/app.js'
import { issueToken } from '../packages/core/auth.js'

function atomicFixture(now = Date.now) {
  const records = new Map()
  return { consistency: 'linearizable', durable: true, records,
    async get(key) { const row = records.get(key); return row?.expiresAt > now() ? structuredClone({ version: row.version, value: row.value }) : null },
    async compareAndSet(key, version, value, { expiresAt }) { const row = records.get(key), current = row?.expiresAt > now() ? row : null; if ((current?.version ?? null) !== version) return false; records.set(key, { version: crypto.randomUUID(), value: structuredClone(value), expiresAt }); return true },
  }
}
test('FCM uses signed service-account OAuth and HTTPv1 data payload, and removes only UNREGISTERED tokens', async () => {
  const pair = await crypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' },true,['sign','verify'])
  const privateKey=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')
  const account={type:'service_account',project_id:'weshirt-test',client_email:'sender@weshirt-test.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\n'+privateKey+'\n-----END PRIVATE KEY-----'}
  const calls=[]; let code='UNREGISTERED'
  const transports=createMobilePushTransports({FCM_SERVICE_ACCOUNT_JSON:JSON.stringify(account)},{fetcher:async(url,options)=>{
    calls.push({url,options})
    if(url==='https://oauth2.googleapis.com/token'){
      const body=new URLSearchParams(options.body),jwt=body.get('assertion').split('.')
      assert.equal(body.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer')
      const claims=JSON.parse(Buffer.from(jwt[1],'base64url'));assert.equal(claims.aud,url);assert.equal(claims.scope,'https://www.googleapis.com/auth/firebase.messaging')
      assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',pair.publicKey,Buffer.from(jwt[2],'base64url'),new TextEncoder().encode(jwt[0]+'.'+jwt[1])),true)
      return new Response(JSON.stringify({access_token:'private-oauth-access',expires_in:3600}),{status:200})
    }
    assert.equal(url,'https://fcm.googleapis.com/v1/projects/weshirt-test/messages:send');assert.equal(options.headers.authorization,'Bearer private-oauth-access');assert.equal(options.redirect,'error')
    const payload=JSON.parse(options.body);assert.equal(payload.message.token,'device-token');assert.equal(payload.message.notification,undefined);assert.equal(payload.message.android.restricted_package_name,'com.laoke.weshirt')
    return new Response(JSON.stringify({error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:code}]}}),{status:400})
  }})
  const data=await mobileNoticeData({type:'mention',title:'有人@你',text:'打开查看',noticeId:'cm_test'})
  assert.equal((await transports.fcm('device-token',data)).gone,true)
  code='INVALID_ARGUMENT';assert.equal((await transports.fcm('device-token',data)).gone,false)
  assert.equal(calls.filter(call=>call.url.includes('oauth2')).length,1)
})
test('U-Push checksums exact HTTPS request bytes and supports OEM conversion without secondary FCM delivery', async () => {
  for(const input of ['', 'abc', '中文消息', 'A'.repeat(1000)])assert.equal(umengMD5(input),createHash('md5').update(input).digest('hex'))
  const env={UMENG_PUSH_APP_KEY:'a'.repeat(24),UMENG_PUSH_MASTER_SECRET:'b'.repeat(32),UMENG_PUSH_OEM_NOTIFICATIONS:'true'}
  let posted
  const transports=createMobilePushTransports(env,{fetcher:async(url,options)=>{
    const parsed=new URL(url);assert.equal(parsed.origin,'https://msgapi.umeng.com')
    assert.equal(parsed.searchParams.get('sign'),createHash('md5').update('POST'+'https://msgapi.umeng.com/api/send'+options.body+env.UMENG_PUSH_MASTER_SECRET).digest('hex'))
    posted=JSON.parse(options.body)
    return new Response('{"ret":"SUCCESS","data":{"msg_id":"provider_id"}}',{status:200})
  }})
  const data=await mobileNoticeData({type:'pickup',nativeEventKey:'pickup_one',title:'好友代取',text:'打开应用查看'})
  assert.equal((await transports.upush('umeng-device-token',data)).ok,true)
  assert.equal(posted.payload.display_type,'message');assert.equal(posted.payload.body.custom.eventId,data.eventId)
  assert.equal(posted.payload.message_3rd_notification.title,'好友代取');assert.equal(posted.channel_properties.channel_fcm,'0')
  assert.equal(posted.device_tokens,'umeng-device-token');assert.equal(posted.type,'unicast')
  assert.deepEqual(Object.keys(createMobilePushTransports({})),[])
})

test('task and queue payloads identify the exact local timer cycle without treating estimates as confirmed completion', async () => {
  const finishAt = new Date(Date.now() + 180000).toISOString()
  const task = await mobileNoticeData({ taskId: 'task_native', finishAt, nativeKind: 'ESTIMATED_END' })
  assert.equal(task.taskId, 'task_native'); assert.equal(task.finishAt, finishAt); assert.equal(task.serverConfirmed, 'false')
  const queue = await mobileNoticeData({ type: 'queue', reservationId: 'reservation_native', phase: 'lead', finishAt })
  assert.equal(queue.taskId, 'queue:reservation_native'); assert.equal(queue.kind, 'QUEUE_THREE_MINUTES'); assert.equal(queue.finishAt, finishAt)
  const ended = await mobileNoticeData({ type: 'queue', reservationId: 'reservation_native', phase: 'end', confirmed: true, finishAt })
  assert.equal(ended.kind, 'TASK_FINISHED'); assert.equal(ended.serverConfirmed, 'true')
})
async function fixture(transports){
  let at=Date.now()
  const store=createMemoryStore(),atomicStore=atomicFixture(()=>at),env={MOBILE_PUSH_ENABLED:'true'}
  await store.put('user:u_push',{id:'u_push',dormBuilding:'guiyuan'})
  const options={store,env,atomicStore,transports,now:()=>at},push=createMobilePush(options),id='installation_native_push'
  await push.register('u_push',id)
  await atomicStore.compareAndSet('mobile:installation:'+id,null,{userId:'u_push',installationId:id,provider:'fcm',token:'private-token',notificationsEnabled:true},{expiresAt:at+86400000})
  return {store,atomicStore,push,options,id,advance(ms){at+=ms}}
}
test('native outbox retries independently, deduplicates events across workers and never double-routes a device', async()=>{
  const calls=[];let success=false
  const transports={fcm:async(token,data)=>{calls.push({provider:'fcm',token,data});return {ok:success}},upush:async()=>{calls.push({provider:'upush'});return {ok:true}}}
  const f=await fixture(transports),notice={nativeEventKey:'stable_event',title:'洗衣提醒',text:'打开查看'}
  const first=await f.push.notify('u_push',notice);assert.equal(first.queued,true);assert.equal(first.ok,false);assert.equal(calls.length,1)
  await f.push.notify('u_push',notice);assert.equal(calls.length,1)
  success=true;f.advance(61000)
  await Promise.all([f.push.drain(),createMobilePush(f.options).drain()])
  assert.equal(calls.length,2);assert.equal(calls[0].data.eventId,calls[1].data.eventId);assert.equal(calls.every(call=>call.provider==='fcm'),true)
  await f.push.notify('u_push',notice);assert.equal(calls.length,2)
  const row=await f.atomicStore.get('mobile:installation-index:u_push')
  assert.equal(row.value.outbox[0].deliveries[f.id].state,'sent')
  assert.ok(!JSON.stringify(row).includes('private-token'))
})
test('unregistered and disabled installations stop retries and are removed from the user index',async()=>{
  let calls=0
  const f=await fixture({fcm:async()=>{calls++;return {ok:false,gone:true}}})
  await f.push.notify('u_push',{nativeEventKey:'gone_one',title:'提醒'})
  assert.equal((await f.atomicStore.get('mobile:installation:'+f.id)).value.token,null)
  assert.deepEqual((await f.atomicStore.get('mobile:installation-index:u_push')).value.installations,[])
  f.advance(61000);await f.push.drain();assert.equal(calls,1)
})
test('a queued mention is suppressed if building access changes before retry',async()=>{
  let calls=0
  const f=await fixture({fcm:async()=>{calls++;return {ok:false}}})
  await f.store.put('community-notices:u_push',[{id:'cm_private',messageId:'message_private'}])
  await f.store.put('messages:b1',[{id:'message_private',channel:'guiyuan'}])
  await f.push.notify('u_push',{type:'mention',channel:'guiyuan',noticeId:'cm_private',title:'有人@你',text:'私密频道'})
  assert.equal(calls,1)
  await f.store.put('user:u_push',{id:'u_push',dormBuilding:'liuyuan'})
  f.advance(61000);await f.push.drain();assert.equal(calls,1)
  assert.equal((await f.atomicStore.get('mobile:installation-index:u_push')).value.outbox[0].deliveries[f.id].state,'suppressed')
})

test('terminal retries release outbox capacity and old revisions cannot replace a newer notification', async () => {
  let calls = 0, success = false
  const f = await fixture({ fcm: async () => { calls++; return { ok: success } } })
  await f.push.notify('u_push', { nativeEventKey: 'exhausted_event', title: '提醒' })
  for (const delay of [61000, 121000, 241000]) { f.advance(delay); await f.push.drain() }
  const key = 'mobile:installation-index:u_push', row = await f.atomicStore.get(key)
  assert.equal(calls, 4); assert.equal(row.value.outbox[0].deliveries[f.id].state, 'failed')
  const failed = row.value.outbox[0]
  await f.atomicStore.compareAndSet(key, row.version, { ...row.value, outbox: Array.from({ length: 20 }, (_, index) => ({ ...failed, data: { ...failed.data, eventId: 'failed_' + index } })) }, { expiresAt: Date.now() + 86400000 })
  success = true
  assert.equal((await f.push.notify('u_push', { nativeEventKey: 'latest_event', revision: 2, title: '最新消息' })).ok, true)
  await f.push.notify('u_push', { nativeEventKey: 'latest_event', revision: 1, title: '旧消息' })
  assert.equal(calls, 5)
  assert.equal((await f.atomicStore.get(key)).value.outbox.length, 20)
})

test('disabling account notifications permanently suppresses old queued content', async () => {
  let calls = 0
  const f = await fixture({ fcm: async () => { calls++; return { ok: false } } })
  await f.push.notify('u_push', { nativeEventKey: 'before_optout', text: '旧提醒' })
  await f.store.put('user:u_push', { id: 'u_push', dormBuilding: 'guiyuan', notifyOn: false })
  f.advance(61000); await f.push.drain()
  await f.store.put('user:u_push', { id: 'u_push', dormBuilding: 'guiyuan', notifyOn: true })
  f.advance(61000); await f.push.drain()
  assert.equal(calls, 1)
  assert.equal((await f.atomicStore.get('mobile:installation-index:u_push')).value.outbox[0].deliveries[f.id].state, 'suppressed')
})

test('a newer revision suppresses an older retry before dispatching the latest content', async () => {
  const revisions = []; let success = false
  const f = await fixture({ fcm: async (_token, data) => { revisions.push(data.revision); return { ok: success } } })
  await f.push.notify('u_push', { nativeEventKey: 'versioned_notice', revision: 1, text: '旧内容' })
  success = true; f.advance(61000)
  await f.push.notify('u_push', { nativeEventKey: 'versioned_notice', revision: 2, text: '更新内容' })
  assert.deepEqual(revisions, ['1', '2'])
  assert.equal((await f.atomicStore.get('mobile:installation-index:u_push')).value.outbox[0].deliveries[f.id].state, 'suppressed')
})

test('scheduler pruning cannot lose a concurrently re-registered user', async () => {
  const f = await fixture({ fcm: async () => ({ ok: true }) })
  await f.push.remove('u_push', f.id)
  const compare = f.atomicStore.compareAndSet.bind(f.atomicStore)
  let inject = true
  f.atomicStore.compareAndSet = async (key, version, value, options) => {
    if (key === 'mobile:push-users:global' && inject) {
      inject = false
      await createMobilePush(f.options).register('u_push', f.id, 'replacement_session')
    }
    return compare(key, version, value, options)
  }
  await f.push.drain()
  assert.deepEqual((await f.atomicStore.get('mobile:push-users:global')).value.users, ['u_push'])
  assert.deepEqual((await f.atomicStore.get('mobile:installation-index:u_push')).value.installations, [f.id])
  await f.push.remove('u_push', f.id)
  await f.push.drain()
  assert.deepEqual((await f.atomicStore.get('mobile:push-users:global')).value.users, [])
})
test('actual configured transports enable capability discovery and registration creates an atomic user device index',async()=>{
  const store=createMemoryStore(),atomicStore=atomicFixture(),env={AUTH_SECRET:'native-api-test-secret-at-least-sixteen',MOBILE_PUSH_ENABLED:'true'}
  await store.put('user:u_push',{id:'u_push',dormBuilding:'guiyuan'})
  const app=createApp({store,env,mobile:{atomicStore,pushTransports:{upush:async()=>({ok:true})}}}),token=await issueToken('u_push',env.AUTH_SECRET)
  const config=await(await app.request('/api/mobile/config')).json();assert.deepEqual(config.push,{registrationEnabled:true,providers:['upush']})
  const response=await app.request('/api/mobile/installations/installation_native_push',{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({provider:'upush',token:'private-device-token',notificationsEnabled:true,appVersion:'0.1.1'})})
  assert.equal(response.status,200);assert.deepEqual((await atomicStore.get('mobile:installation-index:u_push')).value.installations,['installation_native_push'])
  assert.equal(JSON.stringify(await response.json()).includes('private-device-token'),false)
})
test('pickup route reaches the configured native sender even without a DingTalk account',async()=>{
  const store=createMemoryStore(),atomicStore=atomicFixture(),env={AUTH_SECRET:'native-api-test-secret-at-least-sixteen',MOBILE_PUSH_ENABLED:'true'}
  await store.put('user:u_owner',{id:'u_owner',nick:'甲',dormBuilding:'guiyuan'})
  await store.put('user:u_friend',{id:'u_friend',nick:'乙',dormBuilding:'guiyuan'})
  await store.put('social:friends:u_owner',[{userId:'u_friend'}]);await store.put('social:friends:u_friend',[{userId:'u_owner'}])
  await store.put('tasks:u_owner',[{id:'task_pickup',machineId:'machine_one',endAt:new Date(Date.now()+60000).toISOString()}])
  const events=[],transports={fcm:async(_token,data)=>{events.push(data);return {ok:true}}}
  const push=createMobilePush({store,env,atomicStore,transports})
  await push.register('u_friend','installation_friend')
  await atomicStore.compareAndSet('mobile:installation:installation_friend',null,{userId:'u_friend',provider:'fcm',token:'private-friend-token',notificationsEnabled:true},{expiresAt:Date.now()+86400000})
  const app=createApp({store,env,mobile:{atomicStore,pushTransports:transports}}),token=await issueToken('u_owner',env.AUTH_SECRET)
  const result=await app.request('/api/social/pickup',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({friendId:'u_friend',taskId:'task_pickup'})})
  assert.equal(result.status,200)
  assert.equal(events.length,1);assert.equal(events[0].kind,'PICKUP_REQUEST');assert.equal(events[0].revision,'1')
})
