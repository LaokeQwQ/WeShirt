<template>
  <div class="page messages" :class="{ 'has-channel': currentChannel }">
    <van-nav-bar :title="currentChannel ? currentChannel.name : '留言板'" :left-text="channelCode ? '频道' : ''" :left-arrow="Boolean(channelCode)" @click-left="openDirectory">
      <template #right><button class="text-button" :disabled="loading || channelsLoading" @click="refresh">刷新</button></template>
    </van-nav-bar>

    <section v-if="!channelCode" class="channel-directory" aria-label="留言频道">
      <h1>选择留言频道</h1>
      <p class="directory-hint">公共频道面向全校，楼栋频道方便邻里交流。</p>
      <button v-for="channel in orderedChannels" :key="channel.code" type="button" class="channel-card card" :data-channel="channel.code" @click="openChannel(channel.code)">
        <span class="channel-icon" aria-hidden="true">{{ channel.code === 'public' ? '聊' : '楼' }}</span>
        <span class="channel-description"><strong>{{ channel.name }}<small v-if="channel.code === ownBuilding">我的住宿楼</small></strong><span>{{ channel.code === 'public' ? '校园交流与公共留言' : '楼内留言、机器交流与预约' }}</span></span>
        <span class="channel-chevron" aria-hidden="true">›</span>
      </button>
      <p v-if="channelsError" class="hint">{{ channelsError }}</p>
      <p class="directory-footnote">浏览其他频道不会更改你的住宿楼绑定。</p>
    </section>

    <template v-else-if="currentChannel">
      <p v-if="isPublic" class="channel-intro">全校公共交流频道。机器留言与预约请进入对应楼栋频道。</p>
      <template v-else>
        <div class="filters"><label>机器<select v-model="machineId"><option value="">全部机器 / 楼内留言</option><option v-for="machine in machines" :key="machine.id" :value="String(machine.id)">{{ machineName(machine) }}</option></select></label></div>
        <QueuePanel v-if="selectedMachine" class="queue-box" :machine="selectedMachine" :dorm="channelCode" />
        <p v-else class="hint">选一台机器可查看预约排位与预计可用时间。</p>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <van-pull-refresh v-model="refreshing" @refresh="refresh">
        <div v-if="loading && !messages.length" class="empty text-dim">加载中…</div>
        <div v-else-if="!messages.length" class="empty text-dim">这个频道还没有留言，来聊两句吧。</div>
        <div class="msg-list">
          <article v-for="message in visibleMessages" :key="message.id" class="msg card" :class="{ pinned: message.pinned }">
            <Avatar :name="message.nick || '同学'" :src="message.avatarUrl" :size="34" />
            <div class="msg-body">
              <div class="msg-head"><b>{{ message.nick || '同学' }}</b><span class="author-building">{{ authorBuildingName(message) }}</span><IdentityBadge :identity="message.identity" /></div>
              <div class="msg-meta"><span v-if="message.pinned" class="pinned-tag">置顶</span><time>{{ format(message.at) }}</time><span v-if="message.machineId" class="machine-tag">{{ message.machineName || '机器留言' }}</span></div>
              <blockquote v-if="message.reply">回复 {{ message.reply.nick || '同学' }}：{{ message.reply.text }}</blockquote><blockquote v-else-if="message.replyTo">原留言已删除</blockquote>
              <p class="msg-text">{{ message.text }}</p>
              <div class="msg-actions">
                <button type="button" @click="replyTo(message)">回复</button>
                <button v-if="message.permissions?.canDelete ?? message.mine" type="button" :disabled="Boolean(moderatingId)" @click="remove(message)">{{ moderatingId === 'delete:' + message.id ? '删除中…' : '删除' }}</button>
                <button v-if="message.permissions?.canPin" type="button" :disabled="Boolean(moderatingId)" @click="togglePin(message)">{{ message.pinned ? '取消置顶' : '置顶' }}</button>
                <button v-if="message.permissions?.canMute && message.authorId" type="button" :disabled="Boolean(moderatingId)" @click="openMute(message)">禁言</button>
              </div>
            </div>
          </article>
          <van-button v-if="hasMore" block :loading="loading" @click="load(true)">加载更早留言</van-button>
        </div>
      </van-pull-refresh>
      <div class="composer-wrap">
        <p v-if="isMuted" class="mute-notice" role="status">{{ muteNotice }}</p>
        <p v-if="sendError" class="send-error" role="alert">{{ sendError }}</p>
        <div v-if="reply" class="reply-target">回复 {{ reply.nick || '同学' }}：{{ reply.text.slice(0, 40) }}<button type="button" @click="reply = null" aria-label="取消回复">×</button></div>
        <div class="composer"><label class="visually-hidden" for="message-composer">留言内容</label><van-field id="message-composer" v-model="text" class="composer-input" placeholder="说点什么…（最多200字）" maxlength="200" type="textarea" autosize rows="1" /><van-button type="primary" size="small" :disabled="!text.trim() || sending || isMuted" :loading="sending" @click="send">发送</van-button></div>
      </div>
    </template>
    <div v-else class="empty text-dim">{{ channelsLoading ? '正在读取频道…' : '这个频道不存在或已关闭。' }}<button v-if="!channelsLoading" type="button" class="text-button" @click="openDirectory">返回频道列表</button></div>

    <van-action-sheet v-model:show="showMute" title="选择禁言时长" :actions="muteActions" cancel-text="取消" :close-on-click-action="false" @select="confirmMute">
      <div class="mute-reason"><van-field v-model="muteReason" label="原因" placeholder="选填，最多200字" maxlength="200" type="textarea" rows="2" /></div>
    </van-action-sheet>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api } from '../api'
