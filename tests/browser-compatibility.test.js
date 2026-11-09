import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source=fs.readFileSync(new URL('../frontend/src/browserCompatibility.js',import.meta.url),'utf8').replace('export function','function')
function realm() {
  const timers=[]
  const context=vm.createContext({ crypto:{ getRandomValues: bytes=>{bytes.fill(33);return bytes} }, AbortController, DOMException,
    AbortSignal:class{},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length} })
  vm.runInContext('delete Object.hasOwn;delete Array.prototype.at;delete String.prototype.at;',context)
  vm.runInContext(source,context)
  return { context,timers,run:code=>vm.runInContext(code,context) }
}
test('embedded runtime shims own-property checks without inherited or prototype-key confusion',()=>{
  const {run}=realm()
  assert.equal(run("Object.hasOwn({a:1},'a')"),true)
  assert.equal(run("Object.hasOwn({},'toString')"),false)
  assert.equal(run("Object.hasOwn(Object.create(null),'__proto__')"),false)
  assert.throws(()=>run("Object.hasOwn(null,'a')"))
})
test('array/string at supports negative, fractional and out-of-range indices',()=>{
  const {run}=realm()
  assert.equal(run('[3,5,7].at(-1)'),7)
  assert.equal(run('[3,5,7].at(1.9)'),5)
  assert.equal(run('[3].at(-2)'),undefined)
  assert.equal(run("'abc'.at(-2)"),'b')
  assert.equal(run("Array.prototype.at.call({length:2.5,2:'x'},2)"),undefined)
  assert.equal(run("String.prototype.at.call(123,-1)"),'3')
  assert.throws(()=>run('[1].at(1n)'))
})
test('UUID fallback uses secure random bytes and fixes RFC4122 version and variant bits',()=>{
  const {run}=realm()
  assert.match(run('crypto.randomUUID()'),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.throws(()=>run("crypto.getRandomValues=()=>{throw Error('unavailable')};crypto.randomUUID()"))
})
test('timeout fallback returns a working abort signal and preserves existing native methods',()=>{
  const {context,timers,run}=realm()
  const signal=run('AbortSignal.timeout(50)')
  assert.equal(signal.aborted,false);assert.equal(timers[0].ms,50)
  timers[0].fn();assert.equal(signal.aborted,true);assert.equal(signal.reason.name,'TimeoutError')
  assert.throws(()=>run('AbortSignal.timeout(-1)'))
  context.native=()=> 'existing'
  run('crypto.randomUUID=native;installBrowserCompatibility()')
  assert.equal(run('crypto.randomUUID()'),'existing')
})
