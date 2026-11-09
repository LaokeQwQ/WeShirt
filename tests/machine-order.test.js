import test from 'node:test'
import assert from 'node:assert/strict'
import { sortByAvailability } from '../frontend/src/machineOrder.js'
test('最快可用优先空闲、按可信结束时刻、未知和故障置后，且不改源数组',()=>{
 const now=Date.now(),list=[{id:'fault',state:'faulty'},{id:'late',state:'occupied',finishAt:new Date(now+120000).toISOString()},{id:'unknown',state:'unknown'},{id:'uncollected',state:'idle',suspectedUncollected:true},{id:'soon',state:'occupied',finishAt:new Date(now+60000).toISOString()},{id:'idle',state:'idle'}]
 assert.deepEqual(sortByAvailability(list,now).map(m=>m.id),['idle','soon','late','uncollected','unknown','fault']);assert.equal(list[0].id,'fault')
})
