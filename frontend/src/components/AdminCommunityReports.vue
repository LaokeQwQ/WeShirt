<template>
  <section class="reports card" aria-label="聊天举报管理">
    <div class="report-heading"><h2>聊天举报</h2><button type="button" :disabled="loading" @click="load">刷新</button></div>
    <p class="hint">举报仅管理员可见；原消息删除后仍保留举报时的内容。</p>
    <div class="report-filters"><label>频道<select v-model="channel" @change="reset"><option value="">全部授权频道</option><option value="public">公共频道</option><option v-for="b in buildings" :key="b.code" :value="b.code">{{ b.name }}</option></select></label><label>状态<select v-model="status" @change="reset"><option value="">全部状态</option><option v-for="(label,key) in states" :key="key" :value="key">{{ label }}</option></select></label></div>
    <p v-if="error" class="report-error" role="alert">{{ error }}</p>
    <p v-if="!rows.length" class="hint">{{ loading ? '正在读取举报…' : '暂无符合条件的举报' }}</p>
    <article v-for="row in rows" :key="row.id" class="report-item">
      <div class="report-meta"><strong>{{ reasons[row.reason] || '其他原因' }}</strong><span>{{ channelName(row.channel) }} · {{ format(row.at) }}</span><b>{{ states[row.status] }}</b></div>
      <blockquote><span>{{ row.snapshot.nick || '消息作者' }} · {{ format(row.snapshot.at) }}</span><p>{{ row.snapshot.text || '附件消息' }}</p><small v-if="row.snapshot.media">包含{{ row.snapshot.media.kind === 'video' ? '视频' : '图片' }}，此处不复制附件</small></blockquote>
      <p v-if="row.detail" class="detail">补充：{{ row.detail }}</p>
      <template v-if="row.permissions?.canHandle"><label class="handle-state">处理状态<select v-model="drafts[row.id].status"><option v-for="(label,key) in states" :key="key" :value="key">{{ label }}</option></select></label><textarea v-model="drafts[row.id].resolution" maxlength="300" rows="2" placeholder="处理说明（完成或驳回时必填）" :aria-label="'举报处理说明 '+row.id" /><button type="button" :disabled="Boolean(saving)" @click="save(row)">{{ saving === row.id ? '保存中…' : '保存处理结果' }}</button></template>
      <p v-else-if="row.resolution" class="detail">处理说明：{{ row.resolution }}</p>
    </article>
    <div v-if="total" class="report-pages"><button type="button" :disabled="loading || page <= 1" @click="page--;load()">上一页</button><span>第 {{ page }} 页 · 共 {{ total }} 条</span><button type="button" :disabled="loading || !hasMore" @click="page++;load()">下一页</button></div>
  </section>
</template>
<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
const dorm = useDormStore(), buildings = computed(() => dorm.buildings || [])
const rows=ref([]), drafts=ref({}), channel=ref(''), status=ref('open'), page=ref(1), total=ref(0), hasMore=ref(false), loading=ref(false), saving=ref(''), error=ref('')
const states={open:'待处理',reviewing:'处理中',resolved:'已处理',dismissed:'已驳回'}
const reasons={spam:'广告或垃圾信息',abuse:'辱骂或骚扰',privacy:'泄露个人信息',unsafe:'不当或危险内容',other:'其他原因'}
let generation=0,disposed=false
const channelName=code=>code==='public'?'公共频道':buildings.value.find(row=>row.code===code)?.name || code
const format=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):''
function reset(){page.value=1;load()}
async function load(){
  const request=++generation;loading.value=true;error.value=''
  try{
    const data=await api('/api/admin/community-reports?'+new URLSearchParams({channel:channel.value,status:status.value,page:String(page.value),limit:'20'}),{auth:'optional'})
    if(disposed||request!==generation)return
    rows.value=data.reports||[];total.value=data.pagination?.total||0;hasMore.value=Boolean(data.pagination?.hasMore)
    for(const row of rows.value)if(!drafts.value[row.id])drafts.value[row.id]={status:row.status,resolution:row.resolution||''}
  }catch(e){if(!disposed&&request===generation){rows.value=[];total.value=0;error.value=e.message||'举报读取失败'}}
  finally{if(!disposed&&request===generation)loading.value=false}
}
async function save(row){
  if(saving.value)return
  saving.value=row.id;error.value=''
  const draft={...drafts.value[row.id]}
  try{
    const data=await api('/api/admin/community-reports/'+encodeURIComponent(row.id),{auth:'optional',method:'PATCH',body:draft})
    if(disposed)return
    rows.value=rows.value.map(item=>item.id===row.id?data.report:item)
  }catch(e){if(!disposed)error.value=e.message||'处理结果保存失败'}
  finally{saving.value=''}
}
onMounted(load)
onUnmounted(()=>{disposed=true;generation++})
</script>
<style scoped>
.reports{padding:16px;margin:14px 12px}.report-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.report-heading h2{font-size:16px;margin:0}.hint,.report-meta span,.report-pages{font-size:12px;color:var(--text-dim);line-height:1.6}.report-filters{display:flex;gap:10px;flex-wrap:wrap}.report-filters label{flex:1;min-width:130px;display:grid;gap:6px;font-size:12px}.reports select,.reports textarea{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);color:var(--text);padding:10px;font:inherit}.reports button{border:1px solid var(--border);border-radius:9px;background:var(--bg-elev);color:#93c5fd;padding:10px 14px;cursor:pointer}.reports button:disabled{opacity:.5}.report-item{padding:18px 0;border-bottom:1px solid var(--border);font-size:13px}.report-meta{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.report-meta b{color:#fbbf24;font-size:11px}.report-item blockquote{margin:10px 0;padding:10px 12px;border-left:3px solid var(--border);background:var(--bg-elev);overflow-wrap:anywhere}.report-item blockquote span,.report-item small{font-size:11px;color:var(--text-dim)}.report-item blockquote p,.detail{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.handle-state{display:flex;align-items:center;gap:12px;margin:12px 0}.handle-state select{width:auto}.report-item textarea{margin-bottom:10px;resize:vertical}.report-error{color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.report-pages{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:16px}
</style>