import { loadBoard } from '../boardQuery'
import { useDormStore } from '../stores/dorm'
import { useUserStore } from '../stores/user'
import Avatar from '../components/Avatar.vue'
import IdentityBadge from '../components/IdentityBadge.vue'
import QueuePanel from '../components/QueuePanel.vue'

const route = useRoute()
const router = useRouter()
const dorm = useDormStore()
const user = useUserStore()
const channelRows = ref([])
const channelsLoading = ref(false)
const channelsError = ref('')
const currentBuilding = ref(null)
const channelCode = computed(() => typeof route.query.channel === 'string' ? route.query.channel : '')
const channels = computed(() => {
  const rows = channelRows.value.length ? channelRows.value : dorm.buildings || []
  const unique = new Map([['public', { code: 'public', name: '公共频道' }]])
  for (const row of rows) if (row && typeof row.code === 'string' && row.code && row.code !== 'public' && typeof row.name === 'string') unique.set(row.code, { code: row.code, name: row.name })
  return [...unique.values()]
})
const ownBuilding = computed(() => currentBuilding.value || user.user?.dormBuilding || dorm.code || '')
const orderedChannels = computed(() => [...channels.value].sort((a, b) => {
  const rank = (row) => row.code === 'public' ? 0 : row.code === ownBuilding.value ? 1 : 2
  return rank(a) - rank(b)
}))
const currentChannel = computed(() => channels.value.find((row) => row.code === channelCode.value) || null)
const isPublic = computed(() => channelCode.value === 'public')
const machineId = computed({
  get: () => !isPublic.value && typeof route.query.machine === 'string' ? route.query.machine : '',
  set: (value) => router.replace({ path: '/board', query: { ...route.query, machine: value || undefined } }),
})
const machines = ref([])
const selectedMachine = computed(() => machines.value.find((m) => String(m.id) === machineId.value))
const messages = ref([])
const visibleMessages = computed(() => [...messages.value].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))))
const text = ref('')
const reply = ref(null)
const mute = ref(null)
const clock = ref(Date.now())
const isMuted = computed(() => Boolean(mute.value?.active || mute.value?.isMuted) && (!mute.value?.until || Date.parse(mute.value.until) > clock.value))
const muteNotice = computed(() => mute.value?.until ? `你已被禁言至 ${format(mute.value.until)}，草稿可继续编辑。` : '你目前被禁言，草稿可继续编辑。如有疑问请联系管理员。')
const loading = ref(false)
const refreshing = ref(false)
const sending = ref(false)
const moderatingId = ref('')
const error = ref('')
const sendError = ref('')
const page = ref(1)
const hasMore = ref(false)
const showMute = ref(false)
const muteTarget = ref(null)
const muteReason = ref('')
const muteActions = [{ name: '1 小时', minutes: 60 }, { name: '1 天', minutes: 1440 }, { name: '7 天', minutes: 10080 }, { name: '永久禁言', minutes: null, color: '#ef4444' }]
const drafts = new Map()
const scope = computed(() => JSON.stringify([user.user?.id || 'guest', channelCode.value, machineId.value]))
let generation = 0
let machineGeneration = 0
let channelGeneration = 0
let timer = null
let ticker = null
let activeScope = ''
let disposed = false

