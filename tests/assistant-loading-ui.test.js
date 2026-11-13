import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {ref,reactive,computed,watch,nextTick,effectScope} from 'vue'
import {createAssistantResourceCache} from '../frontend/src/assistantResourceCache.js'
const source=await readFile(new URL('../frontend/src/views/Assistant.vue',import.meta.url),'utf8')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function fixture(){
 const requests=[],reads=[],confirmations=[]
 const user=reactive({ready:true,isLoggedIn:true,user:{id:'A'},token:'token-A'})
 const data=createAssistantResourceCache({request:key=>new Promise((resolve,reject)=>reads.push({key,resolve,reject}))})
 data.setSession('A','token-A')
 const scope=effectScope(),unmount=[]
 const bindings={ref,reactive,computed,watch,nextTick,onMounted(){},onUnmounted:fn=>unmount.push(fn),useRoute:()=>({query:{}}),useRouter:()=>({}),useUserStore:()=>user,assistantData:data,BASE:'',window:{location:{origin:'https://fixture.invalid'}},dormBuildingName:()=>'',showToast(){},showConfirmDialog:()=>new Promise(resolve=>confirmations.push(resolve)),api:(path,options)=>new Promise(resolve=>requests.push({path,options,resolve}))}
 const script=source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'')
 const panel=scope.run(()=>new Function(...Object.keys(bindings),script+'\nreturn {status,memory,messages,preferences,input,canChat,loadResource,send,clearHistory,pendingResources,failedResources}')(...Object.values(bindings)))
 return {panel,user,data,requests,reads,confirmations,dispose(){unmount.forEach(fn=>fn());scope.stop()}}
}
test('actual assistant view displays fast status/memory while history is pending and preferences has its own error',async()=>{
 const f=fixture();f.data.prefetch();await tick()
 f.reads.find(r=>r.key==='status').resolve({ready:true,dormBuilding:'guiyuan',usage:{dailyRemaining:5}})
 f.reads.find(r=>r.key==='memory').resolve({note:'cold water',enabled:true})
 f.reads.find(r=>r.key==='preferences').reject(new Error('preferences HTTP 503 evt_fixture'))
 await tick()
 assert.equal(f.panel.canChat.value,true);assert.equal(f.panel.memory.value.note,'cold water')
 assert.ok(f.panel.pendingResources.value.some(row=>row.key==='history'))
 assert.deepEqual(f.panel.failedResources.value.map(row=>row.key),['preferences'])
 assert.deepEqual(f.panel.messages.value,[])
 for(const r of f.reads.filter(r=>['history','skills'].includes(r.key)))r.resolve({})
 await tick();f.dispose()
})
test('chat response from the old mounted account cannot populate the new account cache before Vue unmount',async()=>{
 const f=fixture();f.data.publish('status',{ready:true,dormBuilding:'guiyuan',usage:{dailyRemaining:5}});f.panel.input.value='hello'
 const sent=f.panel.send();assert.equal(f.requests.length,1)
 f.user.user={id:'B'};f.user.token='token-B';f.data.setSession('B','token-B')
 f.requests[0].resolve({messages:[{content:'private A reply'}],usage:{dailyRemaining:4}});await sent
 assert.equal(f.data.state.history.data,null);assert.equal(f.data.state.status.data,null)
 assert.deepEqual(f.panel.messages.value,[]);f.dispose()
})
test('confirming a dialog opened by the previous account never deletes the next account history',async()=>{
 const f=fixture();const clearing=f.panel.clearHistory();assert.equal(f.confirmations.length,1)
 f.user.user={id:'B'};f.user.token='token-B';f.data.setSession('B','token-B')
 f.confirmations[0]();await clearing
 assert.equal(f.requests.length,0);f.dispose()
})
