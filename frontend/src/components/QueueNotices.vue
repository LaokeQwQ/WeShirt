<template>
  <div v-if="available && notices.length" class="queue-notices">
    <button class="queue-notice-button" type="button" :aria-label="`预约提醒，${unread} 条未读`" @click="opened = true">
      <van-icon name="bell" /><span>预约提醒</span><b v-if="unread">{{ unread > 9 ? '9+' : unread }}</b>
    </button>
    <van-popup v-model:show="opened" position="bottom" round closeable safe-area-inset-bottom>
      <section class="queue-notice-panel" aria-label="我的预约提醒">
        <h2>预约提醒</h2>
        <p class="queue-notice-hint">只提醒当前队首。到场后请确认机器与上一位的衣物。</p>
        <div class="queue-notice-list">
          <article v-for="notice in notices" :key="notice.id" :class="{ unread: !notice.readAt && notice.active }">
            <div class="queue-notice-heading"><strong>{{ notice.title }}</strong><time>{{ clock(notice.at) }}</time></div>
            <p>{{ notice.text }}</p>
            <div class="queue-notice-actions">
              <span v-if="!notice.active">预约已结束或已取消</span>
              <button v-if="!notice.readAt" type="button" @click="markRead(notice)">标为已读</button>
              <button type="button" @click="viewNotice(notice)">查看预约</button>
            </div>
          </article>
        </div>
      </section>
    </van-popup>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showNotify, showToast } from 'vant'
import { api } from '../api'
import { useUserStore } from '../stores/user'

const user = useUserStore()
const route = useRoute()
const router = useRouter()
const notices = ref([])
const unread = ref(0)
const opened = ref(false)
const available = computed(() => user.ready && user.isLoggedIn && !route.meta.full && !route.path.startsWith('/admin'))
const seen = new Set()
let timer = null
let loading = false
let generation = 0
let lastFetch = 0
let activeUser = ''

function clock(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}
function remember(id, uid) {
  const key = `ws_queue_notice_seen:${uid}`
  if (seen.has(id)) return false
  seen.add(id)
  try { sessionStorage.setItem(key, JSON.stringify([...seen].slice(-150))) } catch { /* 本次打开仍可去重 */ }
  return true
}
function restore(uid) {
  seen.clear()
  try {
    const value = JSON.parse(sessionStorage.getItem(`ws_queue_notice_seen:${uid}`) || '[]')
    if (Array.isArray(value)) for (const id of value.slice(-150)) if (typeof id === 'string') seen.add(id)
  } catch { /* 隐私模式 */ }
}
async function refresh() {
  if (!available.value || document.hidden || loading || Date.now() - lastFetch < 60000) return
  const uid = user.user?.id
  const requestGeneration = generation
  loading = true
  lastFetch = Date.now()
  try {
    const result = await api('/api/queue/notices', { silent: true, timeout: 10000, auth: 'optional' })
    if (generation !== requestGeneration || uid !== user.user?.id || !available.value || document.hidden) return
    notices.value = Array.isArray(result?.notices) ? result.notices.slice(0, 30) : []
    unread.value = notices.value.filter((notice) => !notice.readAt && notice.active).length
    const fresh = notices.value.filter((notice) => !notice.readAt && notice.active && !seen.has(notice.id))
    for (const notice of fresh) remember(notice.id, uid)
    if (fresh.length && user.user?.notifyOn !== false) {
      const latest = fresh[0]
      showNotify({ type: 'primary', duration: 6000, message: `${latest.title} · ${latest.machineName}${fresh.length > 1 ? `（另有 ${fresh.length - 1} 条）` : ''}，点此查看`, onClick: () => { opened.value = true } })
    }
  } catch { /* 网络恢复后再查，不打断主页面 */ }
  finally { if (generation === requestGeneration) loading = false }
}
function schedule() {
  clearInterval(timer)
  timer = null
  if (available.value && !document.hidden) {
    refresh()
    timer = setInterval(refresh, 60000)
  }
}
async function markRead(notice) {
  if (notice.readAt) return true
  const uid = user.user?.id
  try {
    await api(`/api/queue/notices/${encodeURIComponent(notice.id)}/read`, { method: 'POST', silent: true, timeout: 10000, auth: 'optional' })
    if (uid !== user.user?.id) return false
    notice.readAt = new Date().toISOString()
    unread.value = notices.value.filter((entry) => !entry.readAt && entry.active).length
    return true
  } catch { showToast('暂时未能标记，稍后再试'); return false }
}
async function viewNotice(notice) {
  await markRead(notice)
  opened.value = false
  if (available.value) router.push({ path: '/task', query: { machineId: notice.machineId } })
}
watch(() => [available.value, user.user?.id], () => {
  const uid = user.user?.id || ''
  if (uid !== activeUser) {
    activeUser = uid
    generation++
    loading = false
    lastFetch = 0
    notices.value = []
    unread.value = 0
    opened.value = false
    restore(uid)
  }
  if (!available.value) { generation++; loading = false; opened.value = false }
  schedule()
}, { immediate: true })
onMounted(() => document.addEventListener('visibilitychange', schedule))
onBeforeUnmount(() => {
  generation++
  clearInterval(timer)
  document.removeEventListener('visibilitychange', schedule)
})
</script>

<style scoped>
.queue-notices { position:fixed; right:14px; bottom:calc(68px + env(safe-area-inset-bottom)); z-index:45; }
.queue-notice-button { display:flex; align-items:center; gap:7px; padding:10px 13px; border:1px solid rgba(96,165,250,.45); border-radius:999px; background:var(--bg-card,#172033); box-shadow:0 4px 20px #0004; color:var(--text,#e5edf7); font:inherit; font-size:12px; cursor:pointer; }
.queue-notice-button b { display:grid; place-items:center; min-width:18px; height:18px; padding:0 3px; border-radius:12px; background:#2563eb; color:white; font-size:11px; }
.queue-notice-panel { max-height:78vh; padding:24px 16px 16px; background:var(--bg-card,#172033); color:var(--text,#e5edf7); }
.queue-notice-panel h2 { margin:0 30px 8px 0; font-size:19px; }
.queue-notice-hint { margin:0 0 18px; color:var(--text-dim,#a4b2c8); font-size:12px; line-height:1.6; }
.queue-notice-list { max-height:58vh; overflow:auto; }
.queue-notice-list article { margin-bottom:10px; padding:14px; border:1px solid var(--border,#334155); border-radius:12px; }
.queue-notice-list article.unread { border-color:#3b82f6; }
.queue-notice-heading { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.queue-notice-heading strong { font-size:14px; }
.queue-notice-heading time { flex:none; color:var(--text-dim,#a4b2c8); font-size:10px; }
.queue-notice-list article p { white-space:pre-line; margin:10px 0; font-size:12px; line-height:1.8; overflow-wrap:anywhere; }
.queue-notice-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:12px; }
.queue-notice-actions span { margin-right:auto; color:var(--text-dim,#a4b2c8); font-size:11px; }
.queue-notice-actions button { border:0; border-radius:6px; padding:6px 8px; background:#2563eb20; color:#93c5fd; font-size:12px; cursor:pointer; }
</style>
