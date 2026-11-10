import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueTicket } from '../packages/core/auth.js'
import { safeLoginTarget, createSingleFlight } from '../frontend/src/loginFlow.js'

const sources=Object.fromEntries(await Promise.all(['api','main','stores/user'].map(async name=>[name,await readFile(new URL('../frontend/src/'+name+'.js',import.meta.url),'utf8')])))
const device='a'.repeat(32),secret='synthetic-bootstrap-auth-secret-32'
const strip=source=>source.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'').replace(/^\{ BASE \}\s*;?/gm,'')

async function fixture({hash='#/',storedToken='',storedProfile=null,bindDevice=true,serviceWorker=false,documentState='loading'}={}){
  const memory=createMemoryStore()
  await memory.put('user:alice',{id:'alice',nick:'已保存昵称',dormBuilding:'guiyuan',notifyOn:false})
  if(bindDevice)await memory.put('userByDevice:'+device,'alice')
  const app=createApp({store:memory,env:{AUTH_SECRET:secret}}),requests=[]
  const values=new Map([['ws_device',device]])
  if(storedToken)values.set('ws_token',storedToken)
  if(storedProfile)values.set('ws_profile',JSON.stringify(storedProfile))
  const localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)}
  const clientSource=strip(sources.api).replaceAll('import.meta.env.VITE_API_BASE',"''").replaceAll('import.meta.env.DEV','false')
  let beforeRequest=async()=>{}
  const fetch=async(url,options={})=>{
    const path=new URL(url,'https://local.test').pathname
    const body=options.body?JSON.parse(options.body):null
    requests.push({path,body})
    await beforeRequest(path)
    return app.request('https://local.test'+url,options)
  }
  const client=new Function('fetch','localStorage','createSingleFlight','track','getTelemetryContext',clientSource+'\nreturn {api,claimCode,restoreDeviceSession,setToken,getToken,onReauth,onNeedLogin,logout,NEED_LOGIN}')(fetch,localStorage,createSingleFlight,()=>{},()=>({}))
  const pinia=createPinia();setActivePinia(pinia)
  const useUserStore=new Function('defineStore','localStorage',...Object.keys(client),'apiLogout',strip(sources['stores/user'])+'\nreturn useUserStore')(defineStore,localStorage,...Object.values(client),client.logout)
  const user=useUserStore()
  const location={hash,pathname:'/',search:''},timeline=[]
  const nativeHistory={replaceState(_state,_title,url){location.hash=url.slice(url.indexOf('#'))}}
  const routerHistory={location:hash.slice(1),replace(path){this.location=path;location.hash='#'+path;timeline.push('history:'+path)}}
  const router={options:{history:routerHistory},resolve:path=>({meta:{login:['/settings','/task','/inspection','/assistant'].includes(path.split('?')[0])}}),currentRoute:{value:{path:'/',fullPath:'/'}},replace(){}}
  let firstNavigation,mounted
  const createVueApp=()=>({
    use(plugin){
      if(plugin===router){
        firstNavigation={path:routerHistory.location,profile:JSON.parse(values.get('ws_profile')||'null'),loggedIn:user.isLoggedIn}
        timeline.push('router')
      }
      return this
    },
    mount(){mounted={user:user.user,loggedIn:user.isLoggedIn,ready:user.ready};timeline.push('mount')},
  })
  const body=strip(sources.main).replace(/\bboot\(\)\s*$/,'')
  const registrations=[],listeners=[]
  const bindings={location,history:nativeHistory,sessionStorage:{getItem(){return null},removeItem(){}},claimCode:client.claimCode,restoreDeviceSession:client.restoreDeviceSession,safeLoginTarget,createApp:createVueApp,App:{},createPinia:()=>pinia,useUserStore,setToken:client.setToken,router,Vant:{},initTelemetry(){},useDormStore:()=>({code:'guiyuan',loadSite(){}}),onNeedLogin:client.onNeedLogin,navigator:serviceWorker?{serviceWorker:{register:async(...args)=>registrations.push(args)}}:{},window:{isSecureContext:true,addEventListener:(name,callback,options)=>listeners.push({name,callback,options})},document:{readyState:documentState},console:{warn(){}}}
  const main=new Function(...Object.keys(bindings),body+'\nreturn {boot,preclaim}')(...Object.values(bindings))
  const claim=()=>issueTicket({role:'login_claim',u:'alice',d:device,nonce:crypto.randomUUID(),exp:Date.now()+60000},secret)
  return {main,user,client,localStorage,location,requests,claim,setHash(value){location.hash=value;routerHistory.location=value.slice(1)},setBeforeRequest(fn){beforeRequest=fn},get firstNavigation(){return firstNavigation},get mounted(){return mounted},timeline,registrations,listeners}
}

