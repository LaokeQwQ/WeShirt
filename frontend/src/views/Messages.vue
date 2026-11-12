<template>
  <div class="page messages" :class="{ 'has-channel': currentChannel }">
    <van-nav-bar :title="currentChannel ? currentChannel.name : '留言板'" :left-text="channelCode ? '频道' : ''" :left-arrow="Boolean(channelCode)" @click-left="openDirectory">
      <template v-if="currentChannel" #title><button class="channel-title" type="button" :disabled="!currentChannel.permissions?.canManageAvatar" @click="avatarInput?.click()"><ChannelAvatar :code="currentChannel.code" :src="currentChannel.avatarData" />{{ currentChannel.name }}</button></template>
      <template #right><button class="text-button" :disabled="loading || channelsLoading" @click="refresh">刷新</button></template>
    </van-nav-bar>

    <section v-if="!channelCode" class="channel-directory" aria-label="留言频道">
      <h1>选择留言频道</h1>
      <p class="directory-hint">公共频道面向全校，楼栋频道方便邻里交流。</p>
      <p v-if="channelsLoading" class="directory-status" role="status">{{ channelRows.length ? '正在更新频道…' : '正在读取频道与最新消息…' }}</p>
      <button v-for="channel in orderedChannels" :key="channel.code" type="button" class="channel-card card" :data-channel="channel.code" @click="openChannel(channel.code)">
        <ChannelAvatar :code="channel.code" :src="channel.avatarData" />
        <span class="channel-description"><strong>{{ channel.name }}<small v-if="channel.code === ownBuilding">我的住宿楼</small></strong><span class="channel-preview" :class="{ empty: !channel.summary }">{{ channelPreview(channel) }}</span><span v-if="mentionCounts[channel.code]" class="directory-mention">有人@你</span></span>
        <span class="channel-trailing"><time v-if="channel.summary?.at">{{ previewTime(channel.summary.at) }}</time><span v-if="channel.unreadCount > 0" class="channel-unread" :aria-label="`${channel.unreadCount}条未读消息`">{{ channel.unreadCount > 99 ? '99+' : channel.unreadCount }}</span><svg v-else viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg></span>
      </button>
      <p v-if="channelsError" class="directory-error" role="alert">{{ channelsError }}<button type="button" class="text-button" :disabled="channelsLoading" @click="refresh">重试</button></p>
      <p class="directory-footnote">浏览其他频道不会更改你的住宿楼绑定。</p>
    </section>

    <template v-else-if="currentChannel">
      <div class="chat-topline"><span>{{ transportState === 'connected' ? '消息实时更新' : '消息自动更新' }}</span><span>长按头像@，长按消息回复或举报</span></div>
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
        <div ref="messageList" class="msg-list">
          <article v-for="message in visibleMessages" :id="'message-'+message.id" :data-message-id="message.mine ? undefined : message.id" :key="message.id" class="msg card" tabindex="0" aria-label="消息，按回车打开操作" :class="{ pinned: message.pinned, 'mentions-me': message.mentionedMe || route.query.message === message.id }" @pointerdown="startHold($event,message)" @pointerup="cancelHold" @pointercancel="cancelHold" @pointermove="moveHold" @pointerleave="cancelHold" @click.capture="hold.suppressClick($event)" @contextmenu.prevent="messageContext($event,message)" @keydown="messageKey($event,message)">
            <button class="message-avatar" type="button" :aria-label="'长按@'+(message.nick || '这位成员')" :disabled="message.mine || !message.mentionRef" @pointerdown.stop="startAvatarHold($event,message)" @pointerup.stop="cancelHold" @pointercancel.stop="cancelHold" @pointermove.stop="moveHold" @pointerleave="cancelHold" @click.stop.prevent @contextmenu.stop.prevent="mentionAuthor(message)" @keydown.enter.stop.prevent="mentionAuthor(message)" @keydown.space.stop.prevent="mentionAuthor(message)"><Avatar :name="message.nick || '同学'" :src="message.avatarUrl" :size="34" /></button>
            <div class="msg-body">
              <div class="msg-head"><b>{{ message.nick || '同学' }}</b><span class="author-building">{{ authorBuildingName(message) }}</span><IdentityBadge :identity="message.identity" /></div>
              <div class="msg-meta"><span v-if="message.pinned" class="pinned-tag">置顶</span><span v-if="message.type === 'announcement'" class="announcement-tag">频道公告</span><span v-if="message.mentionAll" class="mention-channel-badge">@全体</span><time>{{ format(message.at) }}</time><span v-if="message.machineId" class="machine-tag">{{ message.machineName || '机器留言' }}</span></div>
              <blockquote v-if="message.reply">回复 {{ message.reply.nick || '同学' }}：{{ message.reply.text }}</blockquote><blockquote v-else-if="message.replyTo">原留言已删除</blockquote>
              <p class="msg-text">{{ message.text }}</p>
              <CommunityMedia v-if="message.media" :media="message.media" @preview-visibility="setMediaPreview" />
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
        <div v-if="attachment" class="attachment-draft"><img v-if="attachment.kind==='image'" :src="attachment.preview" alt="待发送图片" /><video v-else :src="attachment.preview" controls playsinline preload="metadata" @webkitbeginfullscreen="draftVideoFullscreen=true" @webkitendfullscreen="draftVideoFullscreen=false" /><span>{{ attachment.kind==='video' ? '短视频 · 最多30秒' : '图片' }}</span><button type="button" @click="clearAttachment">移除</button></div>
        <div v-if="selectedMentions.length || mentionAll" class="mention-draft"><button v-for="item in selectedMentions" :key="item.ref" type="button" @click="removeMention(item)">@{{ item.nick }} ×</button><button v-if="mentionAll" type="button" @click="mentionAll=false">@全体成员 ×</button></div>
        <div v-if="reply" class="reply-target">回复 {{ reply.nick || '同学' }}：{{ reply.text.slice(0, 40) }}<button type="button" @click="reply = null" aria-label="取消回复">×</button></div>
        <div class="composer"><button class="composer-plus" type="button" aria-label="添加附件或提及成员" :disabled="sending || isMuted || preparing" @click="openAdd">＋</button><label class="visually-hidden" for="message-composer">留言内容</label><van-field id="message-composer" v-model="text" class="composer-input" placeholder="消息 / 输入@提及成员" maxlength="200" type="textarea" autosize rows="1" /><van-button type="primary" size="small" :disabled="(!text.trim() && !attachment) || sending || isMuted || preparing" :loading="sending || preparing" @click="send">发送</van-button></div>
        <label v-if="currentChannel.permissions?.canAnnounce" class="announcement-option"><input v-model="announcement" type="checkbox" />发布为置顶频道公告</label>
      </div>
    </template>
    <div v-else class="empty text-dim">{{ channelsLoading ? '正在读取频道…' : channelsError ? '暂时无法确认频道，请重试。' : '这个频道不存在或已关闭。' }}<button v-if="channelsError && !channelsLoading" type="button" class="text-button" @click="refresh">重新读取</button><button v-if="!channelsLoading" type="button" class="text-button" @click="openDirectory">返回频道列表</button></div>

    <van-action-sheet v-model:show="showMute" title="选择禁言时长" :actions="muteActions" cancel-text="取消" :close-on-click-action="false" @select="confirmMute">
      <div class="mute-reason"><van-field v-model="muteReason" label="原因" placeholder="选填，最多200字" maxlength="200" type="textarea" rows="2" /></div>
    </van-action-sheet>
    <van-action-sheet v-model:show="showAdd" title="添加到消息" :actions="[{name:'图片',kind:'image'},{name:'短视频（≤30秒、4MB）',kind:'video'},{name:'提及成员 / @全体',kind:'mention'}]" cancel-text="取消" @select="chooseAttachment" />
    <van-action-sheet v-model:show="showMessageActions" title="消息操作" :actions="messageActions" cancel-text="取消" @select="actOnMessage" />
    <van-popup v-model:show="showReport" position="bottom" round :closeable="!reporting" :close-on-click-overlay="!reporting"><section class="report-form"><h3>举报消息</h3><p>举报仅供管理员处理，不会在频道内公开你的身份。</p><blockquote>{{ reportTarget?.text || '附件消息' }}</blockquote><label>举报原因<select v-model="reportReason"><option value="spam">广告或垃圾信息</option><option value="abuse">辱骂或骚扰</option><option value="privacy">泄露个人信息</option><option value="unsafe">不当或危险内容</option><option value="other">其他原因</option></select></label><van-field v-model="reportDetail" type="textarea" rows="3" maxlength="300" show-word-limit placeholder="补充说明（其他原因必填）" /><p v-if="reportError" class="error" role="alert">{{ reportError }}</p><van-button block type="primary" :loading="reporting" :disabled="reporting" @click="submitReport">提交举报</van-button></section></van-popup>
    <van-popup v-model:show="showMentions" position="bottom" round closeable><section class="mention-picker"><h3>@频道成员</h3><p>可选择此频道近期发言的成员</p><button v-if="currentChannel?.permissions?.canMentionAll" type="button" @click="selectAll">@全体成员<span>每频道每小时一次</span></button><button v-for="item in participants" :key="item.ref" type="button" @click="selectMention(item)">{{ item.nick }}<IdentityBadge :identity="item.identity" /></button><p v-if="!participants.length">{{ participantsLoading ? '正在读取成员…' : '暂无近期发言成员' }}</p></section></van-popup>
    <input ref="imageInput" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" @change="pickAttachment($event,'image')" />
    <input ref="videoInput" class="visually-hidden" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" @change="pickAttachment($event,'video')" />
    <input ref="avatarInput" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" @change="pickAvatar" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api } from '../api'
