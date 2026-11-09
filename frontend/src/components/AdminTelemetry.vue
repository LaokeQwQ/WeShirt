<template>
  <section class="telemetry card">
    <header><h3>访问与性能</h3><span class="text-dim">匿名聚合 · 保留 {{ data?.retentionDays || 14 }} 天</span></header>
    <div class="filters">
      <label>时间<select v-model.number="days" @change="load"><option :value="1">今天</option><option :value="7">近 7 天</option><option :value="14">近 14 天</option></select></label>
      <label>住宿楼<select v-model="dorm" @change="load"><option value="">全部住宿楼</option><option v-for="b in buildings" :key="b.code" :value="b.code">{{ b.name }}</option></select></label>
      <van-button size="small" :loading="loading" @click="load">刷新</van-button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}<span v-if="data"> · 已保留上次结果</span></p>
    <p v-if="loading && !data" class="text-dim empty">正在读取统计…</p>
    <template v-if="data">
      <div class="metrics">
        <div><b>{{ data.pageViews ?? 0 }}</b><span>页面访问</span></div><div><b>{{ data.errors ?? 0 }}</b><span>错误事件</span></div>
        <div><b>{{ data.api?.count ?? 0 }}</b><span>接口请求</span></div><div><b>{{ data.api?.failed ?? 0 }}</b><span>接口失败</span></div>
      </div>
      <dl class="details">
        <div><dt>接口平均 / P95</dt><dd>{{ ms(data.api?.avgMs) }} / {{ ms(data.api?.p95Ms) }}</dd></div>
        <div><dt>LCP / INP</dt><dd>{{ ms(data.vitals?.lcpMs) }} / {{ ms(data.vitals?.inpMs) }}</dd></div>
        <div><dt>布局偏移 CLS</dt><dd>{{ number(data.vitals?.cls, 3) }}</dd></div>
        <div><dt>3D 平均帧率</dt><dd>{{ number(data.room?.avgFps) }} FPS · {{ data.room?.samples || 0 }} 份样本</dd></div>
        <div><dt>3D 绘制 / 三角形</dt><dd>{{ number(data.room?.avgDrawCalls, 0) }} / {{ number(data.room?.avgTriangles, 0) }}</dd></div>
      </dl>
      <div v-if="qualityEntries.length" class="quality"><span v-for="[key, count] in qualityEntries" :key="key">{{ qualityName(key) }} {{ count }}</span></div>
      <div class="breakdown">
        <div><h4>热门页面</h4><p v-for="r in data.routes || []" :key="r.route"><span>{{ r.route }}</span><b>{{ r.views }}</b></p><p v-if="!data.routes?.length" class="text-dim">暂无访问记录</p></div>
        <div><h4>楼栋样本</h4><p v-for="b in data.buildings || []" :key="b.code"><span>{{ buildingName(b.code) }}</span><b>{{ b.count }}</b></p><p v-if="!data.buildings?.length" class="text-dim">暂无分布记录</p></div>
      </div>
      <details v-if="data.recentErrors?.length"><summary>最近错误（{{ data.recentErrors.length }}）</summary><p v-for="(e, i) in data.recentErrors" :key="i" class="error-row">{{ time(e.at) }} · {{ e.route || '/' }} · {{ e.kind }}<span v-if="e.status"> · HTTP {{ e.status }}</span></p></details>
      <p v-if="!data.received" class="text-dim empty">暂无上报。用户访问后会逐步显示数据。</p>
    </template>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api'
import { DORM_BUILDINGS, dormBuildingName } from '../../../packages/core/buildings.js'
const buildings = DORM_BUILDINGS
const days = ref(7)
const dorm = ref('')
const loading = ref(false)
const error = ref('')
const data = ref(null)
let generation = 0
const qualityEntries = computed(() => Object.entries(data.value?.room?.quality || {}))
function number(value, digits = 1) { return value != null && Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—' }
function ms(value) { return value == null ? '—' : number(value, 0) + ' ms' }
function buildingName(code) { return dormBuildingName(code) || '未选择' }
function qualityName(key) { return ({ low: '流畅', mid: '均衡', high: '精细' })[key] || key }
function time(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
async function load() {
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({ days: String(days.value) })
    if (dorm.value) query.set('dorm', dorm.value)
    const result = await api('/api/admin/telemetry?' + query)
    if (request === generation) data.value = result
  } catch (e) { if (request === generation) error.value = e?.message || '统计读取失败，请重试' }
  finally { if (request === generation) loading.value = false }
}
onMounted(load)
onUnmounted(() => { generation++ })
</script>

<style scoped>
.telemetry { margin:12px; padding:16px; }.telemetry header { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; align-items:center; }.telemetry h3 { margin:0;font-size:16px; }.telemetry header span { font-size:11px; }.filters { display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:16px 0; }.filters label { display:grid;gap:5px;font-size:12px;color:var(--text-dim); }.filters select { min-height:36px;padding:0 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);color-scheme:dark; }.metrics { display:grid;grid-template-columns:repeat(4,1fr);gap:8px; }.metrics div { border-radius:8px;background:var(--bg);padding:12px 4px;text-align:center; }.metrics b { display:block;font-size:22px; }.metrics span { font-size:11px;color:var(--text-dim); }.details { margin:14px 0; }.details div { display:flex;gap:12px;justify-content:space-between;padding:6px 0;font-size:12px; }.details dt { color:var(--text-dim); }.details dd { margin:0;text-align:right; }.breakdown { display:grid;grid-template-columns:1fr 1fr;gap:20px; }.breakdown h4 { font-size:13px;margin:10px 0; }.breakdown p { display:flex;gap:10px;justify-content:space-between;font-size:12px;overflow-wrap:anywhere; }.quality { display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--text-dim); }.error { color:#fca5a5;font-size:12px;overflow-wrap:anywhere; }.empty { font-size:12px; }.error-row { font-size:11px;overflow-wrap:anywhere; }.telemetry summary { cursor:pointer;font-size:12px;margin-top:10px; }@media(max-width:380px){.metrics{grid-template-columns:repeat(2,1fr)}.breakdown{grid-template-columns:1fr}}
</style>