function format(at) {
  const time = Date.parse(at || '')
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}
function friendlyError(e, fallback) { return String(e?.message || fallback).split(' · ')[0] }
function machineName(machine) {
  const name = String(machine.displayName || machine.machineLabel || machine.name || '').trim()
  return name && name !== String(machine.id) ? name : machine.kind === 'dryer' ? '烘干机' : '洗衣机'
}
function authorBuildingName(message) { return message.authorBuildingName || channels.value.find((row) => row.code === message.authorBuilding)?.name || '未绑定住宿楼' }
function openDirectory() { router.push({ path: '/board' }) }
function openChannel(code) { router.push({ path: '/board', query: { channel: code } }) }

async function loadChannels() {
  const request = ++channelGeneration
  channelsLoading.value = true
  try {
    const result = await api('/api/messages/channels', { auth: 'optional' })
    if (disposed || request !== channelGeneration) return
    if (Array.isArray(result.channels)) channelRows.value = result.channels
    currentBuilding.value = result.currentBuilding || null
    mute.value = result.mute || result.moderation || null
    channelsError.value = ''
  } catch { if (!disposed && request === channelGeneration) channelsError.value = '频道列表暂未更新，已显示住宿楼目录。' }
  finally { if (!disposed && request === channelGeneration) channelsLoading.value = false }
}

async function load(append = false) {
  if (!currentChannel.value || (append && loading.value)) return
  const request = ++generation
  const requestScope = scope.value
  const targetPage = append ? page.value + 1 : 1
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({ channel: channelCode.value, page: String(targetPage), limit: '20' })
    if (machineId.value) query.set('machineId', machineId.value)
    const data = await api('/api/messages?' + query, { auth: 'optional' })
    if (disposed || request !== generation || requestScope !== scope.value) return
    const rows = Array.isArray(data.messages) ? data.messages : []
    messages.value = append ? [...messages.value, ...rows.filter((m) => !messages.value.some((old) => old.id === m.id))] : rows
    page.value = targetPage
    hasMore.value = Boolean(data.pagination?.hasMore)
    mute.value = data.mute || data.moderation || null
  } catch (e) { if (!disposed && request === generation) error.value = friendlyError(e, '留言读取失败，请重试') }
  finally { if (!disposed && request === generation) { loading.value = false; refreshing.value = false } }
}

async function loadMachines() {
  const request = ++machineGeneration
  const code = channelCode.value
  if (!currentChannel.value || code === 'public') { machines.value = []; return }
  try {
    const data = await loadBoard({ dorm: code })
    if (disposed || request !== machineGeneration || code !== channelCode.value) return
    machines.value = (data.board?.floors || []).flatMap((f) => f.machines || [])
    if (machineId.value && !machines.value.some((m) => String(m.id) === machineId.value)) machineId.value = ''
  } catch { /* 留言仍可用，设备查询等待刷新。 */ }
}

async function refresh() {
  if (!channelCode.value) return loadChannels()
  if (!currentChannel.value) { await loadChannels(); if (!currentChannel.value) return }
  await Promise.all([load(false), loadMachines()])
}
function replyTo(message) { reply.value = message; sendError.value = '' }

