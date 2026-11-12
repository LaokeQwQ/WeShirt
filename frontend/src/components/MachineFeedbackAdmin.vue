<template>
  <section class="feedback-admin card" aria-label="机器反馈管理">
    <div class="heading"><h2>机器信息反馈</h2><button :disabled="loading || !!saving" @click="load">刷新</button></div>
    <div class="filters"><label>住宿楼<select v-model="building" :disabled="!!saving" @change="reset"><option value="">全部授权住宿楼</option><option v-for="item in buildings" :key="item.code" :value="item.code">{{ item.name }}</option></select></label><label>处理状态<select v-model="status" :disabled="!!saving" @change="reset"><option value="">全部状态</option><option v-for="(label, value) in states" :key="value" :value="value">{{ label }}</option></select></label></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="loading" class="hint">读取中…</p>
    <article v-for="row in rows" :key="row.id" class="feedback-row">
      <b>{{ row.displayName || row.remarkName || row.originalName || row.machineId }}</b><small v-if="row.originalName && row.originalName !== row.displayName">原名：{{ row.originalName }}</small>
      <p class="hint">{{ buildingName(row.dormBuilding) }} · {{ types[row.type] }} · {{ states[row.status] }} · {{ format(row.at) }}</p><p class="detail">{{ row.detail }}</p>
      <template v-if="row.canHandle"><label>处理状态<select v-model="drafts[row.id].status" :disabled="!!saving"><option v-for="(label, value) in states" :key="value" :value="value">{{ label }}</option></select></label><label>处理说明<textarea v-model="drafts[row.id].resolution" rows="2" maxlength="300" :disabled="!!saving" placeholder="关闭反馈时须填写核实结果" /></label><button :disabled="!!saving" @click="save(row)">{{ saving === row.id ? '保存中…' : '保存处理结果' }}</button></template>
      <p v-else-if="row.resolution" class="detail">处理说明：{{ row.resolution }}</p>
    </article>
    <p v-if="!loading && !rows.length" class="hint">暂无反馈</p><div class="pages"><button :disabled="page <= 1 || loading || !!saving" @click="page--; load()">上一页</button><span>第 {{ page }} 页 · 共 {{ total }} 条</span><button :disabled="!hasMore || loading || !!saving" @click="page++; load()">下一页</button></div>
  </section>
</template>
<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { showConfirmDialog } from 'vant'
import { api, getToken, getAdminSession } from '../api'
import { useDormStore } from '../stores/dorm'
const dorm = useDormStore(), buildings = computed(() => dorm.buildings || [])
const rows = ref([]), drafts = ref({}), building = ref(''), status = ref('open'), page = ref(1), total = ref(0), hasMore = ref(false), loading = ref(false), saving = ref(''), error = ref('')
const states = { open: '待核实', reviewing: '核实中', resolved: '已处理', dismissed: '已关闭' }, types = { name: '名称有误', location: '机位不符', state: '状态不符', other: '其他情况' }
let generation = 0, disposed = false
const buildingName = code => buildings.value.find(row => row.code === code)?.name || code
const format = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : ''
function reset() { page.value = 1; load() }
async function load() {
  const request = ++generation; loading.value = true; error.value = ''
  try {
    const data = await api('/api/admin/machine-feedback?' + new URLSearchParams({ dorm: building.value, status: status.value, page: String(page.value), limit: '20' }), { auth: 'optional' })
    if (disposed || request !== generation) return
    rows.value = data.feedback || []; total.value = data.pagination?.total || 0; hasMore.value = !!data.pagination?.hasMore
    drafts.value = Object.fromEntries(rows.value.map(row => [row.id, { status: row.status, resolution: row.resolution || '' }]))
  } catch (e) { if (!disposed && request === generation) { rows.value = []; error.value = e.message } }
  finally { if (!disposed && request === generation) loading.value = false }
}
async function save(row) {
  if (saving.value || !row.canHandle) return
  const draft = { ...drafts.value[row.id] }
  const principal = getToken() + '|' + (getAdminSession()?.session || '')
  if (['resolved', 'dismissed'].includes(draft.status) && !draft.resolution.trim()) { error.value = '请填写核实和处理说明'; return }
  saving.value = row.id; error.value = ''
  try {
    await showConfirmDialog({ title: '保存机器反馈处理结果', message: `${row.displayName || row.machineId} · ${states[draft.status]}\n${draft.resolution}` })
    if (disposed || principal !== getToken() + '|' + (getAdminSession()?.session || '')) return
    await api('/api/admin/machine-feedback/' + encodeURIComponent(row.id), { auth: 'optional', method: 'PATCH', body: draft })
    if (!disposed) await load()
  } catch (e) { if (!disposed && e instanceof Error) error.value = e.message }
  finally { if (!disposed) saving.value = '' }
}
onMounted(load)
onUnmounted(() => { disposed = true; generation++ })
</script>
<style scoped>
.feedback-admin{padding:16px;margin:16px 12px}.heading,.pages{display:flex;align-items:center;justify-content:space-between;gap:10px}.heading h2{font-size:16px;margin:0}.filters{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}.filters label{flex:1;min-width:130px}.feedback-admin label{display:grid;gap:6px;font-size:12px}.feedback-admin select,.feedback-admin textarea{box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);color:var(--text);font:inherit}.feedback-admin button{padding:10px 13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-elev);color:var(--text);cursor:pointer}.feedback-admin button:disabled{opacity:.45}.feedback-row{display:grid;gap:10px;padding:18px 0;border-bottom:1px solid var(--border)}.feedback-row small,.hint,.pages{font-size:12px;color:var(--text-dim)}.detail{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:0}.hint{line-height:1.6;margin:0}.error{font-size:12px;color:var(--van-danger-color,#dc2626);overflow-wrap:anywhere}.pages{margin-top:16px}
</style>
