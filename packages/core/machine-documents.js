import { createRemoteMobileAtomicStore } from './mobile-store.js'
import { mobileDigest } from './mobile-auth.js'
import { isMemoryStore } from './store.js'

const DAY=86400000,MAX_BYTES=48000,PAGE_BYTES=40000,PARALLEL=6
const contexts=new WeakMap(),locals=new WeakMap(),enc=new TextEncoder()
const clone=value=>structuredClone(value)
const bytes=value=>enc.encode(JSON.stringify(value)).length
const fail=()=>{throw Object.assign(new Error('机器数据暂不可用，请稍后重试'),{code:'machine_store_unavailable',status:503})}
const capacity=()=>{throw Object.assign(new Error('机器数据容量已满，请先清理历史记录'),{code:'machine_store_capacity',status:429})}
const expected=error=>['bad_param','forbidden','unauthorized','not_found','too_large','too_many','machine_store_unavailable','machine_store_capacity'].includes(error?.code)&&[400,401,403,404,409,413,429,503].includes(error.status)
const ready=store=>store?.consistency==='linearizable'&&store?.durable===true&&typeof store.get==='function'&&typeof store.compareAndSet==='function'

/** Only explicit mock environments and genuine in-process fixtures may use
 * this adapter. A production bridge failure cannot fall back to Edge KV. */
