<template>
  <section v-if="visible" class="card access-codes">
    <header><div><h3>临时管理员口令</h3><p>默认有效 12 小时，最长 30 天。默认拥有管理员权限，可进一步缩小范围；总管专属功能不在授权内。</p></div><van-button size="small" :disabled="loading || saving" @click="load">刷新</van-button></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <van-button type="primary" size="small" :disabled="!loaded || loading || saving" @click="openCreate">创建临时口令</van-button>
    <div v-if="!loading && loaded && !codes.length" class="empty">暂无临时口令</div>
    <article v-for="row in codes" :key="row.id" class="access-row">
      <div class="row-title"><strong>{{ row.name }}</strong><span>{{ status(row) }}</span></div>
      <code>{{ row.prefix }}…{{ row.suffix }}</code><p v-if="row.note">{{ row.note }}</p>
      <small>创建 {{ time(row.createdAt) }} · 到期 {{ time(row.expiresAt) }}</small>
      <small>{{ Object.keys(row.permissions || {}).length ? '已设置功能或楼栋限制' : '默认管理员权限' }}</small>
      <van-button v-if="!row.revokedAt && row.expiresAt > now" size="small" type="danger" plain :disabled="saving" @click="revoke(row)">销毁口令及其会话</van-button>
    </article>
    <van-popup v-model:show="creating" position="bottom" round :close-on-click-overlay="!saving" :closeable="!saving" class="create-popup">
      <form @submit.prevent="create">
        <h3>创建临时口令</h3>
        <label>名称<input v-model="name" maxlength="60" required :disabled="saving" autocomplete="off" /></label>
        <label>备注<textarea v-model="note" maxlength="240" :disabled="saving" rows="2" /></label>
        <label>有效时长（小时）<input v-model.number="ttlHours" type="number" min="0.01" max="720" step="0.01" required :disabled="saving" /></label>
        <p>权限只可在管理员能力内缩小，操作范围不能超出查看范围。</p>
        <fieldset v-for="resource in resources" :key="resource.key" :disabled="saving">
          <legend>{{ resource.label }}</legend>
          <label class="inline"><input v-model="draft[resource.key].view" type="checkbox" :disabled="!base[resource.key]?.view" @change="viewChanged(resource.key)" />查看</label>
          <label class="inline"><input v-model="draft[resource.key].operate" type="checkbox" :disabled="!base[resource.key]?.operate || !draft[resource.key].view" />操作</label>
          <template v-if="resource.scoped && draft[resource.key].view">
            <div v-for="axis in axes(resource.key)" :key="axis.key" class="scope">
              <span>{{ axis.label }}</span>
              <label class="inline"><input type="checkbox" :checked="draft[resource.key][axis.key] === null" :disabled="axis.key === 'operateBuildings' && draft[resource.key].viewBuildings !== null" @change="all(resource.key, axis.key, $event.target.checked)" />所有楼栋</label>
              <div v-if="draft[resource.key][axis.key] !== null" class="building-options"><label v-for="building in allowedBuildings(resource.key, axis.key)" :key="building.code" class="inline"><input type="checkbox" :checked="draft[resource.key][axis.key].includes(building.code)" @change="buildingChanged(resource.key, axis.key, building.code, $event.target.checked)" />{{ building.name }}</label></div>
            </div>
          </template>
        </fieldset>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <van-button block type="primary" native-type="submit" :loading="saving" :disabled="!name.trim()">创建并显示一次</van-button>
      </form>
    </van-popup>
    <van-dialog :show="Boolean(oneTimeCode)" title="请立即保存口令" confirm-button-text="已保存，关闭" :close-on-click-overlay="false" @confirm="closeCode">
      <div class="one-time"><p>完整口令仅在此显示一次。关闭后只保留前后缀；无法恢复，遗失后请销毁并重建。</p><pre>{{ oneTimeCode }}</pre><van-button size="small" @click="copy">复制口令</van-button><p v-if="copyStatus">{{ copyStatus }}</p></div>
    </van-dialog>
  </section>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api'
