import test from 'node:test'
import assert from 'node:assert/strict'
import {currentWebPushTarget} from '../frontend/src/webPushTest.js'
import {readFile} from 'node:fs/promises'
import {ref,computed} from 'vue'

test('browser notification test uses exactly the current subscription and never requests permission',async()=>{
 let reads=0
 const target=await currentWebPushTarget({secure:true,Notification:{permission:'granted',requestPermission:()=>assert.fail('test must not request consent')},navigator:{serviceWorker:{getRegistration:async()=>({pushManager:{getSubscription:async()=>{reads++;return {endpoint:'https://push.example/current'}}}})}}})
 assert.deepEqual(target,{channel:'web',endpoint:'https://push.example/current'});assert.equal(reads,1)
})
test('settings sends the current endpoint, preserves trace errors and drops late results after account changes',async()=>{
 const source=await readFile(new URL('../frontend/src/views/Settings.vue',import.meta.url),'utf8'),user={user:{id:'a'},token:'a'},calls=[]
 let target=async()=>({channel:'web',endpoint:'https://push.example/current'}),request=async()=>({ok:true,accepted:true,channel:'web'})
 const bindings={ref,computed,NEED_LOGIN:'NEED_LOGIN',watch(){},onMounted(){},onUnmounted(){},useRouter:()=>({replace(){}}),useRoute:()=>({}),useUserStore:()=>user,useDormStore:()=>({}),telemetryEnabled:()=>false,navigator:{},showToast(){},currentWebPushTarget:()=>target(),api:async(path,options)=>{calls.push({path,options});return request()}}
 const script=source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'')
 const panel=new Function(...Object.keys(bindings),script+'\nreturn {sendTest,testResult,testLoading}')(...Object.values(bindings))
 await panel.sendTest();assert.deepEqual(calls[0].options.body,{channel:'web',endpoint:'https://push.example/current'});assert.equal(panel.testResult.value.accepted,true)
 target=async()=>{throw Object.assign(Error('先开启通知'),{code:'not_subscribed'})};await panel.sendTest();assert.equal(calls.length,1);assert.equal(panel.testResult.value.action,'subscribe')
 target=async()=>({channel:'web',endpoint:'https://push.example/current'});request=async()=>{throw Error('服务失败 · 状态码 503 · 事件 evt_test')};await panel.sendTest();assert.match(panel.testResult.value.hint,/503.*evt_test/)
 let resolve;request=()=>new Promise(done=>resolve=done);const pending=panel.sendTest();await Promise.resolve();await Promise.resolve();user.user={id:'b'};resolve({ok:true});await pending;assert.equal(panel.testResult.value,null);assert.equal(panel.testLoading.value,false)
})
test('unsupported, refused, ungranted and missing subscription never produce a send target',async()=>{
 const base={secure:true,Notification:{permission:'granted'},navigator:{serviceWorker:{getRegistration:async()=>null}}}
 for(const [options,code,pattern] of [[{...base,secure:false},'unsupported',/不支持/],[{...base,Notification:{permission:'denied'}},'denied',/网站设置/],[{...base,Notification:{permission:'default'}},'not_subscribed',/开启通知/],[base,'not_subscribed',/未订阅/]])await assert.rejects(currentWebPushTarget(options),error=>error.code===code&&pattern.test(error.message))
})
