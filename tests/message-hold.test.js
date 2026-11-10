import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageHold } from '../frontend/src/messageHold.js'

function fixture(){
  let clock=100,serial=0;const timers=new Map()
  const hold=createMessageHold({schedule:(fn)=>{timers.set(++serial,fn);return serial},unschedule:id=>timers.delete(id),now:()=>clock})
  const event=(extra={})=>({clientX:10,clientY:10,pointerId:1,button:0,isPrimary:true,...extra})
  return {hold,event,tick:()=>{for(const fn of timers.values())fn();timers.clear()},advance:()=>{clock+=1000},timers}
}
test('long press activates once, while pointer movement, end/cancel and a second pointer prevent accidental actions',()=>{
  const {hold,event,tick,timers}=fixture();let count=0
  hold.start(event(),()=>count++);hold.move(event({clientY:30}));tick();assert.equal(count,0)
  hold.start(event(),()=>count++);hold.cancel();tick();assert.equal(count,0)
  hold.start(event(),()=>count++);hold.move(event({pointerId:2}));tick();assert.equal(count,0)
  hold.start(event({isPrimary:false}),()=>count++);tick();assert.equal(count,0)
  hold.start(event({button:2}),()=>count++);tick();assert.equal(count,0)
  hold.start(event(),()=>count++);hold.move(event({clientX:14}));tick();assert.equal(count,1);assert.equal(timers.size,0)
})
test('an activated hold suppresses its synthetic click and does not block later normal taps',()=>{
  const {hold,event,tick,advance}=fixture();let prevented=0,stopped=0
  hold.start(event(),()=>{});tick()
  const click={preventDefault:()=>prevented++,stopPropagation:()=>stopped++}
  assert.equal(hold.suppressClick(click),true);assert.equal(prevented,1);assert.equal(stopped,1)
  advance();assert.equal(hold.suppressClick(click),false)
})
