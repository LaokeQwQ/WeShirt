<template>
  <section class="card calibration">
    <h3>机器时间校准</h3>
    <p>以最新平台时间为准；正数推迟、负数提前，单位为分钟。自动校时会从完整运行周期逐步学习，断网和异常周期不参与。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <label>机器<select v-model="selected" :disabled="busy"><option value="">请选择机器</option><option v-for="machine in machines" :key="machine.id" :value="machine.id">{{ machine.displayName }} · {{ machine.dormBuilding || '未绑定楼栋' }}</option></select></label>
    <template v-if="current">
      <label>手动校准（−120 至 +120）<input v-model.number="offset" type="number" min="-120" max="120" step="1" :disabled="busy || !current.canOperate" /></label>
      <label class="toggle"><input v-model="auto" type="checkbox" :disabled="busy || !current.canOperate" />自动校时</label>
      <p>自动学习 {{ signed(current.learnedOffsetMinutes) }} 分钟 · 有效校准 {{ signed(current.effectiveOffsetMinutes) }} 分钟 · 最近 {{ current.sampleCount }} 个有效周期</p>
      <small v-if="current.lastCalibratedAt">最近校时 {{ new Date(current.lastCalibratedAt).toLocaleString() }}</small>
      <div class="actions"><van-button type="primary" size="small" :loading="busy" :disabled="!current.canOperate" @click="save(false)">保存校时</van-button><van-button size="small" :disabled="busy || !current.canOperate" @click="reset">重置学习记录</van-button></div>
    </template>
    <van-button size="small" :disabled="busy" @click="load">刷新校时数据</van-button>
    <p v-if="hint" role="status">{{ hint }}</p>
  </section>
</template>
<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { showConfirmDialog } from 'vant'
import { api } from '../api'
const machines=ref([]),selected=ref(''),offset=ref(0),auto=ref(false),busy=ref(false),error=ref(''),hint=ref('')
let alive=true
const current=computed(()=>machines.value.find(machine=>machine.id===selected.value))
watch(current,machine=>{offset.value=machine?.offsetMinutes||0;auto.value=machine?.autoEnabled===true})
const signed=n=>Number(n)>0?'+'+n:String(n||0)
async function load(){if(busy.value)return;busy.value=true;error.value='';try{const data=await api('/api/admin/machine-time-calibration',{auth:'optional',retry:false});if(alive)machines.value=data.machines||[]}catch(e){if(alive)error.value=e.message}finally{if(alive)busy.value=false}}
async function save(resetLearning){if(busy.value||!current.value?.canOperate)return;if(!Number.isInteger(offset.value)||Math.abs(offset.value)>120){error.value='请填写 −120 至 +120 的整数分钟';return}const id=selected.value;busy.value=true;error.value='';hint.value='';try{const data=await api('/api/admin/machine-time-calibration/'+encodeURIComponent(id),{method:'PATCH',auth:'optional',retry:false,body:{offsetMinutes:offset.value,autoEnabled:auto.value,resetLearning}});if(!alive)return;machines.value=machines.value.map(row=>row.id===id?{...row,...data.machine}:row);hint.value='已保存，后续状态和通知使用相同校准时间'}catch(e){if(alive)error.value=e.message}finally{if(alive)busy.value=false}}
async function reset(){try{await showConfirmDialog({title:'重置自动校时？',message:'清除这台机器的学习记录，保留手动校准值。'})}catch{return}await save(true)}
onMounted(load);onUnmounted(()=>{alive=false})
</script>
<style scoped>
.calibration{padding:18px;display:flex;flex-direction:column;gap:12px;min-width:0}.calibration h3,.calibration p{margin:0}.calibration p,.calibration small{font-size:13px;line-height:1.6;color:var(--text-dim)}label{display:flex;flex-direction:column;gap:8px;font-size:14px}.toggle{flex-direction:row;align-items:center}select,input[type=number]{width:100%;min-height:44px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px;box-sizing:border-box}.actions{display:flex;flex-wrap:wrap;gap:12px}.calibration .error{color:#fca5a5;overflow-wrap:anywhere}
</style>