test('fresh OAuth callback hydrates the actual Pinia store/cache before router navigation and mount, and claims exactly once',async()=>{
  const f=await fixture(),claim=await f.claim()
  f.setHash('#/login?k='+encodeURIComponent(claim)+'&to=%2Fsettings')
  await f.main.boot()
  assert.equal(f.requests.filter(r=>r.path==='/api/auth/claim').length,1)
  assert.equal(f.requests[0].body.device,device)
  assert.equal(f.user.user.id,'alice');assert.equal(f.user.isLoggedIn,true)
  assert.equal(JSON.parse(f.localStorage.getItem('ws_profile')).nick,'已保存昵称')
  assert.deepEqual(f.firstNavigation,{path:'/settings',profile:f.user.user,loggedIn:true})
  assert.equal(f.mounted.ready,true);assert.equal(f.mounted.loggedIn,true)
  assert.equal(f.location.hash,'#/settings');assert.ok(!f.location.hash.includes('k='))
})

test('replaying an already-consumed callback restores this device without consuming another claim',async()=>{
  const f=await fixture(),claim=await f.claim()
  await f.client.claimCode(claim)
  f.client.setToken('');f.localStorage.removeItem('ws_profile')
  f.setHash('#/login?k='+encodeURIComponent(claim)+'&to=%2Ftask')
  await f.main.boot()
  assert.equal(f.user.isLoggedIn,true);assert.equal(f.user.user.id,'alice')
  assert.equal(f.requests.filter(r=>r.path==='/api/auth/claim').length,2,'one initial claim, one rejected replay')
  assert.deepEqual(f.requests.find(r=>r.path==='/api/auth').body,{device})
  assert.equal(f.firstNavigation.path,'/task');assert.equal(f.firstNavigation.loggedIn,true)
})

test('device-only protected-page startup sends the real device and restores before its route guard',async()=>{
  const f=await fixture({hash:'#/settings'})
  await f.main.boot()
  assert.deepEqual(f.requests.filter(r=>r.path==='/api/auth').map(r=>r.body),[{device}])
  assert.equal(f.firstNavigation.path,'/settings');assert.equal(f.firstNavigation.loggedIn,true)
  assert.equal(f.user.ready,true);assert.equal(f.user.user.id,'alice')
})

test('ensureAuth restores a bound device and a public unbound-device bootstrap stays silent',async()=>{
  const bound=await fixture()
  bound.user.init()
  assert.ok(await bound.user.ensureAuth())
  assert.equal(bound.user.isLoggedIn,true)
  assert.deepEqual(bound.requests[0].body,{device})
  const unbound=await fixture({bindDevice:false});let redirects=0
  unbound.client.onNeedLogin(()=>redirects++)
  unbound.user.init()
  assert.equal(await unbound.user.bootstrap(),false)
  assert.equal(unbound.user.ready,true);assert.equal(unbound.user.user,null)
  assert.equal(redirects,0)
})

test('late device restoration cannot replace a newer authenticated session',async()=>{
  const f=await fixture();let release,started
  const arrived=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve)
  f.setBeforeRequest(async path=>{if(path==='/api/auth'){started();await gate}})
  const pending=f.client.restoreDeviceSession({silent:true})
  await arrived
  f.client.setToken('new-account-token')
  release()
  await assert.rejects(pending,error=>error.code==='session_changed')
  assert.equal(f.client.getToken(),'new-account-token')
})

test('slow login startup registers its service worker even after window load; earlier startup registers once on load',async()=>{
  for(const documentState of ['complete','loading']){
    const f=await fixture({serviceWorker:true,documentState,hash:'#/settings'})
    await f.main.boot()
    if(documentState==='loading'){
      assert.equal(f.registrations.length,0)
      assert.equal(f.listeners.length,1)
      assert.equal(f.listeners[0].name,'load');assert.deepEqual(f.listeners[0].options,{once:true})
      await f.listeners[0].callback()
    }else assert.equal(f.listeners.length,0)
    assert.deepEqual(f.registrations,[['/sw.js',{updateViaCache:'none'}]])
  }
})