import { showConfirmDialog } from 'vant'
const codes=ref([]),resources=ref([]),buildings=ref([]),base=ref({}),draft=ref({}),loaded=ref(false),loading=ref(false),saving=ref(false),error=ref(''),creating=ref(false)
const visible=ref(false)
const name=ref(''),note=ref(''),ttlHours=ref(12),oneTimeCode=ref(''),copyStatus=ref(''),now=ref(Date.now())
let alive=true,createKey='',createBody='',timer
const clone=value=>JSON.parse(JSON.stringify(value))
const time=value=>new Date(value).toLocaleString()
const status=row=>row.revokedAt?'已销毁':row.expiresAt<=now.value?'已过期':'有效'
async function load(){if(loading.value||saving.value)return;loading.value=true;error.value='';try{const data=await api('/api/admin/access-codes',{auth:'optional',retry:false});if(!alive)return;visible.value=true;codes.value=data.codes||[];resources.value=data.resources||[];base.value=data.base||{};buildings.value=[{code:'public',name:'公共频道'},...(data.buildings||[]).filter(row=>row.code!=='public')];loaded.value=true}catch(e){if(alive){if(e.status===401||e.status===403){visible.value=false;loaded.value=false;codes.value=[];resources.value=[];base.value={};creating.value=false;closeCode()}else{visible.value=true;error.value=e.message}}}finally{if(alive)loading.value=false}}
function openCreate(){name.value='';note.value='';ttlHours.value=12;draft.value=clone(base.value);error.value='';createKey='';createBody='';creating.value=true}
function viewChanged(key){if(!draft.value[key].view)draft.value[key].operate=false}
function axes(key){return [{key:'viewBuildings',label:'可查看楼栋'},...(draft.value[key].operate?[{key:'operateBuildings',label:'可操作楼栋'}]:[])]}
function allowedBuildings(key,axis){const scope=draft.value[key].viewBuildings;return buildings.value.filter(row=>axis!=='operateBuildings'||scope===null||scope.includes(row.code))}
function all(key,axis,checked){const row=draft.value[key];row[axis]=checked?null:[];if(axis==='viewBuildings'&&!checked)row.operateBuildings=[]}
function buildingChanged(key,axis,code,checked){const row=draft.value[key],scope=new Set(row[axis]);if(checked)scope.add(code);else scope.delete(code);row[axis]=[...scope];if(axis==='viewBuildings'&&row.operateBuildings!==null)row.operateBuildings=row.operateBuildings.filter(value=>scope.has(value))}
async function create(){
  if(saving.value||!name.value.trim())return
  const permissions=Object.fromEntries(Object.entries(draft.value).filter(([key,row])=>JSON.stringify(row)!==JSON.stringify(base.value[key])))
  const body={name:name.value.trim(),note:note.value.trim(),ttlHours:ttlHours.value,permissions},serialized=JSON.stringify(body)
  if(serialized!==createBody){createBody=serialized;createKey=crypto.randomUUID()}
  saving.value=true;error.value=''
  try{const result=await api('/api/admin/access-codes',{method:'POST',auth:'optional',retry:false,idempotencyKey:createKey,body});if(!alive)return;oneTimeCode.value=result.code;copyStatus.value='';creating.value=false;createKey='';createBody='';saving.value=false;await load()}
  catch(e){if(alive)error.value=e.message}
  finally{if(alive)saving.value=false}
}
async function revoke(row){if(saving.value)return;try{await showConfirmDialog({title:'销毁临时口令？',message:'使用「'+row.name+'」建立的全部会话会立即失效，口令无法恢复。'})}catch{return}saving.value=true;error.value='';try{await api('/api/admin/access-codes/'+encodeURIComponent(row.id),{method:'DELETE',auth:'optional',retry:false});if(!alive)return;saving.value=false;await load()}catch(e){if(alive)error.value=e.message}finally{if(alive)saving.value=false}}
async function copy(){try{await navigator.clipboard.writeText(oneTimeCode.value);copyStatus.value='已复制，请保存在可信位置'}catch{copyStatus.value='复制未完成，请手动选择上方口令'}}
function closeCode(){oneTimeCode.value='';copyStatus.value=''}
onMounted(()=>{load();timer=setInterval(()=>{now.value=Date.now()},30000)})
onUnmounted(()=>{alive=false;clearInterval(timer);closeCode();draft.value={};createKey='';createBody=''})
</script>

<style scoped>
.access-codes{margin:12px;padding:16px}.access-codes header,.row-title{display:flex;justify-content:space-between;align-items:center;gap:12px}.access-codes h3{font-size:16px;margin:0}.access-codes p,.access-codes small{font-size:12px;line-height:1.7;color:var(--text-dim)}.error{color:#fca5a5!important;overflow-wrap:anywhere}.access-row{display:grid;gap:8px;padding:16px 0;border-bottom:1px solid var(--border)}.access-row p{margin:0}.access-row code{overflow-wrap:anywhere;font-size:12px}.row-title span{font-size:12px;color:var(--text-dim)}.empty{padding:22px 0;color:var(--text-dim)}.create-popup{max-height:88vh;background:var(--bg);color:var(--text)}form{padding:24px 18px 30px;display:grid;gap:14px}label{display:grid;gap:6px;font-size:13px}input:not([type=checkbox]),textarea{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;box-sizing:border-box}fieldset{border:1px solid var(--border);border-radius:10px;padding:12px;min-width:0}legend{font-size:13px}.inline{display:inline-flex;align-items:center;gap:6px;margin:5px 12px 5px 0}.scope{font-size:12px;padding-top:8px}.scope>span{display:block}.building-options{display:flex;flex-wrap:wrap}.one-time{padding:12px 20px 24px}.one-time pre{white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;word-break:break-all;padding:12px;border-radius:8px;background:var(--bg);font-size:12px}.one-time p{font-size:13px;line-height:1.6}
</style>
