<template>
  <section class="operations card">
    <header><h3>运营与通知</h3><button :disabled="loading || saving" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!savedConfig && loading" class="dim">正在读取运营配置…</p>
    <form v-if="savedConfig" @submit.prevent="save">
      <h4>群定点播报</h4>
      <label class="switch"><input v-model="draft.enabled" type="checkbox" :disabled="saving" />启用群播报</label>
      <div class="hours"><label>开始（北京时间）<select v-model.number="draft.startHour"><option v-for="h in 24" :key="h" :value="h - 1">{{ h - 1 }}:00</option></select></label><label>结束（含整点）<select v-model.number="draft.endHour"><option v-for="h in 24" :key="h" :value="h - 1">{{ h - 1 }}:00</option></select></label></div>
      <label class="custom">指定小时（可选）<input v-model="hoursText" inputmode="numeric" placeholder="例如 8,12,18,22" maxlength="80" /><span class="dim">留空按开始至结束每小时检查；填写后以指定小时为准。</span></label>
      <p class="dim">默认每天 8:00–22:00。每个整点后的 10 分钟内最多成功播报一次；机器状态与上次成功播报一致时跳过。剩余分钟变化和待复核故障不会单独触发播报。</p>
      <p v-if="conflict" class="warning">服务器配置有更新。已保留你的草稿，请核对后保存，或重置为服务器配置。</p>
      <p v-if="validationError" class="error">{{ validationError }}</p>
      <div class="actions"><button class="primary" type="submit" :disabled="saving || !dirty || !!validationError">{{ saving ? '保存中…' : '保存设置' }}</button><button type="button" :disabled="saving || !dirty" @click="reset">重置草稿</button><span v-if="dirty" class="dim">有未保存修改</span></div>
    </form>
    <div class="alert-header"><h4>管理员通知 <span class="dim">{{ unresolved }} 条待处理</span></h4><select v-model="filter" aria-label="通知筛选"><option value="open">待处理</option><option value="unread">未读</option><option value="all">全部</option></select></div>
    <p class="dim">保留最近 100 条，重复问题合并计数。通道结果显示实际送达情况。</p>
    <div v-if="!visibleAlerts.length" class="empty dim">{{ loading ? '正在读取通知…' : '当前没有通知' }}</div>
    <article v-for="alert in visibleAlerts" :key="alert.id" class="alert" :class="{ unread: !alert.readAt, resolved: alert.resolvedAt }">
      <div class="alert-title"><strong>{{ alert.title || '运营通知' }}</strong><span class="severity" :class="alert.severity">{{ severityName(alert.severity) }}</span></div>
      <p class="metadata">{{ kindName(alert.kind) }} · {{ time(alert.lastAt || alert.at) }}<span v-if="alert.count > 1"> · 累计 {{ alert.count }} 次</span><span v-if="alert.resolvedAt"> · 已解决</span></p>
      <p class="message">{{ alert.message }}</p>
      <p v-if="Object.keys(alert.channels || {}).length" class="channels"><span v-for="(result, channel) in alert.channels" :key="channel">{{ channelName(channel) }}：{{ result.ok ? '已送达' : '未送达' }}<span v-if="!result.ok && (result.error || result.err)">（{{ result.error || result.err }}）</span></span></p>
      <div class="actions"><button v-if="!alert.readAt" :disabled="!!pending[alert.id]" @click="updateAlert(alert, { read: true })">标为已读</button><button :disabled="!!pending[alert.id]" @click="updateAlert(alert, { resolved: !alert.resolvedAt })">{{ pending[alert.id] ? '处理中…' : alert.resolvedAt ? '重新打开' : '标为已解决' }}</button></div>
    </article>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { showToast } from 'vant'
