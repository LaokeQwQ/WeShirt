<template>
  <div class="page social">
    <van-nav-bar title="好友协作" left-arrow @click-left="router.back()" />
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="ticket" class="card section invite-preview">
      <h2>{{ preview?.kind === 'share' ? '一起使用等衣' : '好友邀请' }}</h2>
      <p v-if="preview">{{ preview.nick }} {{ preview.kind === 'friend' ? '邀请你添加好友，方便互相代取衣物。' : '向你分享了宿舍洗衣房看板。' }}</p>
      <p v-else class="hint">{{ previewError || '正在确认邀请…' }}</p>
      <van-button v-if="preview && !user.isLoggedIn" type="primary" block @click="login">登录后{{ preview.kind === 'friend' ? '确认添加' : '继续' }}</van-button>
      <van-button v-else-if="preview" type="primary" block :loading="busy" @click="acceptInvite">{{ preview.kind === 'friend' ? '确认添加好友' : '去看板' }}</van-button>
    </section>
    <section v-if="!user.isLoggedIn" class="card section">
      <h2>一起照看洗衣的小事</h2>
      <p class="hint">登录后扫码添加好友、请求代取衣物，或处理衣物联系请求。</p>
      <van-button type="primary" block @click="login">用钉钉登录</van-button>
    </section>
    <template v-else>
      <section class="card section">
        <div class="section-heading"><h2>我的好友</h2><button class="link" @click="makeInvite('friend')">我的二维码</button></div>
        <p v-if="!friends.length" class="hint">还没有好友，分享你的二维码给室友吧。</p>
        <article v-for="friend in friends" :key="friend.id" class="friend">
          <Avatar :name="friend.nick" :src="friend.avatarUrl" :size="36" />
          <span class="friend-name">{{ friend.nick }}<small v-if="friend.blocked"> · 已屏蔽</small></span>
          <SocialInbox v-if="!friend.blocked" :to-user-id="friend.id" @updated="load" />
        </article>
        <QRScanner @result="scanResult" /><div class="invite-actions"><van-button size="small" @click="makeInvite('share')">分享等衣</van-button><van-button size="small" @click="showLinkInput = !showLinkInput">输入邀请链接</van-button></div>
        <form v-if="showLinkInput" class="link-form" @submit.prevent="openLink"><input v-model="inviteLink" placeholder="粘贴好友的邀请链接或扫码内容" aria-label="邀请链接" /><van-button native-type="submit" size="small">打开</van-button></form>
      </section>
      <section class="card section">
        <div class="section-heading"><h2>衣物联系</h2><button class="link" :disabled="loading" @click="load">刷新</button></div>
        <p class="hint">联系使用者时先发固定说明，接受后才开启双向聊天。</p>
        <p v-if="!threads.length" class="empty">暂时没有会话</p>
        <button v-for="thread in threads" :key="thread.id" class="thread-row" @click="activeThread = thread.id">
          <span>{{ thread.peer?.nick || '同学' }} <b v-if="thread.state === 'pending' && thread.incoming" class="badge">待确认</b></span>
          <span class="hint">{{ threadState(thread) }}</span>
          <small>{{ thread.lastMessage || thread.requestText }}</small>
        </button>
      </section>
      <section v-if="route.query.task" class="card section"><h2>请好友代取</h2><p class="hint">选择愿意帮忙的好友，确认后会通过钉钉通知对方。</p><select v-model="pickupFriend" class="friend-select"><option value="">选择好友</option><option v-for="f in friends.filter(x=>!x.blocked)" :key="f.id" :value="f.id">{{f.nick}}</option></select><van-button type="primary" size="small" :disabled="!pickupFriend" :loading="busy" @click="requestPickup">发送代取请求</van-button></section>
      <section class="card section">
        <div class="section-heading"><h2>代取衣物</h2><span class="hint">双方确认，完成后标记已取</span></div>
        <p class="hint">请在「我的洗衣」选择未取任务并邀请好友。不要在机器运行时强行取衣。</p>
        <h3>收到的请求</h3>
        <p v-if="!received.length" class="empty">暂时没有请求</p>
        <article v-for="request in received" :key="request.id" class="pickup">
          <div>{{ request.peer.nick }} 请你代取 <span class="status">{{ pickupState(request) }}</span></div>
          <strong>{{ request.task.machineName || '任务暂不可用' }}</strong>
          <p class="hint">{{ taskTime(request.task) }}</p>
          <div v-if="request.state === 'pending'" class="actions"><van-button type="primary" size="small" :loading="actingId === request.id" @click="respondPickup(request, 'accept')">接受</van-button><van-button size="small" :disabled="!!actingId" @click="respondPickup(request, 'reject')">不方便</van-button></div>
          <van-button v-if="request.state === 'accepted' && !request.task.done && !request.task.unavailable" size="small" type="primary" :loading="actingId === request.id" @click="respondPickup(request, 'complete')">已帮忙取到</van-button>
        </article>
        <h3>发出的请求</h3>
        <p v-if="!sent.length" class="empty">暂时没有发出的请求</p>
        <article v-for="request in sent" :key="request.id" class="pickup"><div>请 {{ request.peer.nick }} 代取 <span class="status">{{ pickupState(request) }}</span></div><strong>{{ request.task.machineName || '任务暂不可用' }}</strong><p class="hint">{{ taskTime(request.task) }}</p></article>
      </section>
    </template>
    <SocialInbox :thread-id="activeThread" @close="activeThread = ''" @updated="load" />
    <van-popup v-model:show="showCode" round closeable class="qr-popup">
      <div class="qr-content"><h2>{{ inviteKind === 'friend' ? '扫码添加好友' : '分享等衣' }}</h2><QRCode v-if="inviteUrl" :value="inviteUrl" :size="224" /><p class="hint">{{ inviteKind === 'friend' ? '对方扫码并确认后互相添加好友。' : '分享看板，不会自动添加好友。' }}<br />链接 24 小时有效。</p><van-button type="primary" size="small" @click="share">分享链接</van-button><p v-if="copyFailed" class="copy-link"><input :value="inviteUrl" readonly @focus="$event.target.select()" aria-label="复制邀请链接" /></p></div>
    </van-popup>
  </div>