import { loadBoard } from '../boardQuery'
import { useDormStore } from '../stores/dorm'
import { useUserStore } from '../stores/user'
import Avatar from '../components/Avatar.vue'
import IdentityBadge from '../components/IdentityBadge.vue'
import QueuePanel from '../components/QueuePanel.vue'
import CommunityMedia from '../components/CommunityMedia.vue'
import ChannelAvatar from '../components/ChannelAvatar.vue'
import { prepareCommunityFile, uploadCommunityMedia } from '../communityMedia'
import { createChannelTransport } from '../channelTransport'
import { createMessageHold } from '../messageHold'
import { createChannelReadTracker, visibleChannelMessageIds } from '../channelReadTracker'

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
  const rows = channelRows.value.length ? channelRows.value : (dorm.buildings || []).filter((row) => row.code === (user.user?.dormBuilding || dorm.code))
  const unique = new Map([['public', { code: 'public', name: '公共频道' }]])
  for (const row of rows) if (row && typeof row.code === 'string' && row.code && row.code !== 'public' && typeof row.name === 'string') unique.set(row.code, { ...row, code: row.code, name: row.name })
  const pub = rows.find((row) => row.code === 'public'); if (pub) unique.set('public', pub)
  if (channelRows.value.length && !pub) unique.delete('public')
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
const messageList = ref(null)
const visibleMessages = computed(() => [...messages.value].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))))
const text = ref('')
const reply = ref(null)
const attachment = ref(null), preparing = ref(false), announcement = ref(false)
const selectedMentions = ref([]), mentionAll = ref(false), mentionCounts = ref({}), participants = ref([]), participantsLoading = ref(false)
const showMentions = ref(false), showAdd = ref(false), showMessageActions = ref(false), heldMessage = ref(null)
const mediaPreviews = ref(new Set()), draftVideoFullscreen = ref(false)
const imageInput = ref(null), videoInput = ref(null), avatarInput = ref(null), transportState = ref('polling')
const messageActions = computed(() => [{ name: '回复', action: 'reply' }, ...(!heldMessage.value?.mine ? [{ name: '举报', action: 'report', color: '#ef4444' }] : [])])
const hold = createMessageHold()
const showReport = ref(false), reportTarget = ref(null), reportReason = ref('spam'), reportDetail = ref(''), reportError = ref(''), reporting = ref(false)
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
const ownerKey = computed(() => JSON.stringify([user.user?.id || '', user.token || '']))
const scope = computed(() => JSON.stringify([ownerKey.value, channelCode.value, machineId.value]))
let generation = 0
let machineGeneration = 0
let channelGeneration = 0
let ticker = null
let activeScope = ''
let disposed = false
let readRepairScope = ''
let channelsPending = null
const reader = createChannelReadTracker({
  context:()=>({key:scope.value,owner:user.isLoggedIn?ownerKey.value:'',channel:channelCode.value}),
  visible:()=>document.visibilityState==='visible' && (!document.hasFocus || document.hasFocus()) && !showMute.value && !showReport.value && !showMentions.value && !showAdd.value && !showMessageActions.value && !mediaPreviews.value.size && !draftVideoFullscreen.value && !document.fullscreenElement && !document.webkitFullscreenElement,
  visibleIds:()=>visibleChannelMessageIds(messageList.value,{
    top:document.querySelector('.messages .van-nav-bar')?.getBoundingClientRect().bottom || 0,
    bottom:document.querySelector('.composer-wrap')?.getBoundingClientRect().top || globalThis.innerHeight || 0,
  }),
  send:body=>api('/api/messages/read',{method:'POST',body,silent:true}),
  onRead:()=>{readRepairScope='';loadChannels();loadNoticeCounts()},
  // An article can be deleted between rendering and receipt. Refresh the
  // actual message set before another attempt; do not loop an invalid batch.
  onError:(error,view)=>{if(error.status===404 && readRepairScope!==view.key){readRepairScope=view.key;load(false)}},
})
function setMediaPreview(visible, source) { const next = new Set(mediaPreviews.value); if (visible) next.add(source); else next.delete(source); mediaPreviews.value = next }
function onFullscreenChange() { reader.pause(); nextTick(() => reader.schedule()) }

