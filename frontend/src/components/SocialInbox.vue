<template>
  <button v-if="toUserId" type="button" class="contact-button" @click="open">联系 TA</button>
  <van-popup v-model:show="show" position="bottom" round closeable :style="{ maxHeight: '88vh' }" @closed="close">
    <section class="social-inbox">
      <h2>{{ thread ? `与 ${thread.peer?.nick || '同学'} 的联系` : '联系使用者' }}</h2>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="!thread">
        <p class="hint">先发一条固定说明，对方接受后才开启双向聊天。24 小时内仅一条待确认请求。</p>
        <button v-for="item in templates" :key="item.key" class="template" :disabled="busy" @click="request(item.key)">{{ item.label }}</button>
      </template>
      <template v-else>
        <div class="request-text">{{ thread.requestText }}</div>
        <template v-if="thread.state === 'pending'">
          <p class="hint">{{ thread.incoming ? '接受后，对方才能向你发送自由消息。也可以拒绝或屏蔽。' : '请求已发出，等待对方确认。现在还不能自由聊天。' }}</p>
          <div v-if="thread.incoming" class="actions">
            <van-button type="primary" size="small" :loading="busy" @click="respond('accept')">接受并聊天</van-button>
            <van-button size="small" :disabled="busy" @click="respond('reject')">拒绝</van-button>
          </div>
        </template>
        <p v-else-if="thread.state === 'rejected'" class="hint">对方暂时不方便沟通，请以现场核对为准。</p>
        <p v-else-if="thread.state === 'blocked'" class="hint">此会话已屏蔽，不能继续发送消息。</p>
        <template v-if="thread.state === 'accepted'">
          <div ref="messageList" class="messages" aria-live="polite">
            <p v-if="!thread.messages?.length" class="hint">会话已开启，可以核对衣物信息了。请勿发送验证码或支付信息。</p>
            <article v-for="message in thread.messages" :key="message.id" class="message" :class="{ mine: message.sender === 'me' }">
              <span class="message-sender">{{ message.sender === 'me' ? '我' : thread.peer?.nick || '对方' }} · {{ clock(message.at) }}</span>
              <div>{{ message.text }}</div>
            </article>
          </div>
          <form class="composer" @submit.prevent="send">
            <textarea v-model="draft" aria-label="聊天消息" maxlength="500" rows="2" placeholder="输入消息（最多 500 字）" />
            <van-button native-type="submit" type="primary" size="small" :disabled="!draft.trim()" :loading="busy">发送</van-button>
          </form>
        </template>
        <button v-if="thread.state !== 'blocked'" class="block" :disabled="busy" @click="block">屏蔽此人</button>
      </template>
    </section>
  </van-popup>
</template>

