<template>
  <section class="queue-panel" aria-label="排队预约">
    <header><h3>排队预约</h3><button type="button" :disabled="loading" @click="load">刷新</button></header>
    <p v-if="!id" class="dim">先选择一台机器。</p>
    <template v-else>
      <p class="dim">{{ machineState }}<span v-if="machine?.state === 'occupied' && remaining !== null"> · {{ remaining > 0 ? `预计剩余 ${remaining} 分钟` : '即将完成' }}</span></p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div v-if="mine" class="mine"><strong>我的排位 · 第 {{ mine.position }} 位</strong><span>预计 {{ format(mine.startAt) }} 可使用</span><button :disabled="submitting" @click="cancel">{{ submitting ? '处理中…' : '取消预约' }}</button></div>
      <div v-else class="join"><label>预计使用时长<select v-model.number="durationMin" :disabled="submitting"><option v-for="duration in durations" :key="duration" :value="duration">{{ duration }} 分钟</option></select></label><button :disabled="submitting || loading || !!machine?.health?.confirmedFault" @click="join">{{ submitting ? '提交中…' : '加入预约' }}</button></div>
      <ol v-if="queue.length" class="queue-list"><li v-for="entry in queue" :key="entry.id" :class="{ own: entry.mine }"><div><b>{{ entry.position }}. {{ entry.mine ? '我' : entry.nick }}</b><span>{{ entry.durationMin }} 分钟</span></div><p>预计 {{ format(entry.startAt) }} 开始 · 等待约 {{ entry.waitMin }} 分钟</p></li></ol>
      <p v-else class="dim">{{ loading ? '正在查询队列…' : '目前无人排队' }}</p>
      <p class="estimate">预约时间是估计值，实际以现场状态为准。{{ queue.some((q) => q.uncertain) ? '设备结束时间暂不明确，已按完整周期保守估算。' : '' }}</p>
    </template>
  </section>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { showToast } from 'vant'
import { api } from '../api'
import { useUserStore } from '../stores/user'
const props = defineProps({ machine: { type: Object, default: null }, machineId: { type: String, default: '' }, dorm: { type: String, default: '' } })
const emit = defineEmits(['changed'])
const user = useUserStore()
const id = computed(() => String(props.machine?.id || props.machine?.machineId || props.machineId || ''))
const kind = computed(() => props.machine?.kind || (String(props.machine?.name || '').includes('烘干') ? 'dryer' : 'washer'))
const durations = computed(() => kind.value === 'dryer' ? Array.from({ length: 18 }, (_, i) => (i + 1) * 10) : [30, 42, 50, 70])
const durationMin = ref(30)
const queue = ref([])
const error = ref('')
const loading = ref(false)
const submitting = ref(false)
const clock = ref(Date.now())
const mine = computed(() => queue.value.find((q) => q.mine))
const remaining = computed(() => {
  const time = Date.parse(props.machine?.finishAt || '')
  if (Number.isFinite(time)) return Math.max(0, Math.ceil((time - clock.value) / 60000))
  return props.machine?.leftMin ?? null
})
const machineState = computed(() => ({ idle: '当前空闲', occupied: '当前使用中', faulty: '故障已确认，暂不可预约', unknown: '状态待确认' })[props.machine?.state] || '查看当前机器预约')
let generation = 0
let poll = null
let ticker = null
function format(at) { return at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '待确认' }
async function load() {
  if (!id.value) return
  const request = ++generation
  const selected = id.value
  const requestDorm = props.dorm
  const requestUser = user.user?.id
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({ machineId: selected })
    if (props.dorm) query.set('dorm', props.dorm)
    const result = await api('/api/queue?' + query, { auth: 'optional' })
    if (request === generation && selected === id.value && requestDorm === props.dorm && requestUser === user.user?.id) queue.value = result.queue || []
  } catch (e) { if (request === generation) error.value = e?.message || '队列查询失败，请重试' }
  finally { if (request === generation) loading.value = false }
}
async function join() {
  if (submitting.value || !id.value) return
  submitting.value = true
  try {
    await api('/api/queue', { method: 'POST', body: { machineId: id.value, durationMin: durationMin.value, dorm: props.dorm || undefined } })
    showToast('已加入预约，预计时间会随队列更新')
    emit('changed')
    await load()
  } catch (e) { error.value = e?.message || '预约失败'; showToast(error.value) }
  finally { submitting.value = false }
}
async function cancel() {
  if (submitting.value) return
  submitting.value = true
  try {
    await api('/api/queue?machineId=' + encodeURIComponent(id.value), { method: 'DELETE' })
    showToast('预约已取消'); emit('changed'); await load()
  } catch (e) { error.value = e?.message || '取消失败'; showToast(error.value) }
  finally { submitting.value = false }
}
watch(() => [id.value, props.dorm, user.user?.id], () => { generation++; queue.value = []; error.value = ''; load() }, { immediate: true })
watch(kind, () => { durationMin.value = kind.value === 'dryer' ? 60 : 30 }, { immediate: true })
function onVisible() { if (document.visibilityState === 'visible') load() }
onMounted(() => {
  poll = setInterval(() => { if (document.visibilityState === 'visible' && !loading.value && !submitting.value) load() }, 30000)
  ticker = setInterval(() => { clock.value = Date.now() }, 10000)
  document.addEventListener('visibilitychange', onVisible)
})
onUnmounted(() => { generation++; clearInterval(poll); clearInterval(ticker); document.removeEventListener('visibilitychange', onVisible) })
</script>

<style scoped>
.queue-panel{padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h3{margin:0;font-size:16px}button,select{min-height:34px;padding:5px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;cursor:pointer}button:disabled{opacity:.5;cursor:default}select{color-scheme:dark}.dim,.estimate{color:var(--text-dim);font-size:12px;line-height:1.6}.estimate{font-size:11px}.join{display:flex;gap:12px;justify-content:space-between;align-items:end}.join label{display:grid;gap:6px;font-size:12px;color:var(--text-dim)}.join>button{background:#2563eb;border-color:#2563eb;color:white}.mine{padding:12px;border-radius:8px;background:rgba(37,99,235,.1);display:grid;gap:8px;font-size:12px}.mine strong{color:#93c5fd}.mine button{justify-self:start}.queue-list{list-style:none;margin:14px 0;padding:0}.queue-list li{padding:10px 0;border-bottom:1px solid var(--border);font-size:12px}.queue-list li>div{display:flex;justify-content:space-between;gap:12px}.queue-list li p{color:var(--text-dim);margin:5px 0 0}.own b{color:#93c5fd}.error{color:#fca5a5;font-size:12px;overflow-wrap:anywhere}
</style>