</template>

<script setup>
import QRScanner from '../components/QRScanner.vue'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api, NEED_LOGIN } from '../api'
import { useUserStore } from '../stores/user'
import Avatar from '../components/Avatar.vue'
import QRCode from '../components/QRCode.vue'
import SocialInbox from '../components/SocialInbox.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const ticket = computed(() => typeof route.query.ticket === 'string' ? route.query.ticket : '')
const preview = ref(null)
const previewError = ref('')
const friends = ref([])
const threads = ref([])
const received = ref([])
const sent = ref([])
const activeThread = ref('')
const error = ref('')
const loading = ref(false)
const busy = ref(false)
const actingId = ref('')
const showCode = ref(false)
const inviteKind = ref('friend')
const inviteUrl = ref('')
const copyFailed = ref(false)
const showLinkInput = ref(false)
const inviteLink = ref('')
const now = ref(Date.now())
let timer = null
const pickupFriend=ref('')
async function requestPickup(){if(busy.value||!pickupFriend.value)return;busy.value=true;try{await api('/api/social/pickup',{method:'POST',body:{friendId:pickupFriend.value,taskId:String(route.query.task)}});showToast('代取请求已发出');await router.replace('/social');await load()}catch(e){fail(e)}finally{busy.value=false}}
let disposed = false
let pending = null
function login() { router.push({ path: '/login', query: { to: route.fullPath } }) }
function fail(e) { if (e?.message === NEED_LOGIN) login(); else error.value = e?.message || '加载失败，请重试' }
async function load() {
  if (!user.isLoggedIn || disposed) return
  if (pending) return pending
  pending = (async () => {
    loading.value = true
    try {
      const [data, requests] = await Promise.all([api('/api/social'), api('/api/social/pickups')])
      if (disposed) return
      friends.value = data.friends || []; threads.value = data.threads || []
      received.value = requests.received || []; sent.value = requests.sent || []
      now.value = Date.now(); error.value = ''
    } catch (e) { if (!disposed) fail(e) } finally { loading.value = false }
  })()
  try { return await pending } finally { pending = null }
}
async function loadPreview() {
  preview.value = null; previewError.value = ''
  const value = ticket.value
  if (!value) return
  try { const data = await api(`/api/social/invite?ticket=${encodeURIComponent(value)}`, { auth: false }); if (ticket.value === value) preview.value = data }
  catch (e) { previewError.value = e?.message || '邀请已过期，请让对方重新分享' }
}
async function acceptInvite() {
  if (busy.value) return
  if (!user.isLoggedIn) { login(); return }
  if (preview.value?.kind === 'share') { router.push('/'); return }
  busy.value = true
  try {
    const data = await api('/api/social/accept', { method: 'POST', body: { ticket: ticket.value } })
    showToast(data.added ? '已添加好友' : '你们已经是好友了')
    await router.replace({ path: '/social' }); await load()
  } catch (e) { fail(e) } finally { busy.value = false }
}
async function makeInvite(kind) {
  if (busy.value) return
  busy.value = true
  try {
    const data = await api('/api/social/invite', { method: 'POST', body: { kind } })
    inviteKind.value = kind
    inviteUrl.value = `${location.origin}${location.pathname}#/social?ticket=${encodeURIComponent(data.ticket)}`
    copyFailed.value = false; showCode.value = true
  } catch (e) { fail(e) } finally { busy.value = false }
}
async function share() {
  if (navigator.share) { try { await navigator.share({ title: inviteKind.value === 'friend' ? '等衣好友邀请' : '一起使用等衣', url: inviteUrl.value }); return } catch (e) { if (e?.name === 'AbortError') return } }
  try { await navigator.clipboard.writeText(inviteUrl.value); showToast('链接已复制') } catch { copyFailed.value = true; showToast('长按链接即可复制') }
}
function scanResult(value){inviteLink.value=value;openLink()}
function openLink() {
  try {
    const raw = inviteLink.value.trim()
    let value = raw
    if (raw.includes('ticket=')) {
      const match = raw.match(/[?&]ticket=([^&#]+)/)
      if (!match) throw new Error()
      value = decodeURIComponent(match[1])
    }
    if (!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)) throw new Error()
    router.push({ path: '/social', query: { ticket: value } }); inviteLink.value = ''; showLinkInput.value = false
  } catch { showToast('邀请链接格式不正确') }
}
function threadState(thread) { return ({ pending: thread.incoming ? '等待你的确认' : '等待对方确认', accepted: '可聊天', rejected: '已拒绝', blocked: '已屏蔽' })[thread.state] || '' }
function pickupState(request) { return ({ pending: '待确认', accepted: '已接受', rejected: '不方便', completed: '已代取' })[request.state] || request.state }
function taskTime(task) {
  if (task.unavailable) return '任务已删除或暂不可用'
  if (task.done) return '已确认取衣'
  const end = task.endAt ? new Date(task.endAt).getTime() : NaN
  if (!Number.isFinite(end)) return '结束时间待确认，请以现场为准'
  const left = Math.max(0, Math.ceil((end - now.value) / 60000))
  return left > 0 ? `预计还有 ${left} 分钟，请等机器结束后取衣` : '即将完成，请等机器结束后取衣'
}
async function respondPickup(request, action) {
  if (actingId.value) return
  if (action === 'complete') { try { await showConfirmDialog({ title: '确认已取到衣物？', message: `确认已从「${request.task.machineName}」取走衣物后继续。对应任务将标记为已取。`, confirmButtonText: '已取到' }) } catch { return } }
  actingId.value = request.id
  try { await api(`/api/social/pickups/${request.id}/respond`, { method: 'POST', body: { action } }); showToast(action === 'complete' ? '已确认代取，请与好友交接' : action === 'accept' ? '已接受' : '已告知好友'); await load() } catch (e) { fail(e) } finally { actingId.value = '' }
}
function onVisible() { if (document.visibilityState === 'visible') { now.value = Date.now(); load() } }
watch(ticket, loadPreview, { immediate: true })
watch(() => user.isLoggedIn, (value) => { if (value) load() })
onMounted(() => {
  load()
  timer = setInterval(() => { now.value = Date.now(); if (document.visibilityState === 'visible') load() }, 60000)
  document.addEventListener('visibilitychange', onVisible)
})
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) })
</script>

