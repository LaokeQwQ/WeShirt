<template>
  <main class="page inspection"><van-nav-bar title="楼栋巡检" left-arrow @click-left="$router.back()" /><div class="inspection-content">
    <p class="dim">巡检用于现场复核。发现异常后会尝试通知本楼指定群，机器状态仍以数据源与复核结果为准。</p><p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="loading&&!data" class="dim">正在读取巡检权限…</p>
    <template v-if="data"><div class="identity">{{ data.identity.label }}<span>{{ data.buildings.map(b=>b.name).join('、') }}</span></div>
      <form class="card" @submit.prevent="submit"><label>巡检楼栋<select v-model="building" :disabled="saving"><option v-for="b in data.buildings" :key="b.code" :value="b.code">{{ b.name }}</option></select></label><label>机器<select v-model="machineId" :disabled="saving"><option value="">请选择机器</option><option v-for="m in machines" :key="m.id" :value="m.id">{{ m.name }}</option></select></label><label>现场情况<select v-model="status" :disabled="saving"><option value="normal">正常</option><option value="issue">发现异常</option></select></label><label>巡检备注<textarea v-model="note" rows="3" maxlength="500" required :disabled="saving" placeholder="描述机器、现场情况和处理建议" /></label><label class="photo-picker">{{ processing?'正在处理照片…':photoData?'更换巡检照片':'拍照或选择照片' }}<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" :disabled="processing||saving" @change="choosePhoto" /></label><img v-if="photoData" :src="photoData" class="preview" alt="本次巡检照片预览" /><van-button type="primary" native-type="submit" block :loading="saving" :disabled="!machineId||!note.trim()||!photoData||processing">提交巡检</van-button></form>
      <div class="history-title"><h2>本楼巡检记录</h2><button @click="load">刷新</button></div><p v-if="!history.length" class="dim">还没有巡检记录。</p><article v-for="item in history" :key="item.id" class="card history"><div><b>{{ item.machineName }}</b><span :class="item.status==='issue'?'issue':'normal'">{{ item.status==='issue'?'异常':'正常' }}</span></div><p>{{ item.note }}</p><small>{{ clock(item.at) }} · {{ item.inspector?.nick || '管理人员' }}</small><p class="delivery">{{ delivery(item.notification) }}</p><button v-if="item.hasPhoto" @click="showPhoto(item)">查看现场照片</button></article>
    </template><van-button v-else-if="!loading" size="small" @click="load">重试</van-button>
  </div></main>