function format(at) {
  const time = Date.parse(at || '')
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}
function friendlyError(e, fallback) { return String(e?.message || fallback).split(' · ')[0] }
function channelPreview(channel) { const summary=channel.summary;return summary ? `${summary.nick || '同学'}: ${summary.kind === 'image' ? '[图片]' : summary.kind === 'video' ? '[视频]' : summary.text || '新消息'}` : channelsLoading.value && !channelRows.value.length ? '正在读取最新消息…' : '暂无消息，来聊两句吧。' }
function previewTime(at) { const value=Date.parse(at||'');if(!Number.isFinite(value))return '';const date=new Date(value),today=new Date(clock.value);return date.toDateString()===today.toDateString()?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):date.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}) }
function machineName(machine) {
  const name = String(machine.displayName || machine.machineLabel || machine.name || '').trim()
  return name && name !== String(machine.id) ? name : machine.kind === 'dryer' ? '烘干机' : '洗衣机'
}
function authorBuildingName(message) { return message.authorBuildingName || channels.value.find((row) => row.code === message.authorBuilding)?.name || '未绑定住宿楼' }
function openDirectory() { router.push({ path: '/board' }) }
function openChannel(code) { router.push({ path: '/board', query: { channel: code } }) }
async function loadNoticeCounts() { if (!user.isLoggedIn) { mentionCounts.value = {}; return }; const owner = ownerKey.value; try { const data = await api('/api/messages/notices', { silent: true }); if (owner !== ownerKey.value || disposed) return; const counts = {}; for (const entry of data.notices || []) if (!entry.readAt) counts[entry.channel] = (counts[entry.channel] || 0) + 1; mentionCounts.value = counts } catch {} }
function requireLogin() { if (user.isLoggedIn) return true; router.push({ path: '/login', query: { to: route.fullPath } }); return false }
function openAdd() { if (requireLogin()) showAdd.value = true }
function chooseAttachment(action) { showAdd.value = false; if (action.kind === 'mention') { openMentions(); return }; (action.kind === 'video' ? videoInput.value : imageInput.value)?.click() }
function clearAttachment() { if (attachment.value?.preview) URL.revokeObjectURL(attachment.value.preview); attachment.value = null }
async function pickAttachment(event, kind) { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; const target = scope.value; preparing.value = true; try { const blob = await prepareCommunityFile(file); if (target !== scope.value || disposed) return; clearAttachment(); attachment.value = { blob, kind, preview: URL.createObjectURL(blob), media: null } } catch (e) { showToast(e.message) } finally { preparing.value = false } }
async function pickAvatar(event) { const file = event.target.files?.[0]; event.target.value = ''; if (!file || !currentChannel.value?.permissions?.canManageAvatar) return; const channel = channelCode.value; preparing.value = true; try { const blob = await prepareCommunityFile(file, true); await uploadCommunityMedia(blob, channel, true); await loadChannels(); showToast('频道头像已更新') } catch (e) { showToast(e.message) } finally { preparing.value = false } }
function cancelHold() { hold.cancel() }
function startHold(event, message) { if (event.target?.closest('button,a,input,textarea,select,video,[role="button"]')) { cancelHold(); return }; hold.start(event, () => openMessageActions(message)) }
function startAvatarHold(event, message) { hold.start(event, () => mentionAuthor(message)) }
function moveHold(event) { hold.move(event) }
function messageContext(event, message) { if (event.target?.closest('button,a,input,textarea,select,video,[role="button"]')) return; openMessageActions(message) }
function messageKey(event, message) { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openMessageActions(message) } }
function mentionAuthor(message) { if (!message.mine && message.mentionRef && requireLogin() && !isMuted.value) selectMention({ ref: message.mentionRef, nick: message.nick || '同学' }) }
function openMessageActions(message) { cancelHold(); heldMessage.value = message; showMessageActions.value = true }
function actOnMessage(action) { const message = heldMessage.value; showMessageActions.value = false; if (!message) return; if (action.action === 'reply') replyTo(message); else if (requireLogin()) { reportTarget.value = message; reportReason.value = 'spam'; reportDetail.value = ''; reportError.value = ''; showReport.value = true } }
async function submitReport() {
  const target = reportTarget.value, owner = scope.value
  if (!target || reporting.value || !requireLogin()) return
  reporting.value = true; reportError.value = ''
  try {
    const result = await api('/api/messages/' + encodeURIComponent(target.id) + '/report', { method: 'POST', body: { reason: reportReason.value, detail: reportDetail.value.trim() } })
    if (!disposed && owner === scope.value) { showReport.value = false; showToast(result.duplicate ? '你已举报过这条消息' : '举报已提交') }
  } catch (e) { if (!disposed && owner === scope.value) reportError.value = e.message || '提交失败，请重试' }
  finally { reporting.value = false }
}
async function openMentions() { if (!requireLogin() || !currentChannel.value || isMuted.value) return; showMentions.value = true; participantsLoading.value = true; const channel = channelCode.value; try { const data = await api('/api/messages/participants?channel=' + encodeURIComponent(channel)); if (channel === channelCode.value) participants.value = data.participants || [] } catch (e) { showToast(e.message) } finally { participantsLoading.value = false } }
function selectMention(item) { if (!item?.ref) return; if (selectedMentions.value.some((entry) => entry.ref === item.ref)) { showMentions.value = false; return }; if (selectedMentions.value.length >= 5) { showToast('每条最多@五位成员'); return }; selectedMentions.value.push(item); text.value = (text.value.replace(/@$/, '') + '@' + item.nick + ' ').slice(0, 200); showMentions.value = false }
function removeMention(item) { selectedMentions.value = selectedMentions.value.filter((entry) => entry.ref !== item.ref); text.value = text.value.replace('@' + item.nick + ' ', '') }
function selectAll() { mentionAll.value = true; showMentions.value = false }