<style scoped>
.social { padding-bottom: 24px; }
.section { margin: 12px; padding: 16px; }
h2 { font-size: 17px; margin: 0 0 12px; } h3 { font-size: 14px; margin: 18px 0 10px; }
.section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.hint { color: var(--text-dim); font-size: 12px; line-height: 1.7; margin: 6px 0 12px; }
.error { color: #f87171; margin: 12px; font-size: 13px; overflow-wrap: anywhere; }
.empty { color: var(--text-dim); font-size: 13px; padding: 10px 0; }
.link { border: 0; background: none; color: #60a5fa; font-size: 12px; padding: 4px 0; cursor: pointer; }
.friend { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.friend-name { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
.friend-name small { color: var(--text-dim); }
.invite-actions,.actions { display: flex; gap: 10px; margin-top: 12px; }
.link-form { display: flex; gap: 8px; margin-top: 12px; }
.link-form input,.copy-link input { min-width: 0; width: 100%; color: var(--text); background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
.thread-row { color: var(--text); background: transparent; border: 0; border-bottom: 1px solid var(--border); padding: 12px 0; width: 100%; display: flex; text-align: left; flex-wrap: wrap; gap: 5px 8px; }
.thread-row small { width: 100%; color: var(--text-dim); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.badge { font-size: 10px; font-weight: 400; color: #fbbf24; background: rgba(245,158,11,.12); border-radius: 4px; padding: 2px 5px; }
.pickup { padding: 12px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.pickup strong { display: block; margin-top: 8px; font-size: 14px; }
.status { float: right; font-size: 12px; color: #93c5fd; }
.qr-popup { width: min(90vw, 360px); }
.qr-content { padding: 28px 20px 24px; text-align: center; }
.copy-link { margin-bottom: 0; }
</style>