export function createProcessMachineAtomicStore(){
  const records=new Map()
  return {consistency:'linearizable',durable:true,
    async get(key){const row=records.get(key);return row?.expiresAt>Date.now()?clone({version:row.version,value:row.value}):null},
    async compareAndSet(key,version,value,{expiresAt}){const row=records.get(key),current=row?.expiresAt>Date.now()?row:null;if((current?.version??null)!==version)return false;records.set(key,{version:crypto.randomUUID(),value:clone(value),expiresAt});return true},
  }
}
export function configureMachineDocuments(store,{env={},atomicStore}={}){
  let atomic=atomicStore||createRemoteMobileAtomicStore(env)
  // Embedded callers may configure the durable transport once, then invoke a
  // sync without passing it again. Never replace that transport with a local one.
  const current=contexts.get(store)
  if(!atomic&&current&&!current.local&&ready(current.atomicStore))return
  if(!atomic&&(env.HAIER_MODE==='mock'||isMemoryStore(store))){atomic=locals.get(store);if(!atomic){atomic=createProcessMachineAtomicStore();locals.set(store,atomic)}}
  contexts.set(store,{atomicStore:atomic,local:!atomicStore&&!env.MOBILE_ATOMIC_STORE_URL&&(env.HAIER_MODE==='mock'||isMemoryStore(store))})
}
function context({store,env,atomicStore}){
  if(env||atomicStore)configureMachineDocuments(store,{env,atomicStore})
  if(!contexts.has(store))configureMachineDocuments(store)
  const value=contexts.get(store)
  if(!ready(value.atomicStore))fail()
  return value
}
async function mapLimited(values,fn){const out=new Array(values.length);let cursor=0;await Promise.all(Array.from({length:Math.min(PARALLEL,values.length)},async()=>{while(cursor<values.length){const index=cursor++;out[index]=await fn(values[index],index)}}));return out}
const documentKey=async key=>'mobile:limit:machine-document:'+await mobileDigest(key)
const pageKey=id=>'mobile:limit:machine-page:'+id
async function encodeDocument(atomic,key,value,paged,now,previous){
  if(!paged){const payload={format:1,kind:'document',document:value,renewAt:now+45*DAY};if(bytes(payload)>MAX_BYTES)capacity();return payload}
  if(!Array.isArray(value))fail()
  const chunks=[];let chunk=[],size=2
  for(const row of value){const length=bytes(row)+1;if(length>PAGE_BYTES)capacity();if(size+length>PAGE_BYTES){chunks.push(chunk);chunk=[];size=2}chunk.push(row);size+=length}
  if(chunk.length)chunks.push(chunk)
  const pages=await mapLimited(chunks,async rows=>{
    const id=await mobileDigest(key+'|'+JSON.stringify(rows)),name=pageKey(id)
    // The current manifest guarantees these immutable pages remain alive. Only
    // changed pages or a due renewal require another bridge read/write.
    if(previous?.kind==='pages'&&previous.renewAt>now&&previous.pages.includes(id))return id
    const existing=await atomic.get(name)
    if(!existing||existing.value.renewAt<=now){
      const saved=await atomic.compareAndSet(name,existing?.version??null,{format:1,rows,renewAt:now+45*DAY},{expiresAt:now+100*DAY})
      if(!saved){const winner=await atomic.get(name);if(!winner?.value?.rows)fail()}
    }
    return id
  })
  const payload={format:1,kind:'pages',pages,count:value.length,renewAt:now+45*DAY}
  if(bytes(payload)>MAX_BYTES)capacity()
  return payload
}
async function decodeDocument(atomic,payload,paged){
  if(payload?.format!==1||payload.kind!==(paged?'pages':'document'))fail()
  if(!paged)return clone(payload.document)
  if(!Array.isArray(payload.pages)||payload.pages.length>200)fail()
  const pages=await mapLimited(payload.pages,async id=>{if(!/^[A-Za-z0-9_-]{43}$/.test(id))fail();const page=await atomic.get(pageKey(id));if(page?.value?.format!==1||!Array.isArray(page.value.rows))fail();return page.value.rows})
  const value=pages.flat();if(value.length!==payload.count)fail();return clone(value)
}
async function snapshot(options){
  const {store,key,fallback={},paged=false,now=Date.now()}=options,{atomicStore,local}=context(options),name=await documentKey(key)
  for(let attempt=0;attempt<32;attempt++){
    const row=await atomicStore.get(name)
    if(row)return {atomicStore,local,name,row,document:await decodeDocument(atomicStore,row.value,paged)}
    const seed=await store.get(key,fallback)
    const payload=await encodeDocument(atomicStore,key,clone(seed),paged,now)
    if(await atomicStore.compareAndSet(name,null,payload,{expiresAt:now+90*DAY}))return {atomicStore,local,name,row:{version:null,value:payload},document:clone(seed),initialized:true}
  }
  fail()
}
export async function readMachineDocument(options){
  try{
    const value=await snapshot(options)
    if(value.row.value.renewAt<=(options.now??Date.now()))return (await updateMachineDocument(options,document=>({document}))).document
    return value.document
  }catch(error){if(expected(error))throw error;fail()}
}
/** The callback may run again after contention. Revalidate privileges there;
 * do not send notifications or perform irreversible side effects in it. */
export async function updateMachineDocument(options,mutate){
  try{
    const now=options.now??Date.now()
    for(let attempt=0;attempt<40;attempt++){
      const state=await snapshot(options)
      // Initialization returned no actual version. Read it again before CAS.
      if(state.initialized)continue
      const changed=await mutate(clone(state.document))
      if(!changed||!Object.hasOwn(changed,'document'))fail()
      if(JSON.stringify(changed.document)===JSON.stringify(state.document)&&state.row.value.renewAt>now)return {document:state.document,result:changed.result}
      const payload=await encodeDocument(state.atomicStore,options.key,changed.document,options.paged===true,now,state.row.value)
      if(await state.atomicStore.compareAndSet(state.name,state.row.version,payload,{expiresAt:now+90*DAY})){
        // Compatibility projection is never read after migration. A projection
        // failure cannot invalidate an already committed authoritative write.
        if(bytes(changed.document)<=MAX_BYTES)await options.store.put(options.key,clone(changed.document)).catch(()=>{})
        return {document:changed.document,result:changed.result}
      }
    }
    fail()
  }catch(error){if(expected(error))throw error;fail()}
}
