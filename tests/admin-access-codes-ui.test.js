import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
const source=await readFile(new URL('../frontend/src/components/AdminAccessCodes.vue',import.meta.url),'utf8')
const full={view:true,operate:true,viewBuildings:null,operateBuildings:null}
const data={codes:[],base:{adminUsers:full},resources:[{key:'adminUsers',label:'成员',scoped:true}],buildings:[{code:'a',name:'甲楼'},{code:'b',name:'乙楼'}]}
function harness(api){let cleanup;const bindings={ref,api,onMounted(){},onUnmounted(fn){cleanup=fn},showConfirmDialog:async()=>{}};const script=source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'');return {...new Function(...Object.keys(bindings),script+'\nreturn {load,openCreate,create,closeCode,visible,name,oneTimeCode,error,draft,all,buildingChanged,viewChanged,ttlHours}')(...Object.values(bindings)),cleanup:()=>cleanup()}}

test('temporary-code manager compiles and clears the only full credential on close and unmount',async()=>{
  const {descriptor,errors}=parse(source);assert.deepEqual(errors,[])
  const compiled=compileScript(descriptor,{id:'access-codes'})
  assert.deepEqual(compileTemplate({source:descriptor.template.content,id:'access-codes',filename:'AdminAccessCodes.vue',compilerOptions:{bindingMetadata:compiled.bindings}}).errors,[])
  const requests=[],panel=harness(async(path,options)=>{requests.push({path,options});return options?.method==='POST'?{code:'test-only-full-code',accessCode:{id:'ac_fixture'}}:data})
  await panel.load();panel.openCreate();panel.name.value='值班';await panel.create()
  assert.equal(panel.oneTimeCode.value,'test-only-full-code')
  assert.deepEqual(requests.find(row=>row.options?.method==='POST').options.body.permissions,{})
  assert.equal(requests.find(row=>row.options?.method==='POST').options.retry,false)
  panel.closeCode();assert.equal(panel.oneTimeCode.value,'')
  panel.oneTimeCode.value='another-test-code';panel.cleanup();assert.equal(panel.oneTimeCode.value,'')
  assert.equal(/localStorage|sessionStorage/.test(source),false)
})

test('uncertain creation retries use one idempotency key and scope narrowing cannot widen operation',async()=>{
  const keys=[];let fail=true
  const panel=harness(async(path,options)=>{if(options?.method==='POST'){keys.push(options.idempotencyKey);if(fail){fail=false;throw new Error('连接未完成')}return {code:'fixture',accessCode:{id:'ac_fixture'}}}return data})
  await panel.load();panel.openCreate();panel.name.value='值班'
  panel.all('adminUsers','viewBuildings',false)
  assert.deepEqual(panel.draft.value.adminUsers.operateBuildings,[])
  panel.buildingChanged('adminUsers','viewBuildings','a',true)
  panel.buildingChanged('adminUsers','operateBuildings','a',true)
  panel.buildingChanged('adminUsers','viewBuildings','a',false)
  assert.deepEqual(panel.draft.value.adminUsers.operateBuildings,[])
  await panel.create();assert.equal(panel.oneTimeCode.value,'');assert.equal(panel.error.value,'连接未完成')
  await panel.create();assert.equal(keys.length,2);assert.equal(keys[0],keys[1])
  panel.cleanup()
})


test('the manager stays hidden for non-super 403 but shows recoverable service errors to an authorized manager',async()=>{
  const forbidden=harness(async()=>{throw Object.assign(new Error('仅总管可管理'),{status:403})});await forbidden.load();assert.equal(forbidden.visible.value,false);assert.equal(forbidden.oneTimeCode.value,'');forbidden.cleanup()
  const unavailable=harness(async()=>{throw Object.assign(new Error('原子存储暂不可用'),{status:503})});await unavailable.load();assert.equal(unavailable.visible.value,true);assert.equal(unavailable.error.value,'原子存储暂不可用');unavailable.cleanup()
})
