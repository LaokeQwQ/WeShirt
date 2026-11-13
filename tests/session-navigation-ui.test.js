import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {ref,computed,reactive} from 'vue'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
const source=await readFile(new URL('../frontend/src/App.vue',import.meta.url),'utf8')
test('recovery never displays guest status or navigates to login before completion; assistant is a distinct selected tab',()=>{
 const user=reactive({ready:false,isLoggedIn:false}),route=reactive({path:'/',name:'room3d',meta:{},fullPath:'/'}),pushes=[],toasts=[]
 const bindings={ref,computed,watch(){},useRoute:()=>route,useRouter:()=>({push:target=>pushes.push(target)}),useUserStore:()=>user,useDormStore:()=>({code:'guiyuan'}),showToast:text=>toasts.push(text)}
 const script=source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'')
 const panel=new Function(...Object.keys(bindings),script+'\nreturn {showLoginBar,onTab,activeTab}')(...Object.values(bindings))
 assert.equal(panel.showLoginBar.value,false);panel.onTab('/task');assert.equal(pushes.length,0);assert.match(toasts[0],/恢复账号/)
 user.ready=true;user.isLoggedIn=true;panel.onTab('/assistant');assert.equal(pushes[0],'/assistant')
 route.path='/assistant';assert.equal(panel.activeTab.value,'/assistant');assert.equal(panel.showLoginBar.value,false)
 user.isLoggedIn=false;assert.equal(panel.showLoginBar.value,true);panel.onTab('/settings');assert.deepEqual(pushes[1],{path:'/login',query:{to:'/settings'}})
 const {descriptor}=parse(source),scriptResult=compileScript(descriptor,{id:'app-session'})
 assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:'App.vue',id:'app-session',compilerOptions:{bindingMetadata:scriptResult.bindings}}).errors,[])
})