<script setup>
import { ref, watch, nextTick, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { api, NEED_LOGIN } from '../api'

const props = defineProps({ toUserId: { type: String, default: '' }, machineId: { type: String, default: '' }, threadId: { type: String, default: '' } })
const emit = defineEmits(['close', 'updated'])
const route = useRoute()
const router = useRouter()
const show = ref(false)
const thread = ref(null)
const error = ref('')
const busy = ref(false)
const draft = ref('')
const messageList = ref(null)
let timer = null
let pending = false
let disposed = false
const templates = [
  { key: 'forgot', label: '衣物还在机器里，提醒来取' },
  { key: 'misplaced', label: '衣物可能放错位置，想核对' },
  { key: 'taken_wrong', label: '衣物可能被误取，想核对' },
  { key: 'left_behind', label: '发现遗留物品，提醒确认' },
]
function clock(value) { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '' }
function failed(e) {
  if (e?.message === NEED_LOGIN) router.push({ path: '/login', query: { to: route.fullPath } })
  else error.value = e?.message || '操作失败，请稍后再试'
}
async function load(id = thread.value?.id || props.threadId) {
  if (!id || pending || disposed) return
  pending = true
  try {
    const data = await api(`/api/social/threads/${encodeURIComponent(id)}`)
    if (disposed || !show.value) return
    thread.value = data.thread
    error.value = ''
  } catch (e) { failed(e) } finally { pending = false }
}
function open() { thread.value = null; error.value = ''; draft.value = ''; show.value = true; if (props.threadId) load(props.threadId) }
function close() { show.value = false; thread.value = null; draft.value = ''; emit('close') }
async function request(template) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const data = await api('/api/social/contact', { method: 'POST', body: { toUserId: props.toUserId, machineId: props.machineId || undefined, template } })
    thread.value = data.thread
    emit('updated')
    if (data.existing) showToast('已打开现有会话')
    else showToast(data.notified ? '请求已发送' : '请求已保存，对方可在站内查看')
  } catch (e) { failed(e) } finally { busy.value = false }
}
async function respond(action) {
  if (busy.value || !thread.value) return
  busy.value = true
  try {
    const data = await api(`/api/social/threads/${thread.value.id}/accept`, { method: 'POST', body: { action } })
    thread.value = data.thread; error.value = ''; emit('updated')
  } catch (e) { failed(e) } finally { busy.value = false }
}
async function send() {
  if (busy.value || !draft.value.trim() || !thread.value) return
  busy.value = true
  try {
    const text = draft.value.trim()
    const data = await api(`/api/social/threads/${thread.value.id}/messages`, { method: 'POST', body: { text } })
    if (draft.value.trim() === text) draft.value = ''
    thread.value.messages = [...(thread.value.messages || []), data.message].slice(-100)
    error.value = ''; emit('updated')
    await nextTick()
    messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
  } catch (e) { failed(e) } finally { busy.value = false }
}
async function block() {
  if (busy.value || !thread.value) return
  try { await showConfirmDialog({ title: '屏蔽此人？', message: '屏蔽后，双方不能再通过协作功能聊天或邀请代取。' }) } catch { return }
  busy.value = true
  try {
    const data = await api(`/api/social/threads/${thread.value.id}/block`, { method: 'POST' })
    thread.value = data.thread; error.value = ''; emit('updated')
  } catch (e) { failed(e) } finally { busy.value = false }
}
watch(() => props.threadId, (value) => { if (value) open() }, { immediate: true })
watch(show, (value) => {
  if (timer) clearInterval(timer)
  timer = value ? setInterval(() => { if (document.visibilityState === 'visible') load() }, 5000) : null
}, { immediate: true })
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer) })
defineExpose({ open })
</script>

<style scoped>
.contact-button,.template { color: var(--text); border: 1px solid var(--border); background: var(--bg-card); border-radius: 10px; padding: 9px 12px; cursor: pointer; }
.social-inbox { padding: 22px 16px max(24px, env(safe-area-inset-bottom)); color: var(--text); }
h2 { margin: 0 30px 16px 0; font-size: 18px; }
.hint { font-size: 13px; color: var(--text-dim); line-height: 1.7; }
.error { color: #f87171; font-size: 13px; overflow-wrap: anywhere; }
.template { display: block; width: 100%; text-align: left; margin: 10px 0; line-height: 1.6; }
.template:disabled { opacity: .6; }
.request-text { padding: 12px; border-radius: 10px; background: rgba(59,130,246,.1); font-size: 14px; line-height: 1.7; }
.actions { display: flex; gap: 10px; }
.messages { max-height: 42vh; overflow-y: auto; padding: 12px 0; display: flex; flex-direction: column; gap: 10px; }
.message { max-width: 88%; align-self: flex-start; background: var(--bg-card); padding: 9px 12px; border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.message.mine { align-self: flex-end; background: rgba(59,130,246,.15); }
.message-sender { display: block; font-size: 11px; color: var(--text-dim); margin-bottom: 5px; }
.composer { display: flex; align-items: end; gap: 8px; }
textarea { min-width: 0; flex: 1; resize: vertical; color: var(--text); background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 9px; font: inherit; }
.block { display: block; margin: 18px 0 0 auto; border: 0; background: transparent; color: #f87171; font-size: 12px; }
</style>