async function send() {
  const value = text.value.trim()
  if (!value || sending.value || !currentChannel.value || isMuted.value) return
  const requestScope = scope.value
  const requestText = text.value
  const requestChannel = channelCode.value
  const requestReply = reply.value
  sending.value = true
  sendError.value = ''
  try {
    await api('/api/messages', { method: 'POST', body: { text: value, channel: requestChannel, machineId: isPublic.value ? undefined : machineId.value || requestReply?.machineId || undefined, replyTo: requestReply?.id } })
    if (disposed) return
    if (scope.value === requestScope) {
      if (text.value === requestText) text.value = ''
      if (reply.value?.id === requestReply?.id) reply.value = null
      await load(false)
    } else if (drafts.get(requestScope)?.text === requestText) drafts.delete(requestScope)
    showToast('已发送')
  } catch (e) {
    if (!disposed && scope.value === requestScope) { sendError.value = friendlyError(e, '发送失败') + '，草稿已保留。'; showToast(sendError.value); load(false) }
  } finally { if (!disposed) sending.value = false }
}

async function remove(message) {
  if (moderatingId.value) return
  try { await showConfirmDialog({ title: '删除这条留言？', message: message.text }) } catch { return }
  const requestScope = scope.value
  moderatingId.value = 'delete:' + message.id
  try {
    await api('/api/messages/' + encodeURIComponent(message.id), { method: 'DELETE' })
    if (!disposed && requestScope === scope.value) { messages.value = messages.value.filter((m) => m.id !== message.id); if (reply.value?.id === message.id) reply.value = null }
    showToast('已删除')
  } catch (e) { showToast(friendlyError(e, '删除失败')) }
  finally { if (!disposed) moderatingId.value = '' }
}

async function togglePin(message) {
  if (moderatingId.value) return
  const requestScope = scope.value
  moderatingId.value = 'pin:' + message.id
  try {
    await api('/api/messages/' + encodeURIComponent(message.id) + '/pin', { method: 'POST', body: { pinned: !message.pinned } })
    if (!disposed && requestScope === scope.value) await load(false)
    showToast(message.pinned ? '已取消置顶' : '已置顶')
  } catch (e) { showToast(friendlyError(e, '置顶操作失败')) }
  finally { if (!disposed) moderatingId.value = '' }
}

function openMute(message) { muteTarget.value = message; muteReason.value = ''; showMute.value = true }
async function confirmMute(action) {
  const target = muteTarget.value
  if (!target?.authorId || moderatingId.value) return
  try { await showConfirmDialog({ title: `禁言${target.nick || '这位同学'}？`, message: action.minutes === null ? '永久禁言后，需要管理员手动解除。' : `对方将有 ${action.name} 无法发送留言。` }) } catch { return }
  showMute.value = false
  moderatingId.value = 'mute:' + target.id
  try {
    await api('/api/moderation/mutes', { method: 'POST', body: { userId: target.authorId, durationMinutes: action.minutes, reason: muteReason.value.trim() || undefined } })
    showToast('已禁言')
  } catch (e) { showToast(friendlyError(e, '禁言失败')) }
  finally { if (!disposed) moderatingId.value = '' }
}

watch(scope, (next) => {
  if (activeScope) drafts.set(activeScope, { text: text.value, reply: reply.value })
  activeScope = next
  const draft = drafts.get(next)
  text.value = draft?.text || ''
  reply.value = draft?.reply || null
  generation++; machineGeneration++
  messages.value = []; machines.value = []; error.value = ''; sendError.value = ''; hasMore.value = false; page.value = 1
  loading.value = false; refreshing.value = false; showMute.value = false
  refresh()
}, { immediate: true })
watch(() => user.user?.id, () => { currentBuilding.value = null; mute.value = null; loadChannels() })
watch(() => Boolean(currentChannel.value), (available) => { if (available && channelCode.value && !messages.value.length && !loading.value) refresh() })
function onVisible() { if (document.visibilityState === 'visible') { clock.value = Date.now(); refresh() } }
onMounted(() => {
  if (!channelsLoading.value && !channelRows.value.length) loadChannels()
  timer = setInterval(() => { if (document.visibilityState === 'visible' && !loading.value && !sending.value && page.value === 1 && channelCode.value) refresh() }, 45000)
  ticker = setInterval(() => { if (document.visibilityState === 'visible') clock.value = Date.now() }, 30000)
  document.addEventListener('visibilitychange', onVisible)
})
onUnmounted(() => { disposed = true; generation++; machineGeneration++; channelGeneration++; clearInterval(timer); clearInterval(ticker); drafts.clear(); document.removeEventListener('visibilitychange', onVisible) })
</script>

