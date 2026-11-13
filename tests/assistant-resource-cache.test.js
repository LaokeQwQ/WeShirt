import test from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantResourceCache } from '../frontend/src/assistantResourceCache.js'

function fixture(){
  const calls=[];let time=1000
  const cache=createAssistantResourceCache({now:()=>time,request:key=>new Promise((resolve,reject)=>calls.push({key,resolve,reject}))})
  cache.setSession('A','token-A')
  return {cache,calls,advance:ms=>{time+=ms}}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))

test('preload and page share inflight GETs; fast cards appear before slow history and failures are local',async()=>{
  const {cache,calls}=fixture();cache.prefetch();const status=cache.read('status');const memory=cache.read('memory');await tick()
  assert.equal(calls.length,5)
  calls.find(r=>r.key==='status').resolve({ready:true});await status
  assert.equal(cache.state.status.data.ready,true)
  assert.equal(cache.state.history.loading,true)
  calls.find(r=>r.key==='memory').reject(new Error('memory HTTP 503, event fixture'));await memory
  assert.match(cache.state.memory.error,/503/)
  assert.equal(cache.state.status.error,'');assert.equal(cache.state.history.error,'')
  for(const r of calls.filter(r=>!['status','memory'].includes(r.key)))r.resolve({})
  await tick()
})
test('fresh cache avoids duplicate visits; expired resource refreshes independently and keeps its last card',async()=>{
  const {cache,calls,advance}=fixture();const first=cache.read('memory');await tick();calls[0].resolve({note:'A only'});await first
  const local=await cache.read('memory');local.note='unsaved edit'
  assert.equal(cache.state.memory.data.note,'A only','a local editor must not mutate cached server data')
  assert.equal(calls.length,1)
  advance(60001);const next=cache.read('memory');await tick()
  assert.equal(calls.length,2);assert.equal(cache.state.memory.data.note,'A only');assert.equal(cache.state.memory.loading,true)
  calls[1].resolve({note:'fresh'});await next;assert.equal(cache.state.memory.data.note,'fresh')
})
test('logout and account/session changes synchronously erase all private cards; late old responses cannot reappear',async()=>{
  const {cache,calls}=fixture();const a=cache.read('history');await tick()
  cache.publish('memory',{note:'private A'});cache.setSession('B','token-B')
  assert.equal(cache.state.memory.data,null);assert.equal(cache.state.history.loading,false)
  const b=cache.read('history');await tick();calls[0].resolve({messages:[{content:'private A'}]});await a
  assert.equal(cache.state.history.data,null);assert.equal(cache.state.history.loading,true)
  calls[1].resolve({messages:[{content:'private B'}]});await b
  cache.setSession('B','rotated-token');assert.equal(cache.state.history.data,null)
  cache.setSession();assert.equal(await cache.read('history'),null);assert.equal(calls.length,2)
})
test('a late read cannot restore history or memory deleted by a successful mutation',async()=>{
  const {cache,calls}=fixture();const first=cache.read('history');await tick()
  cache.publish('history',{messages:[]});calls[0].resolve({messages:[{content:'deleted'}]});await first
  assert.deepEqual(cache.state.history.data,{messages:[]})
})
test('retries only request the failed card and clear its error without discarding other cards',async()=>{
  const {cache,calls}=fixture();cache.publish('status',{ready:true});const failed=cache.read('skills');await tick();calls[0].reject(new Error('skills unavailable'));await failed
  const retry=cache.read('skills',{force:true});await tick()
  assert.equal(calls.length,2);assert.equal(cache.state.skills.error,'');assert.equal(cache.state.status.data.ready,true)
  calls[1].resolve({skills:[]});await retry;assert.deepEqual(cache.state.skills.data,{skills:[]})
})
test('queued prefetch never starts requests after logout in the same turn',async()=>{
  const {cache,calls}=fixture();cache.prefetch();cache.setSession();await tick();assert.equal(calls.length,0)
})
