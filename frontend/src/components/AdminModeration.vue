<template>
  <section class="moderation-admin card" aria-label="留言禁言管理">
    <header><h3>留言禁言管理</h3><button type="button" :disabled="loading || Boolean(releasing)" @click="load">刷新</button></header>
    <p class="intro">这里显示当前生效的禁言。解除后，对方可继续在留言频道发言。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading && !loaded" class="intro">正在读取禁言记录…</p>
    <p v-else-if="loaded && !records.length" class="intro">当前没有生效中的禁言。</p>
    <p v-if="status" class="saved" role="status">{{ status }}</p>
    <ul v-if="records.length" class="mute-list">
      <li v-for="record in records" :key="record.userId">
        <div class="mute-header"><strong>{{ record.nick || '同学' }}</strong><IdentityBadge :identity="record.identity" /><button type="button" :disabled="Boolean(releasing) || loading" @click="release(record)">{{ releasing === record.userId ? '解除中…' : '解除禁言' }}</button></div>
        <p>{{ record.until ? '截止 ' + format(record.until) : '永久禁言' }}</p>
        <p v-if="record.reason" class="reason">原因：{{ record.reason }}</p>
        <small v-if="record.at">设置于 {{ format(record.at) }}</small>
      </li>
    </ul>
    <van-button v-if="!loaded && !loading" size="small" @click="load">重试</van-button>
  </section>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { showConfirmDialog } from 'vant'
import { api, getAdminSession } from '../api'
import IdentityBadge from './IdentityBadge.vue'
const records = ref([])
const loading = ref(false)
const loaded = ref(false)
const releasing = ref('')
const error = ref('')
const status = ref('')
let alive = true
let generation = 0
function headers() { const session = getAdminSession(); return session?.session ? { 'X-Admin-Token': session.session } : {} }
function format(at) { const time = Date.parse(at || ''); return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '待确认' }
function message(error, fallback) { return String(error?.message || fallback).split(' · ')[0] }
async function load() {
  if (loading.value || releasing.value) return
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const data = await api('/api/moderation/mutes', { auth: 'optional', retry: false, headers: headers() })
    if (!alive || request !== generation) return
    records.value = Array.isArray(data.mutes) ? data.mutes.filter((row) => row && typeof row.userId === 'string') : []
    loaded.value = true
  } catch (e) { if (alive && request === generation) error.value = message(e, '禁言记录读取失败') }
  finally { if (alive && request === generation) loading.value = false }
}
async function release(record) {
  if (releasing.value || loading.value) return
  try { await showConfirmDialog({ title: `解除${record.nick || '这位同学'}的禁言？`, message: '解除后，对方可以重新发送留言。' }) } catch { return }
  if (!alive) return
  releasing.value = record.userId
  error.value = ''
  status.value = ''
  try {
    await api('/api/moderation/mutes/' + encodeURIComponent(record.userId), { method: 'DELETE', auth: 'optional', retry: false, headers: headers() })
    if (alive) { records.value = records.value.filter((row) => row.userId !== record.userId); status.value = '已解除禁言' }
  } catch (e) { if (alive) error.value = message(e, '解除禁言失败，请重试') }
  finally { if (alive) releasing.value = '' }
}
onMounted(load)
onUnmounted(() => { alive = false; generation++ })
</script>

<style scoped>
.moderation-admin{padding:16px;margin:12px}.moderation-admin>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.moderation-admin h3{margin:0;font-size:16px}.moderation-admin button:not(.van-button){min-height:34px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:#93c5fd;font-size:12px;padding:6px 10px;cursor:pointer}.moderation-admin button:disabled{opacity:.5;cursor:default}.intro{font-size:12px;line-height:1.7;color:var(--text-dim)}.error{color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.saved{font-size:12px;color:#86efac}.mute-list{list-style:none;margin:0;padding:0}.mute-list li{padding:14px 0;border-top:1px solid var(--border)}.mute-header{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.mute-header strong{font-size:13px;overflow-wrap:anywhere}.mute-header button{margin-left:auto}.mute-list p{font-size:12px;line-height:1.6;color:var(--text-dim);margin:7px 0;overflow-wrap:anywhere}.mute-list .reason{color:var(--text)}.mute-list small{font-size:10px;color:var(--text-dim)}
</style>