<style scoped>
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.messages{min-height:100vh;padding-bottom:calc(65px + env(safe-area-inset-bottom))}.messages.has-channel{padding-bottom:calc(170px + env(safe-area-inset-bottom))}.text-button,.msg-actions button,.reply-target button{border:0;background:transparent;color:#93c5fd;font-size:12px;padding:7px;cursor:pointer}.text-button:disabled,.msg-actions button:disabled{opacity:.5;cursor:default}.channel-directory{padding:20px 14px}.channel-directory h1{font-size:20px;margin:0 0 8px}.directory-hint,.directory-footnote{font-size:12px;line-height:1.6;color:var(--text-dim)}.directory-hint{margin-bottom:20px}.directory-footnote{text-align:center;margin-top:20px}.channel-card{width:100%;display:flex;gap:12px;align-items:center;padding:16px;margin-bottom:10px;text-align:left;color:var(--text);border:1px solid var(--border);cursor:pointer}.channel-icon{display:grid;place-items:center;width:42px;height:42px;flex:none;border-radius:12px;background:rgba(59,130,246,.13);color:#93c5fd;font-weight:600}.channel-description{display:grid;gap:7px;flex:1;min-width:0}.channel-description strong{font-size:15px;overflow-wrap:anywhere}.channel-description small{display:inline-block;margin-left:7px;font-size:10px;font-weight:400;color:#86efac}.channel-description>span{font-size:12px;color:var(--text-dim)}.channel-chevron{font-size:25px;color:var(--text-dim)}.channel-intro{margin:14px;font-size:12px;line-height:1.6;color:var(--text-dim)}.filters{display:flex;gap:10px;align-items:end;padding:12px}.filters label{display:grid;gap:5px;min-width:0;flex:1;font-size:12px;color:var(--text-dim)}.filters select{min-height:38px;width:100%;padding:5px 10px;color:var(--text);background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color-scheme:dark}.queue-box{margin:0 12px 14px}.hint{padding:0 14px;font-size:12px;color:var(--text-dim)}.error{margin:12px;color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.empty{text-align:center;padding:30px 12px;font-size:13px}.msg-list{display:grid;gap:10px;padding:0 12px}.msg{display:flex;gap:10px;padding:12px}.msg.pinned{border-color:rgba(251,191,36,.3)}.msg-body{min-width:0;flex:1}.msg-head{display:flex;flex-wrap:wrap;gap:5px 7px;align-items:center;font-size:12px}.msg-head b{max-width:100%;overflow-wrap:anywhere}.author-building{font-size:10px;color:var(--text-dim);overflow-wrap:anywhere}.msg-meta{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-top:5px;font-size:10px;color:var(--text-dim)}.machine-tag,.pinned-tag{color:#fbbf24}.pinned-tag{padding:1px 5px;border-radius:4px;background:rgba(245,158,11,.1)}.msg-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.6;margin:7px 0}blockquote{margin:8px 0;padding:6px 10px;border-left:2px solid var(--border);color:var(--text-dim);font-size:11px;overflow-wrap:anywhere}.msg-actions{display:flex;flex-wrap:wrap;gap:14px}.msg-actions button{min-height:32px;padding:4px 0}.composer-wrap{position:fixed;left:0;right:0;bottom:calc(50px + env(safe-area-inset-bottom));z-index:20;border-top:1px solid var(--border);background:var(--bg-elev)}.composer{display:flex;gap:8px;padding:10px 12px;align-items:end}.composer-input{flex:1;padding:0;max-height:130px;overflow-y:auto}.reply-target{display:flex;justify-content:space-between;gap:8px;padding:6px 14px;color:var(--text-dim);font-size:11px;overflow-wrap:anywhere}.reply-target button{padding:0 4px;font-size:18px;flex:none}.mute-notice,.send-error{margin:0;padding:8px 14px;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.mute-notice{color:#fcd34d;background:rgba(245,158,11,.08)}.send-error{color:#fca5a5}.mute-reason{padding:0 12px 12px}.channel-card:focus-visible,.msg-actions button:focus-visible,.text-button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}
</style>
