import test from 'node:test'
import assert from 'node:assert/strict'
import {createChannelReadTracker,visibleChannelMessageIds} from '../frontend/src/channelReadTracker.js'

function fixture(){
 let context={key:'a|public',owner:'a',channel:'public'},ids=['first'],visible=true,callback,sendImpl=async()=>({ok:true}),receipts=[],results=[],errors=[]
 const reader=createChannelReadTracker({context:()=>context,visible:()=>visible,visibleIds:()=>ids,send:async(body,view)=>{receipts.push({body,view});return sendImpl()},onRead:(result,view)=>results.push({result,view}),onError:(error,view)=>errors.push({error,view}),setTimer:fn=>{callback=fn;return 1},clearTimer:()=>{callback=null}})
 return {reader,receipts,results,errors,context:value=>context=value,ids:value=>ids=value,visible:value=>visible=value,send:value=>sendImpl=value,async tick(){const fn=callback;callback=null;await fn?.()}}
}
test('only stable visible message IDs are acknowledged; a scrolled-away candidate and other channels remain unread',async()=>{
 const f=fixture();f.ids(['first','partly-seen']);f.reader.schedule();f.ids(['first','newly-scrolled-in']);await f.tick()
 assert.deepEqual(f.receipts[0].body,{channel:'public',messageIds:['first']})
 await f.tick();assert.deepEqual(f.receipts[1].body.messageIds,['newly-scrolled-in'])
 f.reader.schedule();await f.tick();assert.equal(f.receipts.length,2,'already read messages are not repeatedly posted')
 f.reader.dispose()
})
test('background, lost focus, directory and account switches do not acknowledge stale candidates',async()=>{
 const f=fixture();f.reader.schedule();f.visible(false);await f.tick();assert.equal(f.receipts.length,0)
 f.visible(true);f.reader.schedule();f.context({key:'a|guiyuan',owner:'a',channel:'guiyuan'});await f.tick();assert.equal(f.receipts.length,0)
 f.reader.schedule();f.context({key:'b|guiyuan',owner:'b',channel:'guiyuan'});await f.tick();assert.equal(f.receipts.length,0)
 f.context({key:'b|directory',owner:'b',channel:''});f.reader.schedule();await f.tick();assert.equal(f.receipts.length,0)
 f.context({key:'guest|public',owner:'',channel:'public'});f.reader.schedule();await f.tick();assert.equal(f.receipts.length,0)
 f.reader.dispose()
})
test('failed read is retried on interaction without optimistic count clearing; late success cannot update a new account',async()=>{
 const f=fixture();f.send(async()=>{throw Error('offline')});f.reader.schedule();await f.tick();assert.equal(f.results.length,0)
 let resolve;f.send(()=>new Promise(done=>resolve=done));f.reader.schedule();const request=f.tick();assert.equal(f.receipts.length,2)
 f.context({key:'b|public',owner:'b',channel:'public'});f.reader.reset();resolve({unreadCount:0});await request
 assert.equal(f.results.length,0)
 f.send(async()=>({unreadCount:3}));f.reader.schedule();await f.tick();assert.equal(f.results.length,1);assert.equal(f.results[0].view.owner,'b')
 f.reader.dispose()
})
test('one receipt is bounded at 50 visible IDs and subsequent visible messages use another receipt',async()=>{
 const f=fixture();f.ids(Array.from({length:65},(_,i)=>'id-'+i));f.reader.schedule();await f.tick();assert.equal(f.receipts[0].body.messageIds.length,50);await f.tick();assert.equal(f.receipts[1].body.messageIds.length,15);f.reader.dispose()
})
test('deleted-message failures preserve unread and expose recovery only for the original live scope',async()=>{
 const f=fixture();f.send(async()=>{throw Object.assign(Error('gone'),{status:404})});f.reader.schedule();await f.tick()
 assert.equal(f.results.length,0);assert.equal(f.errors[0].error.status,404)
 f.ids(['replacement']);f.send(async()=>({ok:true}));f.reader.schedule();await f.tick()
 assert.deepEqual(f.receipts[1].body.messageIds,['replacement'])
 f.reader.schedule();f.reader.pause();await f.tick();assert.equal(f.receipts.length,2,'opening a modal cancels the pending visible receipt')
 f.reader.dispose()
})
test('viewport hit testing excludes articles behind the header, composer, or outside the page',()=>{
 const nodes=[[-100,-20,100,'above'],[20,70,100,'header'],[75,175,100,'seen'],[700,800,100,'composer'],[300,700,100,'tall'],[100,140,0,'hidden']].map(([top,bottom,width,id])=>({dataset:{messageId:id},getBoundingClientRect:()=>({top,bottom,width,height:bottom-top})}))
 assert.deepEqual(visibleChannelMessageIds({querySelectorAll:()=>nodes},{top:90,bottom:680}),['seen','tall'])
})