import { api } from '../api'
const savedConfig = ref(null)
const draft = ref({ enabled: true, startHour: 8, endHour: 22 })
const hoursText = ref('')
const alerts = ref([])
const filter = ref('open')
const loading = ref(false)
const saving = ref(false)
const pending = ref({})
const conflict = ref(false)
const error = ref('')
let generation = 0
let disposed = false
function parsedHours() {
  const text = hoursText.value.trim()
  if (!text) return []
  const parts = text.split(/[,，\s]+/).filter(Boolean)
  if (parts.some((part) => !/^\d{1,2}$/.test(part) || Number(part) > 23)) throw new Error('指定小时请输入 0~23 的整数，用逗号分隔')
  return [...new Set(parts.map(Number))].sort((a, b) => a - b)
}
function payload() { return { broadcast: { ...draft.value, hours: parsedHours() } } }
function signature() { try { return JSON.stringify(payload()) } catch { return 'invalid:' + JSON.stringify(draft.value) + hoursText.value } }
const dirty = computed(() => savedConfig.value && signature() !== JSON.stringify(savedConfig.value))
const validationError = computed(() => {
  try { parsedHours(); if (draft.value.startHour > draft.value.endHour) return '开始时间不能晚于结束时间' } catch (e) { return e.message }
  return ''
})
const unresolved = computed(() => alerts.value.filter((a) => !a.resolvedAt).length)
const visibleAlerts = computed(() => alerts.value.filter((a) => filter.value === 'all' || (filter.value === 'unread' ? !a.readAt : !a.resolvedAt)))
function applyDraft(config) { const value = config.broadcast; draft.value = { enabled: value.enabled, startHour: value.startHour, endHour: value.endHour }; hoursText.value = (value.hours || []).join(',') }
function reset() { if (savedConfig.value) applyDraft(savedConfig.value); conflict.value = false }
async function load() {
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await api('/api/admin/operations')
    if (disposed || request !== generation) return
    const edited = dirty.value
    const changed = savedConfig.value && JSON.stringify(result.config) !== JSON.stringify(savedConfig.value)
    savedConfig.value = result.config
    if (!edited) { applyDraft(result.config); conflict.value = false }
    else if (changed) conflict.value = true
    alerts.value = result.alerts || []
  } catch (e) { if (!disposed && request === generation) error.value = e?.message || '运营信息读取失败，请重试' }
  finally { if (!disposed && request === generation) loading.value = false }
}
async function save() {
  if (saving.value || !dirty.value || validationError.value) return
  const outgoing = payload()
  const sentSignature = signature()
  const request = ++generation
  saving.value = true
  loading.value = false
  error.value = ''
  try {
    const result = await api('/api/admin/operations', { method: 'PATCH', body: outgoing })
    if (disposed || request !== generation) return
    const sameDraft = signature() === sentSignature
    savedConfig.value = result.config
    if (sameDraft) applyDraft(result.config)
    conflict.value = false
    showToast('运营设置已保存')
  } catch (e) { if (!disposed && request === generation) error.value = e?.message || '保存失败，草稿已保留' }
  finally { if (!disposed) saving.value = false }
}
async function updateAlert(alert, patch) {
  if (pending.value[alert.id]) return
  pending.value = { ...pending.value, [alert.id]: true }
  try {
    const result = await api('/api/admin/operations/alerts/' + encodeURIComponent(alert.id), { method: 'PATCH', body: patch })
    if (!disposed) alerts.value = alerts.value.map((row) => row.id === alert.id ? result.alert : row)
  } catch (e) { if (!disposed) { error.value = e?.message || '通知更新失败'; showToast(error.value) } }
  finally { if (!disposed) { const next = { ...pending.value }; delete next[alert.id]; pending.value = next } }
}
function time(at) { return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—' }
function severityName(value) { return ({ info: '提示', warn: '注意', error: '异常' })[value] || value || '提示' }
function kindName(value) { return ({ machine_fault: '设备故障', notification: '通知通道', sync: '同步异常', login: '登录问题' })[value] || value || '系统' }
function channelName(value) { return ({ dm: '管理员私信', group: '群消息', webhook: 'Webhook' })[value] || value }
onMounted(load)
onUnmounted(() => { disposed = true; generation++ })
</script>

<style scoped>
.operations{margin:12px;padding:16px}.operations header,.alert-header,.alert-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.operations h3{margin:0;font-size:16px}.operations h4{font-size:14px;margin:18px 0 10px}.operations h4 span{font-size:11px;font-weight:normal}.dim,.metadata,.channels{font-size:11px;color:var(--text-dim);line-height:1.7}.operations button,.operations select,.custom input{min-height:36px;border:1px solid var(--border);border-radius:8px;padding:6px 10px;background:var(--bg);color:var(--text);font-size:12px}.operations button{cursor:pointer}.operations button:disabled{opacity:.5;cursor:default}.switch{display:flex;gap:8px;align-items:center;font-size:13px}.switch input{width:18px;height:18px;accent-color:#2563eb}.hours{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}.hours label,.custom{display:grid;gap:6px;font-size:12px;color:var(--text-dim)}.hours label{flex:1;min-width:130px}.operations select{color-scheme:dark}.custom input{width:100%;box-sizing:border-box}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.operations .primary{background:#2563eb;border-color:#2563eb;color:white}.error{color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.warning{color:#fbbf24;font-size:12px;line-height:1.7}.alert-header{margin-top:20px;border-top:1px solid var(--border)}.alert-header select{margin-top:10px}.alert{border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:10px}.alert.unread{border-left:3px solid #60a5fa}.alert.resolved{opacity:.75}.alert-title strong{font-size:13px;overflow-wrap:anywhere}.severity{flex:none;font-size:10px;background:rgba(59,130,246,.14);padding:2px 7px;border-radius:4px;color:#93c5fd}.severity.warn{background:rgba(245,158,11,.12);color:#fbbf24}.severity.error{background:rgba(239,68,68,.12);color:#fca5a5}.metadata{margin:6px 0}.message{font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.channels{display:grid;gap:4px;overflow-wrap:anywhere}.empty{padding:14px 0}
</style>