</template>
<script setup>
import { computed,onMounted,onUnmounted,ref,watch } from 'vue'
import { showImagePreview,showToast,showConfirmDialog } from 'vant'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
import { createUserActionConfirmation } from '../taskRegistration'
import '../userActionConfirm.css'
const confirmAction=createUserActionConfirmation(showConfirmDialog)
const dorm=useDormStore(),data=ref(null),building=ref(''),machineId=ref(''),status=ref('normal'),note=ref(''),photoData=ref(''),processing=ref(false),saving=ref(false),loading=ref(false),error=ref('')
const machines=computed(()=>(data.value?.machines||[]).filter(m=>m.dormBuilding===building.value))
const history=computed(()=>(data.value?.inspections||[]).filter(i=>i.dormBuilding===building.value))
let generation=0,disposed=false
watch(building,()=>{machineId.value='';photoData.value='';note.value='';status.value='normal'})
function clock(value){return new Date(value).toLocaleString('zh-CN')}
function delivery(n){return ({not_required:'正常巡检，无需群通知',sending:'正在通知本楼群，巡检已保存',sent:'本楼群通知已送达',failed:'本楼群通知未确认送达，后台已记录',cooldown:'同台异常短时间内已尝试通知，本次不重复发送',unconfigured:'本楼尚未指定通知群，巡检已保存'})[n?.status]||'巡检已保存'}
async function load(){if(loading.value)return;const request=++generation;loading.value=true;error.value='';try{const result=await api('/api/inspections');if(disposed||request!==generation)return;data.value=result;if(!result.buildings.some(b=>b.code===building.value))building.value=result.buildings.find(b=>b.code===dorm.code)?.code||result.buildings[0]?.code||''}catch(e){if(!disposed)error.value=e.message||'巡检记录读取失败'}finally{if(!disposed)loading.value=false}}
async function choosePhoto(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;if(!/^image\/(jpeg|png|webp)$/.test(file.type)||file.size>20*1024*1024){showToast('请选择20MB以内的照片');return}processing.value=true;const scope=building.value;let objectUrl;try{objectUrl=URL.createObjectURL(file);const img=new Image();img.src=objectUrl;await img.decode();const scale=Math.min(1,960/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);let compressed='';for(const quality of [.82,.65,.45,.3]){compressed=canvas.toDataURL('image/jpeg',quality);if(compressed.length<600000)break}if(compressed.length>=600000)throw new Error('照片较复杂，请换一张清晰近照');if(!disposed&&building.value===scope)photoData.value=compressed}catch(e){showToast(e.message||'照片读取失败')}finally{if(objectUrl)URL.revokeObjectURL(objectUrl);processing.value=false}}
async function submit(){
  if(saving.value||!machineId.value||!note.value.trim()||!photoData.value)return
  saving.value=true;error.value=''
  try{
    const outcome=await confirmAction({
      read:()=>({machineId:machineId.value,machineName:machines.value.find(m=>m.id===machineId.value)?.name||'所选机器',building:building.value,buildingName:data.value?.buildings.find(b=>b.code===building.value)?.name||'所选楼栋',status:status.value,note:note.value.trim(),photoData:photoData.value,disposed}),
      describe:s=>({title:'确认提交巡检',message:`${s.buildingName} · ${s.machineName}\n现场情况：${s.status==='issue'?'发现异常':'正常'}\n巡检备注：${s.note}\n照片：已选择1张\n${s.status==='issue'?'异常报告可能通知本楼指定群，请确认现场情况。':'将保存本次现场复核记录。'}`}),
      execute:s=>api('/api/inspections',{method:'POST',body:{machineId:s.machineId,status:s.status,note:s.note,photoData:s.photoData},timeout:20000}),
      onChanged:()=>showToast('机器或巡检内容已变化，请重新确认'),
    })
    if(outcome.status!=='submitted'||disposed)return
    note.value='';photoData.value='';showToast({message:delivery(outcome.value.inspection?.notification),className:'user-action-feedback'});await load()
  }catch(e){error.value=e.message||'上报失败，照片和备注已保留'}finally{saving.value=false}
}
async function showPhoto(item){try{const result=await api('/api/inspections/'+encodeURIComponent(item.id)+'/photo');showImagePreview({images:[result.photoData],closeable:true,showIndex:false})}catch(e){showToast(e.message||'照片读取失败')}}
onMounted(load);onUnmounted(()=>{disposed=true;generation++})
</script>
<style scoped>.inspection-content{max-width:720px;margin:auto;padding:12px 14px 40px}.dim{font-size:12px;color:var(--text-dim);line-height:1.7}.identity{font-size:13px;color:#7dd3fc;margin:14px 0}.identity span{font-size:11px;color:var(--text-dim);margin-left:10px}.inspection form{padding:16px;display:grid;gap:14px}.inspection label{display:grid;gap:7px;font-size:13px}.inspection select,.inspection textarea{width:100%;min-width:0;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font:inherit;color-scheme:dark}.photo-picker{padding:14px;border:1px dashed #507095;border-radius:10px;text-align:center;color:#93c5fd;cursor:pointer}.photo-picker input{width:100%;font-size:11px}.preview{width:100%;max-height:220px;object-fit:contain;border-radius:8px}.history-title{display:flex;justify-content:space-between;align-items:center;margin-top:22px}.history-title h2{font-size:17px}.inspection button:not(.van-button){background:transparent;color:#93c5fd;border:0;padding:7px;font-size:12px}.history{padding:14px;margin:10px 0}.history>div{display:flex;justify-content:space-between;font-size:13px}.history p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.history small,.history .delivery{font-size:11px;color:var(--text-dim)}.issue,.error{color:#fca5a5}.normal{color:#86efac}.error{font-size:12px;overflow-wrap:anywhere}</style>
