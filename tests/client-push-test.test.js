import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createProcessMachineAtomicStore } from '../packages/core/machine-documents.js'
import { createMobileAuth, mobileDigest, MOBILE_PACKAGE } from '../packages/core/mobile-auth.js'
import { issueToken } from '../packages/core/auth.js'
import { generateVapidKeys } from '../packages/core/webpush.js'

async function fixture() {
  const store = createMemoryStore(), atomicStore = createProcessMachineAtomicStore(), sent = []
  const env = { AUTH_SECRET:'test-client-push-secret-long-enough', MOBILE_PUSH_ENABLED:'true', MOBILE_AUTH_ENABLED:'true', DINGTALK_MOBILE_CLIENT_ID:'test-native-client', DINGTALK_MOBILE_CLIENT_SECRET:'test-native-client-secret', DINGTALK_MOBILE_REDIRECT_URI:'https://app.example/native-callback' }
  const identityProvider = { exchange: async () => ({unionId:'union-test'}) }
  await store.put('user:u_test', {id:'u_test',nick:'测试同学',dingUserId:'must-not-send-ding',dingUnionId:'union-test',notifyOn:true})
  await store.put('userByUnionId:union-test','u_test')
  const auth = createMobileAuth({store,env,atomicStore,identityProvider}), installationId='installation_current_123'
  const verifier='A'.repeat(64), state='state-current-device-123'
  const challenge = await auth.challenge({installationId,state,codeChallenge:await mobileDigest(verifier),platform:'android',packageName:MOBILE_PACKAGE})
  const session = await auth.exchange({challengeId:challenge.challengeId,state,codeVerifier:verifier,authCode:'fixture-code'})
  const makeApp = () => createApp({store,env,mobile:{atomicStore,identityProvider,pushTransports:{fcm:async(token,data)=>{sent.push({token,data});return {ok:true}},upush:async()=>{throw Error('must not double-route')}}}})
  const app = makeApp()
  const call = async (body, token=session.accessToken, target=app) => {
    const response=await target.request('/api/user/test-notify',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)})
    return {status:response.status,body:await response.json(),event:response.headers.get('x-event-id')}
  }
  const register=async(id=installationId,provider='fcm')=>{
    const response=await app.request('/api/mobile/installations/'+id,{method:'PUT',headers:{authorization:'Bearer '+(id===installationId?session.accessToken:await issueToken('u_test',env.AUTH_SECRET)),'content-type':'application/json'},body:JSON.stringify({provider,token:'private-token-'+id,notificationsEnabled:true,appVersion:'0.1.1'})})
    assert.equal(response.status,200)
  }
  return {store,atomicStore,env,app,makeApp,auth,session,installationId,call,register,sent}
}

test('native test sends only to the installation bound to the native session and returns acceptance, never DingTalk or another device', async t => {
  const f=await fixture();await f.register();await f.register('installation_other_123')
  t.mock.method(globalThis,'fetch',async()=>{throw Error('DingTalk or unexpected network call')})
  const result=await f.call({channel:'mobile',installationId:f.installationId})
  assert.equal(result.status,200);assert.equal(result.body.accepted,true);assert.equal(result.body.provider,'fcm');assert.equal(result.body.dm,undefined)
  assert.match(result.body.hint,/接受/);assert.equal(f.sent.length,1);assert.equal(f.sent[0].token,'private-token-'+f.installationId);assert.equal(f.sent[0].data.kind,'ANNOUNCEMENT')
  assert.ok(!JSON.stringify(result).includes('private-token'))
  const other=await f.call({channel:'mobile',installationId:'installation_other_123'})
  assert.equal(other.status,403);assert.ok(other.event);assert.equal(f.sent.length,1)
})

test('concurrent native client tests share a durable 10 second throttle across app workers', async () => {
  const f=await fixture();await f.register()
  const secondWorker=f.makeApp()
  const results=await Promise.all(Array.from({length:12},(_,index)=>f.call({channel:'mobile',installationId:f.installationId},f.session.accessToken,index%2?secondWorker:f.app)))
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===429).length,11);assert.equal(f.sent.length,1)
  assert.ok(results.filter(r=>r.status===429).every(r=>r.body.error.eventId&&r.body.error.status===429))
})

test('no native registration, disabled permission, switched installation and web tokens do not send a native test', async () => {
  const f=await fixture()
  assert.equal((await f.call({channel:'mobile',installationId:f.installationId})).status,409)
  await f.register()
  const key='mobile:installation:'+f.installationId,row=await f.atomicStore.get(key)
  await f.atomicStore.compareAndSet(key,row.version,{...row.value,notificationsEnabled:false},{expiresAt:Date.now()+60000})
  assert.equal((await f.call({channel:'mobile',installationId:f.installationId})).status,409)
  assert.equal((await f.call({channel:'mobile',installationId:f.installationId},await issueToken('u_test',f.env.AUTH_SECRET))).status,403)
  assert.equal((await f.call({})).status,400);assert.equal(f.sent.length,0)
})

test('Web Push tests only the exact owned subscription and never send DingTalk or mobile notifications', async t => {
  const f=await fixture(),vapid=await generateVapidKeys()
  f.env.VAPID_PRIVATE_JWK=JSON.stringify(vapid.privateJwk)
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits'])
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/current-browser',keys:{p256dh:Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url'),auth:Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')}}
  await f.store.put('subs',[{userId:'u_test',subscription},{userId:'u_test',subscription:{...subscription,endpoint:subscription.endpoint+'-other'}},{userId:'someone-else',subscription:{...subscription,endpoint:subscription.endpoint+'-foreign'}}])
  const calls=[]
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});assert.equal(url,subscription.endpoint);return new Response(null,{status:201})})
  const token=await issueToken('u_test',f.env.AUTH_SECRET)
  assert.equal((await f.call({channel:'web',endpoint:subscription.endpoint+'-foreign'},token)).status,409)
  const result=await f.call({channel:'web',endpoint:subscription.endpoint},token)
  assert.equal(result.status,200);assert.equal(result.body.provider,'webpush');assert.equal(result.body.accepted,true);assert.equal(calls.length,1);assert.equal(f.sent.length,0)
  assert.equal(calls[0].options.headers['content-encoding'],'aes128gcm');assert.ok(!JSON.stringify(result).includes(subscription.endpoint))
})