async function loadChannels() {
  const owner=ownerKey.value
  if(channelsPending?.owner===owner)return channelsPending.job
  const job=performLoadChannels(owner)
  channelsPending={owner,job}
  try{return await job}finally{if(channelsPending?.job===job)channelsPending=null}
}
async function performLoadChannels(owner) {
  const request = ++channelGeneration
  channelsLoading.value = true
  try {
    const result = await api('/api/messages/channels', { auth: 'optional' })
    if (disposed || request !== channelGeneration || owner !== ownerKey.value) return
    if (Array.isArray(result.channels)) channelRows.value = result.channels
    currentBuilding.value = result.currentBuilding || null
    mute.value = result.mute || result.moderation || null
    channelsError.value = ''
  } catch { if (!disposed && request === channelGeneration && owner === ownerKey.value) channelsError.value = '频道列表暂未更新，保留当前目录。' }
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
    if (route.query.message) nextTick(() => document.getElementById('message-' + route.query.message)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    nextTick(() => reader.schedule())
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
  if (!channelCode.value) return Promise.all([loadChannels(), loadNoticeCounts()])
  if (!currentChannel.value) { await loadChannels(); if (!currentChannel.value) return }
  // Message content does not wait for the slower equipment/queue interface.
  if (!isPublic.value && !machines.value.length) loadMachines()
  await load(false)
}
function replyTo(message) { if (!requireLogin()) return; reply.value = message; sendError.value = ''; nextTick(() => document.getElementById('message-composer')?.focus()) }

async function send() {
  const value = text.value.trim()
  if ((!value && !attachment.value) || sending.value || preparing.value || !currentChannel.value || isMuted.value || !requireLogin()) return
  const requestScope = scope.value
  const requestText = text.value
  const requestChannel = channelCode.value
  const requestReply = reply.value
  const requestMachine = machineId.value || requestReply?.machineId || undefined
  const requestAttachment = attachment.value
  const requestMentions = [...selectedMentions.value]
  const requestAll = mentionAll.value
  const requestAnnouncement = announcement.value && currentChannel.value.permissions?.canAnnounce
  sending.value = true
  sendError.value = ''
  try {
    if (requestAttachment && !requestAttachment.media) requestAttachment.media = (await uploadCommunityMedia(requestAttachment.blob, requestChannel)).media
    await api('/api/messages', { method: 'POST', body: { text: value, channel: requestChannel, machineId: requestChannel === 'public' ? undefined : requestMachine, replyTo: requestReply?.id, mediaId: requestAttachment?.media?.id, mentions: requestMentions.map((item) => item.ref), mentionAll: requestAll, type: requestAnnouncement ? 'announcement' : 'message' } })
    if (disposed) return
    if (scope.value === requestScope) {
      if (text.value === requestText) text.value = ''
      if (reply.value?.id === requestReply?.id) reply.value = null
      if (attachment.value === requestAttachment) clearAttachment()
      selectedMentions.value = []; mentionAll.value = false; announcement.value = false
      await load(false)
    } else if (drafts.get(requestScope)?.text === requestText) { drafts.delete(requestScope); if (requestAttachment?.preview) URL.revokeObjectURL(requestAttachment.preview) }
    showToast('已发送')
  } catch (e) {
    if (e.code === 'bad_media' && requestAttachment) requestAttachment.media = null
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
  if (activeScope) drafts.set(activeScope, { text: text.value, reply: reply.value, attachment: attachment.value, mentions: selectedMentions.value, mentionAll: mentionAll.value, announcement: announcement.value })
  activeScope = next
  const draft = drafts.get(next)
  text.value = draft?.text || ''
  reply.value = draft?.reply || null
  attachment.value = draft?.attachment || null; selectedMentions.value = draft?.mentions || []; mentionAll.value = draft?.mentionAll || false; announcement.value = draft?.announcement || false
  cancelHold(); showAdd.value = false; showMentions.value = false; showMessageActions.value = false; showReport.value = false; participants.value = []
  generation++; machineGeneration++
  reader.reset(); mediaPreviews.value = new Set(); draftVideoFullscreen.value = false
  readRepairScope=''
  messages.value = []; machines.value = []; error.value = ''; sendError.value = ''; hasMore.value = false; page.value = 1
  loading.value = false; refreshing.value = false; showMute.value = false
  refresh()
}, { immediate: true })
watch(ownerKey, () => { channelGeneration++; channelRows.value=[]; currentBuilding.value = null; mute.value = null; mentionCounts.value = {}; loadChannels(); loadNoticeCounts() }, {flush:'sync'})
watch(() => Boolean(currentChannel.value), (available) => { if (available && channelCode.value && !messages.value.length && !loading.value) refresh() })
const transport = createChannelTransport({ configure: (channel) => user.isLoggedIn ? api('/api/messages/realtime?channel=' + encodeURIComponent(channel), { silent: true }) : Promise.resolve({ enabled: false }), refresh: () => { if (!loading.value && !sending.value && page.value === 1) refresh() }, onState: (state) => { transportState.value = state } })
watch(() => [channelCode.value, ownerKey.value, Boolean(currentChannel.value)], () => { if (channelCode.value && currentChannel.value) transport.start(channelCode.value); else transport.stop() }, { immediate: true })
watch(text, (value, old) => { if (value.endsWith('@') && value.length > old.length) openMentions() })
watch(()=>[showMute.value,showReport.value,showMentions.value,showAdd.value,showMessageActions.value,mediaPreviews.value.size>0,draftVideoFullscreen.value],values=>{if(values.some(Boolean))reader.pause();else nextTick(()=>reader.schedule())},{flush:'sync'})
function onVisible() { cancelHold(); reader.reset(); clock.value = Date.now(); transport.visibilityChanged(); if (document.visibilityState === 'visible') { if(!channelCode.value)refresh();else reader.schedule() } }
function onScroll() { cancelHold(); reader.schedule() }
onMounted(() => {
  if (!channelsLoading.value && !channelRows.value.length) loadChannels()
  ticker = setInterval(() => { if (document.visibilityState === 'visible') clock.value = Date.now() }, 30000)
  document.addEventListener('visibilitychange', onVisible)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('blur', cancelHold)
  window.addEventListener('focus', onScroll)
  window.addEventListener('resize', onScroll)
})
onUnmounted(() => { disposed = true; reader.dispose(); generation++; machineGeneration++; channelGeneration++; transport.stop(); cancelHold(); clearInterval(ticker); const previews = new Set([attachment.value?.preview, ...[...drafts.values()].map((draft) => draft.attachment?.preview)]); for (const url of previews) if (url) URL.revokeObjectURL(url); drafts.clear(); document.removeEventListener('visibilitychange', onVisible); document.removeEventListener('fullscreenchange', onFullscreenChange); document.removeEventListener('webkitfullscreenchange', onFullscreenChange); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('blur', cancelHold);window.removeEventListener('focus',onScroll);window.removeEventListener('resize',onScroll) })
</script>

<style scoped>
.message-avatar{display:grid;place-items:center;flex:none;width:40px;height:40px;margin:-3px;border:0;padding:0;background:none;border-radius:50%;touch-action:pan-y;color:inherit}.message-avatar:disabled{opacity:1}.message-avatar:focus-visible,.msg:focus-visible{outline:2px solid #93c5fd;outline-offset:3px}.msg{touch-action:pan-y;-webkit-touch-callout:none}.report-form{padding:20px 18px max(26px,env(safe-area-inset-bottom));max-height:80vh;overflow:auto}.report-form h3{margin:0 0 10px}.report-form>p{font-size:12px;color:var(--text-dim);line-height:1.7}.report-form label{display:grid;gap:8px;font-size:13px;margin:16px 0}.report-form select{width:100%;min-height:42px;padding:8px 12px;border:1px solid var(--border);border-radius:12px;color:var(--text);background:var(--bg-card)}.report-form blockquote{max-height:100px;overflow:auto}.report-form .van-button{margin-top:16px;border-radius:20px}
.channel-title{display:flex;align-items:center;gap:8px;border:0;background:none;color:inherit;font-size:16px}.channel-title:disabled{opacity:1}.channel-title img,.small-channel-icon{width:28px;height:28px;border-radius:8px;object-fit:cover}.small-channel-icon{display:grid;place-items:center;background:#1e3a5f;color:#93c5fd;font-size:12px}.chat-topline{display:flex;justify-content:space-between;padding:10px 14px;font-size:11px;color:var(--text-dim)}.mentions-me{border-color:#f59e0b;box-shadow:inset 3px 0 #f59e0b}.mention-channel-badge{display:inline-block;color:#c2410c;background:#ffedd5;border-radius:10px;padding:2px 6px;font-size:10px}.announcement-tag{font-size:10px;color:#c4b5fd;background:#3b2d65;border-radius:5px;padding:2px 5px}.composer-plus,.composer-at{border:0;background:none;color:#93c5fd;font-size:27px;cursor:pointer;padding:6px}.composer-at{font-size:20px}.attachment-draft{display:flex;align-items:center;gap:10px;padding:8px;font-size:12px}.attachment-draft img,.attachment-draft video{max-height:95px;max-width:140px;border-radius:8px}.attachment-draft button{border:0;background:none;color:#fca5a5}.mention-draft{display:flex;gap:7px;padding:5px;flex-wrap:wrap}.mention-draft button{border:0;border-radius:12px;background:#1e3a5f;color:#93c5fd;font-size:11px;padding:4px 8px}.mention-picker{padding:15px 20px 30px;max-height:65vh;overflow:auto}.mention-picker>p{font-size:12px;color:var(--text-dim)}.mention-picker>button{display:flex;align-items:center;justify-content:space-between;width:100%;padding:14px 0;border:0;border-bottom:1px solid var(--border);background:none;color:var(--text);text-align:left}.mention-picker>button span{font-size:11px;color:#f59e0b}.announcement-option{display:flex;align-items:center;gap:6px;font-size:11px;color:#c4b5fd;padding:6px}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.messages{min-height:100vh;padding-bottom:calc(65px + env(safe-area-inset-bottom))}.messages.has-channel{padding-bottom:calc(170px + env(safe-area-inset-bottom))}.text-button,.msg-actions button,.reply-target button{border:0;background:transparent;color:#93c5fd;font-size:12px;padding:7px;cursor:pointer}.text-button:disabled,.msg-actions button:disabled{opacity:.5;cursor:default}.channel-directory{padding:20px 14px}.channel-directory h1{font-size:20px;margin:0 0 8px}.directory-hint,.directory-footnote{font-size:12px;line-height:1.6;color:var(--text-dim)}.directory-hint{margin-bottom:20px}.directory-footnote{text-align:center;margin-top:20px}.channel-card{width:100%;display:flex;gap:12px;align-items:center;padding:16px;margin-bottom:10px;text-align:left;color:var(--text);border:1px solid var(--border);cursor:pointer}.channel-icon{display:grid;place-items:center;width:42px;height:42px;flex:none;border-radius:12px;background:rgba(59,130,246,.13);color:#93c5fd;font-weight:600}.channel-description{display:grid;gap:7px;flex:1;min-width:0}.channel-description strong{font-size:15px;overflow-wrap:anywhere}.channel-description small{display:inline-block;margin-left:7px;font-size:10px;font-weight:400;color:#86efac}.channel-description>span{font-size:12px;color:var(--text-dim)}.channel-chevron{font-size:25px;color:var(--text-dim)}.channel-intro{margin:14px;font-size:12px;line-height:1.6;color:var(--text-dim)}.filters{display:flex;gap:10px;align-items:end;padding:12px}.filters label{display:grid;gap:5px;min-width:0;flex:1;font-size:12px;color:var(--text-dim)}.filters select{min-height:38px;width:100%;padding:5px 10px;color:var(--text);background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color-scheme:dark}.queue-box{margin:0 12px 14px}.hint{padding:0 14px;font-size:12px;color:var(--text-dim)}.error{margin:12px;color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.empty{text-align:center;padding:30px 12px;font-size:13px}.msg-list{display:grid;gap:10px;padding:0 12px}.msg{display:flex;gap:10px;padding:12px}.msg.pinned{border-color:rgba(251,191,36,.3)}.msg-body{min-width:0;flex:1}.msg-head{display:flex;flex-wrap:wrap;gap:5px 7px;align-items:center;font-size:12px}.msg-head b{max-width:100%;overflow-wrap:anywhere}.author-building{font-size:10px;color:var(--text-dim);overflow-wrap:anywhere}.msg-meta{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-top:5px;font-size:10px;color:var(--text-dim)}.machine-tag,.pinned-tag{color:#fbbf24}.pinned-tag{padding:1px 5px;border-radius:4px;background:rgba(245,158,11,.1)}.msg-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.6;margin:7px 0}blockquote{margin:8px 0;padding:6px 10px;border-left:2px solid var(--border);color:var(--text-dim);font-size:11px;overflow-wrap:anywhere}.msg-actions{display:flex;flex-wrap:wrap;gap:14px}.msg-actions button{min-height:32px;padding:4px 0}.composer-wrap{position:fixed;left:0;right:0;bottom:calc(50px + env(safe-area-inset-bottom));z-index:20;border-top:1px solid var(--border);background:var(--bg-elev)}.composer{display:flex;gap:8px;padding:10px 12px;align-items:end}.composer-input{flex:1;padding:0;max-height:130px;overflow-y:auto}.reply-target{display:flex;justify-content:space-between;gap:8px;padding:6px 14px;color:var(--text-dim);font-size:11px;overflow-wrap:anywhere}.reply-target button{padding:0 4px;font-size:18px;flex:none}.mute-notice,.send-error{margin:0;padding:8px 14px;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.mute-notice{color:#fcd34d;background:rgba(245,158,11,.08)}.send-error{color:#fca5a5}.mute-reason{padding:0 12px 12px}.channel-card:focus-visible,.msg-actions button:focus-visible,.text-button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}
</style>
<style scoped>
.directory-status{font-size:12px;color:var(--text-dim);margin:0 0 12px}.directory-error{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--text-dim)}.channel-directory .channel-card{gap:12px;padding:14px;border-radius:18px;min-height:88px}.channel-description strong{display:flex;align-items:center;gap:6px;flex-wrap:wrap;line-height:1.4}.channel-description small{margin-left:0!important;border-radius:5px;background:color-mix(in srgb,#55a88e 12%,transparent);padding:2px 5px}.channel-description .channel-preview{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;line-height:1.6}.channel-preview.empty{padding:0;text-align:left}.channel-description .directory-mention{font-size:11px;color:#e58a38}.channel-trailing{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:9px;flex:none;min-width:28px;align-self:stretch}.channel-trailing time{font-size:10px;color:var(--text-dim);white-space:nowrap}.channel-unread{display:grid;place-items:center;min-width:20px;height:20px;border-radius:11px;background:#347f92;color:white;font-size:11px;padding:0 5px;font-variant-numeric:tabular-nums}.channel-trailing svg{width:17px;height:17px;stroke:var(--text-dim);stroke-width:1.5;fill:none}.channel-title :deep(.channel-avatar){width:28px;height:28px;border-radius:9px}.channel-title :deep(svg){width:19px;height:19px}@media(max-width:350px){.channel-directory{padding-inline:12px}.channel-directory .channel-card{gap:10px;padding:12px}.channel-description strong{font-size:14px}.channel-description>span{font-size:11px}.chat-topline{flex-wrap:wrap;gap:5px}}
.composer{align-items:center;max-width:640px;margin:0 auto;gap:10px}.composer-input{padding:10px 14px;border:1px solid var(--border);border-radius:22px;background:var(--bg-card);min-height:42px;display:flex;align-items:center}.composer-input :deep(.van-field__control){line-height:22px;min-height:22px}.composer-input:after{border:0}.composer>.van-button{height:40px;min-width:58px;border-radius:20px;flex:none}.composer-plus{display:grid;place-items:center;width:36px;height:42px;padding:0;flex:none}.composer-wrap{padding-top:2px}.composer-input :deep(textarea){max-height:110px}
</style>
