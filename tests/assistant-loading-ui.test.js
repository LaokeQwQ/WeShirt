import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {ref,reactive,computed,watch,nextTick,effectScope} from 'vue'
import {ASSISTANT_WARMUP_RESOURCES,createAssistantResourceCache} from '../frontend/src/assistantResourceCache.js'
import {createAssistantMic,createAssistantSpeech} from '../frontend/src/assistantSpeech.js'
const source=await readFile(new URL('../frontend/src/views/Assistant.vue',import.meta.url),'utf8')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function fixture({prepareAssistantPhoto = async () => 'data:image/jpeg;base64,test-photo'} = {}){
 const requests=[],reads=[],confirmations=[]
 const user=reactive({ready:true,isLoggedIn:true,user:{id:'A'},token:'token-A'})
 const data=createAssistantResourceCache({request:key=>new Promise((resolve,reject)=>reads.push({key,resolve,reject}))})
 data.setSession('A','token-A')
 const scope=effectScope(),unmount=[]
 const bindings={ref,reactive,computed,watch,nextTick,onMounted:fn=>fn(),onUnmounted:fn=>unmount.push(fn),useRoute:()=>({query:{}}),useRouter:()=>({}),useUserStore:()=>user,assistantData:data,BASE:'',window:{location:{origin:'https://fixture.invalid'}},document:{addEventListener(){},removeEventListener(){}},ASSISTANT_WARMUP_RESOURCES,createAssistantMic,createAssistantSpeech,prepareAssistantPhoto,assistantRecordingWorkletUrl:'fixture.js',dormBuildingName:()=>'',showToast(){},showConfirmDialog:()=>new Promise(resolve=>confirmations.push(resolve)),api:(path,options)=>new Promise(resolve=>requests.push({path,options,resolve})),streamAssistantChat:(body,options)=>new Promise(resolve=>requests.push({body,options,resolve}))}
 const script=source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'')
 const panel=scope.run(()=>new Function(...Object.keys(bindings),script+'\nreturn {status,memory,messages,savedMessages,showHistory,openHistory,preferences,input,canChat,canSend,attachment,choosePhoto,removePhoto,loadResource,send,clearHistory,pendingResources,failedResources,draftTurn,partialTurn}')(...Object.values(bindings)))
 return {panel,user,data,requests,reads,confirmations,dispose(){unmount.forEach(fn=>fn());scope.stop()}}
}
test('actual assistant view loads status/memory on entry and only fetches saved history when requested',async()=>{
 const f=fixture();f.data.prefetch();await tick()
 f.reads.find(r=>r.key==='status').resolve({ready:true,dormBuilding:'guiyuan',usage:{dailyRemaining:5}})
 f.reads.find(r=>r.key==='memory').resolve({note:'cold water',enabled:true})
 f.reads.find(r=>r.key==='preferences').reject(new Error('preferences HTTP 503 evt_fixture'))
 await tick()
 assert.equal(f.panel.canChat.value,true);assert.equal(f.panel.memory.value.note,'cold water')
 assert.equal(f.reads.some(row=>row.key==='history'),false)
 assert.deepEqual(f.panel.failedResources.value.map(row=>row.key),['preferences'])
 assert.deepEqual(f.panel.messages.value,[])
 f.panel.openHistory();await tick()
 assert.equal(f.panel.showHistory.value,true)
 f.reads.find(r=>r.key==='history').resolve({messages:[{role:'user',content:'saved old turn'}]})
 f.reads.find(r=>r.key==='skills').resolve({})
 await tick()
 assert.equal(f.panel.savedMessages.value[0].content,'saved old turn')
 assert.deepEqual(f.panel.messages.value,[])
 f.dispose()
})
test('each open assistant gets a distinct context ID and can send follow-ups in that visit',async()=>{
 const f=fixture(),second=fixture()
 for(const page of [f,second])page.data.publish('status',{ready:true,dormBuilding:'guiyuan',usage:{dailyRemaining:5}})
 async function send(page,text){
   page.panel.input.value=text
   const pending=page.panel.send()
   const sent=page.requests.at(-1)
   sent.resolve({messages:[{content:text}],usage:{dailyRemaining:4}})
   await pending
   return sent.body.conversationId
 }
 const firstId=await send(f,'first')
 assert.match(firstId,/^[a-f0-9-]{36}$/)
 assert.equal(await send(f,'follow-up'),firstId)
 assert.notEqual(await send(second,'new view'),firstId)
 f.dispose();second.dispose()
})
test('chat response from the old mounted account cannot populate the new account cache before Vue unmount',async()=>{
 const f=fixture();f.data.publish('status',{ready:true,dormBuilding:'guiyuan',usage:{dailyRemaining:5}});f.panel.input.value='hello'
 const sent=f.panel.send();assert.equal(f.requests.length,1)
 f.requests[0].options.onDelta('partial reply');assert.equal(f.panel.draftTurn.value.text,'partial reply')
 f.user.user={id:'B'};f.user.token='token-B';f.data.setSession('B','token-B')
 assert.equal(f.requests[0].options.signal.aborted,true)
 f.requests[0].options.onDelta('private late fragment')
 f.requests[0].resolve({messages:[{content:'private A reply'}],usage:{dailyRemaining:4}});await sent
 assert.equal(f.data.state.history.data,null);assert.equal(f.data.state.status.data,null)
 assert.deepEqual(f.panel.messages.value,[]);assert.equal(f.panel.draftTurn.value,null);assert.equal(f.panel.partialTurn.value,null);f.dispose()
})
test('confirming a dialog opened by the previous account never deletes the next account history',async()=>{
 const f=fixture();const clearing=f.panel.clearHistory();assert.equal(f.confirmations.length,1)
 f.user.user={id:'B'};f.user.token='token-B';f.data.setSession('B','token-B')
 f.confirmations[0]();await clearing
 assert.equal(f.requests.length,0);f.dispose()
})

const photoEvent = () => ({ target: { files: [{ type: 'image/jpeg' }], value: 'mock.jpg' } })
test('assistant waits for confirmation to send selected photo with optional text, then clears the local copy', async () => {
 const f=fixture()
 f.data.publish('status',{ready:true,dormBuilding:'guiyuan',usage:{dailyRemaining:5},imageInputReady:true})
 await f.panel.choosePhoto(photoEvent())
 assert.equal(f.requests.length,0)
 assert.equal(f.panel.canSend.value,true)
 const sent=f.panel.send()
 assert.equal(f.requests[0].body.input,'')
 assert.match(f.requests[0].body.photoData,/^data:image\/jpeg;base64,/)
 f.requests[0].resolve({messages:[{content:'已查看照片'}],usage:{dailyRemaining:4}})
 await sent
 assert.equal(f.panel.attachment.value,'')
 assert.equal(f.data.state.history.data,null)
 f.dispose()
})

test('removing or leaving during photo conversion discards delayed results', async () => {
 let complete
 const f=fixture({prepareAssistantPhoto:()=>new Promise(resolve=>{complete=resolve})})
 f.data.publish('status',{ready:true,dormBuilding:'guiyuan',usage:{dailyRemaining:5},imageInputReady:true})
 const pending=f.panel.choosePhoto(photoEvent())
 f.panel.removePhoto()
 complete('data:image/jpeg;base64,late')
 await pending
 assert.equal(f.panel.attachment.value,'')
 const leaving=f.panel.choosePhoto(photoEvent())
 f.dispose()
 complete('data:image/jpeg;base64,private')
 await leaving
 assert.equal(f.panel.attachment.value,'')
 assert.equal(f.requests.length,0)
})
