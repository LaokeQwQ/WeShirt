<template>
  <main class="assistant-page page">
    <van-nav-bar title="洗衣助手">
      <template v-if="userStore.ready && userStore.isLoggedIn" #right>
        <div class="assistant-nav-actions">
          <button type="button" aria-label="查看历史对话" @click="openHistory">
            <van-icon name="clock-o" aria-hidden="true" /><span>历史</span>
          </button>
          <button type="button" aria-label="助手设置" @click="showOptions = true"><van-icon name="setting-o" aria-hidden="true" /></button>
        </div>
      </template>
    </van-nav-bar>
    <section class="assistant-top card assistant-enter">
      <div><h1>今天怎么安排洗衣？</h1><p class="text-dim">{{ buildingName || '尚未绑定住宿楼' }}</p></div>
      <span v-if="status" class="quota">今日剩余 {{ status.usage.dailyRemaining }} / {{ status.usage.dailyLimit }}</span>
    </section>
    <p v-if="error && !showOptions && !showHistory" class="notice error" role="alert">{{ error }}</p>
    <section v-if="loading && !status" class="card notice" role="status">正在连接助手，个人资料会分别载入…</section>
    <section v-else-if="!status" class="card notice"><p>助手暂时无法连接。</p><van-button size="small" @click="load">重新连接</van-button></section>
    <section v-else-if="!status.ready" class="card notice"><b>AI 助手还未开放</b><p>管理员配置完成后即可提问。现在可以直接在看板查看机器。</p><router-link to="/list">查看机器状态 →</router-link></section>
    <section v-else-if="!status.dormBuilding" class="card notice"><b>先选一下住宿楼</b><p>助手会只查询你所绑定住宿楼的机器。</p><router-link to="/settings">前往设置 →</router-link></section>

    <template v-if="userStore.ready && userStore.isLoggedIn">
      <van-popup v-model:show="showOptions" position="bottom" round class="assistant-sheet settings-sheet">
        <section aria-label="助手设置">
          <div class="section-head"><h2>助手设置</h2><button type="button" class="text-button" @click="showOptions = false">关闭</button></div>
          <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <section v-for="resource in pendingResources" :key="resource.key" class="card resource-notice" role="status">正在读取{{ resource.label }}…</section>
      <section v-for="resource in failedResources" :key="resource.key" class="card resource-notice" role="alert"><span>{{ resource.label }}：{{ resources[resource.key].error }}</span><van-button size="small" @click="loadResource(resource.key, true)">重试此项</van-button></section>
      <section class="skills card">
        <div class="section-head"><h2>Skills</h2><button type="button" class="text-button" @click="showSkills = !showSkills">{{ showSkills ? '收起管理' : '管理 / 导入' }}</button></div>
        <p class="text-dim hint">技能已自动启用，会根据问题使用合适的洗衣知识与只读机器查询。这里可管理和分享自己的模板。</p>
        <div v-if="showSkills" class="skill-management">
          <article v-for="skill in skills" :key="skill.id" class="skill-row"><div><b>{{ skill.title }}</b><span class="text-dim">{{ skill.builtin ? '内置' : '自定义' }}</span></div><div class="row-actions"><button type="button" class="text-button" @click="copy(skill.prompt)">复制模板</button><button type="button" class="text-button" :disabled="busySkill" @click="shareSkill(skill)">分享</button><button v-if="!skill.builtin" type="button" class="text-button danger" :disabled="busySkill" @click="deleteSkill(skill)">删除</button></div></article>
          <details><summary>新建 Skill</summary><form class="stack" @submit.prevent="createSkill"><label>名称<input v-model.trim="draft.title" required maxlength="40" placeholder="例如：运动衣洗护" /></label><label>简介<input v-model.trim="draft.description" maxlength="120" /></label><label>提问模板<textarea v-model.trim="draft.prompt" required maxlength="1500" rows="4" placeholder="告诉助手你希望怎样回答。模板只会作为文字参考。" /></label><van-button native-type="submit" size="small" type="primary" :loading="busySkill">保存 Skill</van-button></form></details>
          <details :open="!!importTicket"><summary>导入朋友的 Skill</summary><form class="stack" @submit.prevent="importSkill"><label>分享码或分享链接<textarea v-model.trim="importTicket" rows="3" maxlength="12000" required placeholder="粘贴分享码或完整链接" /></label><p class="hint text-dim">导入后保存为你的独立副本；分享仅包含模板文字。</p><van-button native-type="submit" size="small" :loading="busySkill">确认导入</van-button></form></details>
        </div>
        <div v-if="share" class="share-box"><div class="section-head"><b>{{ share.title }}</b><button type="button" class="text-button" @click="share = null">关闭</button></div><p class="hint text-dim">分享只含 Skill 模板，不包含聊天或个人记忆。7 天内可导入。</p><QRCode :value="share.url" :size="200" /><textarea :value="share.url" readonly rows="3" aria-label="Skill 分享链接" /><van-button size="small" @click="copy(share.url)">复制分享链接</van-button></div>
      </section>

      <section v-if="preferences" class="card personal-prompts">
        <div class="section-head"><h2>回答风格与提示词</h2><span class="hint text-dim">仅保存在你的账号</span></div>
        <form class="stack" @submit.prevent="savePreferences">
          <label>当前模板<select v-model="preferences.activePromptId" :disabled="promptSaving || sending"><option v-for="row in preferences.promptProfiles" :key="row.id" :value="row.id">{{ row.name }}</option></select></label>
          <template v-if="activePrompt"><label>名称<input v-model.trim="activePrompt.name" required maxlength="40" :disabled="promptSaving || sending" /></label><label>提示词<textarea v-model="activePrompt.text" required maxlength="6000" rows="4" :disabled="promptSaving || sending" /></label></template>
          <div class="row-actions"><van-button type="primary" native-type="submit" size="small" :loading="promptSaving" :disabled="sending">保存并使用</van-button><van-button native-type="button" size="small" :disabled="promptSaving || sending || preferences.promptProfiles.length >= 8" @click="addPrompt">新建</van-button><van-button native-type="button" size="small" :disabled="promptSaving || sending || preferences.promptProfiles.length <= 1" @click="removePrompt">删除</van-button><button type="button" class="text-button" :disabled="promptSaving || sending" @click="resetPreferences">恢复平台默认</button></div>
        </form><p class="hint text-dim">修改后点击保存。提示词只调整回答方式；实时状态仍需重新查询，工具始终只读。</p>
      </section>
      <section v-if="memory" class="memory card">
        <div class="section-head"><h2>个人记忆</h2><label class="memory-toggle"><span>{{ memory.enabled ? '已开启' : '已关闭' }}</span><input type="checkbox" :checked="memory.enabled" :disabled="memorySaving || sending" @change="toggleMemory($event.target.checked)" /></label></div>
        <p class="hint text-dim">默认关闭。开启后会将你的备注和近 14 天登记的常用洗衣时段用于回答，仅属于你的账号。</p>
        <p v-if="memory.enabled" class="habit">{{ habitText }}</p>
        <form class="stack" @submit.prevent="saveMemory"><label>我希望助手记住<textarea v-model="memoryNote" maxlength="500" rows="3" placeholder="例如：周二晚上有空；尽量使用冷水。" :disabled="memorySaving || sending" /></label><div class="section-head"><span class="hint text-dim">{{ memoryNote.length }}/500{{ memory.enabled ? '' : ' · 关闭时不会用于回答' }}</span><van-button native-type="submit" size="small" :loading="memorySaving" :disabled="sending">保存备注</van-button></div></form>
        <button type="button" class="text-button danger forget" :disabled="memorySaving || sending" @click="clearMemory">清空并关闭记忆</button>
      </section>
      <details class="mcp card"><summary>连接个人只读 MCP</summary><p class="hint text-dim">支持 JSON-RPC HTTP。使用你的登录 Bearer 凭证访问同源 /api/mcp，可读取当前绑定住宿楼状态；不提供写入或通知工具。不要把个人登录凭证分享给他人。</p><code>{{ mcpUrl }}</code></details>
        </section>
      </van-popup>

      <section class="conversation" aria-label="与洗衣助手对话">
        <p v-if="contextInfo?.compressed" class="hint text-dim" role="status">较早的对话已自动压缩，近期问题保留原文；需要时请补充细节。</p>
        <div ref="messageList" class="messages" aria-live="polite" aria-relevant="additions text" :aria-busy="sending">
          <div v-if="!messages.length && !draftTurn && !partialTurn" class="empty-state assistant-enter">
            <p>可以问我现在有哪些空闲机器，或查看你的洗衣记录。</p>
            <div class="conversation-examples">
              <button type="button" :disabled="!canChat || voiceBusy" @click="input = '我现在登记了哪些洗衣？预计几点完成？'">当前登记</button>
              <button type="button" :disabled="!canChat || voiceBusy" @click="input = '帮我查看近期的历史洗衣记录和洗衣时间。'">历史洗衣</button>
            </div>
          </div>
          <article v-for="(message, index) in messages" :key="message.at + '-' + index" class="message" :class="message.role"><span class="speaker">{{ message.role === 'user' ? '你' : '洗衣助手' }}</span><p>{{ message.content }}</p><button v-if="message.role === 'assistant'" type="button" class="text-button copy-answer" @click="copy(message.content)">复制回答</button></article>
          <template v-if="draftTurn || partialTurn">
            <article class="message user">
              <span class="speaker">你</span>
              <p v-if="(draftTurn || partialTurn).input">{{ (draftTurn || partialTurn).input }}</p>
              <p v-if="(draftTurn || partialTurn).hasPhoto" class="hint">已附一张照片</p>
            </article>
            <article class="message assistant" :class="{ pending: !draftTurn?.text && !partialTurn?.text }"><span class="speaker">洗衣助手<span v-if="partialTurn"> · {{ partialTurn.stopped ? '已停止' : '连接中断' }}，未保存</span><span v-else-if="draftTurn?.text"> · 正在生成</span></span><p>{{ (draftTurn || partialTurn).text || (draftTurn ? '正在查看并整理建议…' : '没有收到完整回答。') }}</p></article>
          </template>
        </div>
        <form class="composer" @submit.prevent="send">
          <p v-if="refusal || suspended" class="safety-notice" role="alert">{{ refusal || '助手暂时停用，恢复时间：' + messageDate(status.blockedUntil) }}</p>
          <p v-if="status?.ready && !status.usage.dailyRemaining" class="composer-notice text-dim">今日额度已用完，明天再来；看板仍可正常查询。</p>
          <div class="composer-field">
            <label class="sr-only" for="assistant-input">向洗衣助手提问</label>
            <input v-if="photoAvailable" ref="cameraInput" type="file" hidden accept="image/*" capture="environment" @change="choosePhoto" />
            <input v-if="photoAvailable" ref="photoInput" type="file" hidden accept="image/*" @change="choosePhoto" />
            <aside v-if="attachment" class="photo-preview">
              <img :src="attachment" alt="待发送照片预览" />
              <span class="hint text-dim">发送时，照片会传给当前模型识别。</span>
              <button type="button" class="text-button" :disabled="sending" @click="removePhoto">移除照片</button>
            </aside>
            <textarea id="assistant-input" v-model="input" rows="1" maxlength="1000" :disabled="!canChat || sending" placeholder="问问洗衣助手…" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" />
            <p v-if="photoError" class="composer-notice error" role="alert">{{ photoError }}</p>
            <p v-else-if="preparingPhoto" class="composer-notice text-dim" role="status">正在处理照片…</p>
            <p v-if="recording || transcribing" class="composer-notice text-dim" role="status">{{ recording ? '正在录音，最多 30 秒。' : '正在识别语音…' }}{{ voiceDescription }}</p>
            <p v-else-if="voiceError" class="composer-notice error" role="alert">{{ voiceError }}</p>
            <div class="composer-tools">
              <button v-if="photoAvailable" class="composer-icon" type="button" aria-label="添加图片" title="添加图片" aria-haspopup="dialog" :disabled="!canChat || sending || preparingPhoto" @click="showAttachments = true">
                <van-icon name="plus" aria-hidden="true" />
              </button>
              <button v-if="voiceAvailable" class="composer-icon" type="button" :aria-label="recording ? '结束录音' : '语音输入'" :title="recording ? '结束录音' : '语音输入'" :disabled="!canChat || sending || transcribing" :aria-pressed="recording" @click="toggleVoice">
                <van-icon name="audio" aria-hidden="true" />
              </button>
              <button v-if="status?.deepThinkingAvailable" class="thinking-toggle" type="button" :aria-pressed="deepThink" :disabled="!canChat || sending" @click="deepThink = !deepThink">深度思考</button>
              <button v-if="sending" class="composer-send" type="button" aria-label="停止生成" title="停止生成" @click="stopAnswer"><span aria-hidden="true" class="stop-symbol"></span></button>
              <button v-else class="composer-send" type="submit" aria-label="发送" title="发送" :disabled="!canSend"><van-icon name="arrow-up" aria-hidden="true" /></button>
            </div>
          </div>
        </form>
      </section>

      <van-popup v-model:show="showAttachments" position="bottom" round class="assistant-sheet">
        <section role="dialog" aria-label="添加图片" class="attachment-options">
          <div class="section-head"><h2>添加图片</h2><button type="button" class="text-button" @click="showAttachments = false">取消</button></div>
          <button type="button" @click="pickAttachment(cameraInput)"><van-icon name="photograph" aria-hidden="true" />拍照</button>
          <button type="button" @click="pickAttachment(photoInput)"><van-icon name="photo-o" aria-hidden="true" />从相册选择</button>
        </section>
      </van-popup>

      <van-popup v-model:show="showHistory" position="bottom" round class="assistant-sheet history-sheet">
        <section aria-label="历史对话">
          <div class="section-head"><h2>历史对话</h2><button type="button" class="text-button" @click="showHistory = false">关闭</button></div>
          <p v-if="error" class="notice error" role="alert">{{ error }}</p>
          <p class="hint text-dim">保留最近 14 天的聊天，最多 256 条。</p>
          <p v-if="resources.history.loading" role="status">正在读取历史对话…</p>
          <p v-else-if="resources.history.error" role="alert">{{ resources.history.error }} <button type="button" class="text-button" @click="loadResource('history', true)">重试</button></p>
          <p v-else-if="!savedMessages.length" class="hint text-dim">暂无历史对话。</p>
          <div v-else class="messages">
            <article v-for="(message, index) in savedMessages" :key="message.at + '-' + index" class="message" :class="message.role">
              <span class="speaker">{{ message.role === 'user' ? '你' : '洗衣助手' }} · {{ messageDate(message.at) }}</span>
              <p>{{ message.content }}</p>
            </article>
          </div>
          <button v-if="savedMessages.length" type="button" class="text-button danger" :disabled="sending || clearing" @click="clearHistory">清空历史对话</button>
        </section>
      </van-popup>

    </template>
  </main>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api, BASE, streamAssistantChat, transcribeAssistantAudio } from '../api'
import QRCode from '../components/QRCode.vue'
import { dormBuildingName } from '../../../packages/core/buildings.js'
import { useUserStore } from '../stores/user'
import { assistantData } from '../assistantData'
import { ASSISTANT_WARMUP_RESOURCES } from '../assistantResourceCache'
import { createAssistantMic, createAssistantSpeech } from '../assistantSpeech'
import { prepareAssistantPhoto } from '../assistantPhoto'
import assistantRecordingWorkletUrl from '../assistantRecordingWorklet.js?url&no-inline'
const route = useRoute(), router = useRouter()
const userStore = useUserStore(), resources = assistantData.state
const resourceLabels = [{key:'skills',label:'Skills'},{key:'memory',label:'个人记忆'},{key:'preferences',label:'回答风格'}]
const pendingResources = computed(() => resourceLabels.filter(row => resources[row.key].loading && !resources[row.key].data))
const failedResources = computed(() => resourceLabels.filter(row => resources[row.key].error))
const status = ref(null), messages = ref([]), skills = ref([]), memory = ref(null), memoryNote = ref(''), input = ref(''), error = ref('')
const deepThink = ref(false), refusal = ref('')
const loading = ref(false), sending = ref(false), clearing = ref(false), memorySaving = ref(false), busySkill = ref(false), showSkills = ref(false), importTicket = ref(''), share = ref(null), messageList = ref(null)
const preferences=ref(null),promptSaving=ref(false),contextInfo=ref(null)
const draftTurn = ref(null), partialTurn = ref(null)
const showHistory = ref(false), showOptions = ref(false), showAttachments = ref(false)
const recording = ref(false), transcribing = ref(false), voiceError = ref('')
const cameraInput = ref(null), photoInput = ref(null), attachment = ref(''), photoError = ref(''), preparingPhoto = ref(false)
const savedMessages = computed(() => resources.history.data?.messages || [])
const activePrompt=computed(()=>preferences.value?.promptProfiles.find(row=>row.id===preferences.value.activePromptId))
const draft = reactive({ title: '', description: '', prompt: '' })
let alive = true
let activeRequest = null
let voiceRequest = null
let activeMic = null
let photoRevision = 0
let conversationId = crypto.randomUUID()
const sessionIdentity = {id:userStore.user?.id,token:userStore.token}
function currentSession(){return alive && userStore.ready && userStore.isLoggedIn && sessionIdentity.id===userStore.user?.id && sessionIdentity.token===userStore.token}
watch(() => [userStore.ready,userStore.user?.id,userStore.token], () => {
  if (currentSession()) return
  activeRequest?.abort(); activeRequest = null
  stopVoice()
  removePhoto()
  showHistory.value = false
  showOptions.value = false
  showAttachments.value = false
  sending.value = false; draftTurn.value = null; partialTurn.value = null
  status.value=null;messages.value=[];skills.value=[];memory.value=null;memoryNote.value='';preferences.value=null;input.value='';share.value=null;contextInfo.value=null;error.value=''
  Object.assign(draft,{title:'',description:'',prompt:''})
}, {flush:'sync'})
const buildingName = computed(() => status.value?.buildingName || dormBuildingName(status.value?.dormBuilding))
const suspended = computed(() => Date.parse(status.value?.blockedUntil || '') > Date.now())
const canChat = computed(() => !!(userStore.ready && userStore.isLoggedIn && status.value?.ready && status.value?.dormBuilding && status.value?.usage.dailyRemaining > 0 && !suspended.value))
const voiceBusy = computed(() => recording.value || transcribing.value)
const photoAvailable = computed(() => status.value?.ready === true && status.value.imageInputReady !== false)
const canSend = computed(() => canChat.value && !voiceBusy.value && !preparingPhoto.value && !sending.value && !clearing.value && !memorySaving.value && (input.value.trim().length > 0 || Boolean(attachment.value && photoAvailable.value)) && input.value.length <= 1000)
const habitText = computed(() => memory.value?.habits?.count ? `常用时段（北京时间）：${memory.value.habits.commonHours.map((hour) => String(hour).padStart(2, '0') + ':00').join('、')}，来自你近 14 天的 ${memory.value.habits.count} 次登记。` : '登记记录积累后，会显示你的常用洗衣时段。')
const mcpUrl = computed(() => new URL((BASE || '') + '/api/mcp', window.location.origin).href)
function showError(e, fallback) { if (currentSession()) error.value = e?.message || fallback }
function addVoiceText(text) {
  if (currentSession()) input.value = [input.value.trim(), text].filter(Boolean).join(' ').slice(0, 1000)
}
const browserSpeech = createAssistantSpeech(window, {
  onActive: value => { recording.value = value },
  onText: addVoiceText,
  onError: value => { if (currentSession()) voiceError.value = value },
})
const deepSeekMic = createAssistantMic(window, assistantRecordingWorkletUrl, {
  onActive: value => { recording.value = value },
  onAudio: recognizeAudio,
  onError: value => { if (currentSession()) voiceError.value = value },
})
const serverVoice = computed(() => status.value?.voiceRecognitionReady === true && deepSeekMic.supported)
const voiceAvailable = computed(() => serverVoice.value || browserSpeech.supported)
async function recognizeAudio(audio) {
  if (!currentSession()) return
  const controller = new AbortController()
  voiceRequest = controller
  transcribing.value = true
  try {
    const text = await transcribeAssistantAudio(audio, controller.signal)
    if (voiceRequest === controller) addVoiceText(text)
  } catch (problem) {
    if (voiceRequest === controller && currentSession()) voiceError.value = problem?.message || '语音识别失败，请重试。'
  } finally {
    if (voiceRequest === controller) {
      voiceRequest = null
      transcribing.value = false
    }
  }
}
function toggleVoice() {
  if (!currentSession() || !canChat.value || sending.value || transcribing.value) return
  if (recording.value) { activeMic?.stop(); return }
  voiceError.value = ''
  activeMic = serverVoice.value ? deepSeekMic : browserSpeech
  void activeMic.start()
}
const voiceDescription = computed(() => serverVoice.value
  ? '由 DeepSeek 转写，结果会填入输入框。'
  : '由浏览器语音服务转写，结果会填入输入框。')
function stopVoice() {
  activeMic?.abort()
  activeMic = null
  voiceRequest?.abort()
  voiceRequest = null
  transcribing.value = false
  voiceError.value = ''
}
function removePhoto() {
  photoRevision++
  attachment.value = ''
  photoError.value = ''
  preparingPhoto.value = false
}
function pickAttachment(field) {
  if (!canChat.value || sending.value || preparingPhoto.value) return
  showAttachments.value = false
  field?.click()
}
async function choosePhoto(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !currentSession() || !canChat.value || !photoAvailable.value || sending.value) return
  const revision = ++photoRevision
  preparingPhoto.value = true
  photoError.value = ''
  try {
    const data = await prepareAssistantPhoto(file)
    if (revision === photoRevision && currentSession()) attachment.value = data
  } catch (problem) {
    if (revision === photoRevision && currentSession()) photoError.value = problem?.message || '照片无法读取，请重试。'
  } finally {
    if (revision === photoRevision) preparingPhoto.value = false
  }
}
async function scrollMessages({ follow = false } = {}) {
  const list = messageList.value
  if (follow && list && list.scrollHeight - list.scrollTop - list.clientHeight > 80) return
  await nextTick()
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
}
function applyResource(key, value) {
  if(value !== null && !currentSession()) return
  const data = value == null ? null : JSON.parse(JSON.stringify(value))
  if (key === 'status') status.value = data
  if (key === 'skills') skills.value = data?.skills || []
  if (key === 'memory') { memory.value = data; memoryNote.value = data?.note || '' }
  if (key === 'preferences') preferences.value = data
}
for (const key of ASSISTANT_WARMUP_RESOURCES) {
  watch(() => resources[key].data, value => applyResource(key, value), { immediate: true, flush: 'sync' })
}
watch(() => resources.status.loading, value => { loading.value = value }, {immediate:true})
watch(() => resources.status.error, value => { error.value = value }, {immediate:true})
async function loadResource(key, force = false) {
  if (!currentSession()) return
  return assistantData.read(key, { force })
}
function load() {
  error.value = ''
  for (const key of ASSISTANT_WARMUP_RESOURCES) loadResource(key, true)
}
function openHistory() {
  if (!currentSession()) return
  showHistory.value = true
  void loadResource('history', true)
}
function messageDate(at) { return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }
function publish(key, data) { if (currentSession()) assistantData.publish(key, data) }
async function savePreferences() {
  if(!currentSession())return
  if(promptSaving.value||sending.value)return
  promptSaving.value=true;error.value=''
  try{const data=await api('/api/assistant/preferences',{method:'PATCH',retry:false,body:{promptProfiles:preferences.value.promptProfiles,activePromptId:preferences.value.activePromptId}});if(currentSession()){publish('preferences',data);showToast('已保存并使用此提示词')}}catch(e){showError(e,'提示词保存失败')}finally{if(currentSession())promptSaving.value=false}
}
function addPrompt(){const row={id:'personal-'+crypto.randomUUID(),name:'我的模板',text:activePrompt.value?.text||'请简洁说明洗衣安排。'};preferences.value.promptProfiles.push(row);preferences.value.activePromptId=row.id}
function removePrompt(){preferences.value.promptProfiles=preferences.value.promptProfiles.filter(row=>row.id!==preferences.value.activePromptId);preferences.value.activePromptId=preferences.value.promptProfiles[0].id}
async function resetPreferences(){if(promptSaving.value||sending.value||!await confirm('恢复平台默认提示词？','将删除当前账号的自定义提示词，可重新编辑。'))return;promptSaving.value=true;try{const data=await api('/api/assistant/preferences',{method:'PATCH',retry:false,body:{reset:true}});if(currentSession())publish('preferences',data)}catch(e){showError(e,'恢复失败')}finally{if(currentSession())promptSaving.value=false}}
async function send() {
  if (!currentSession() || !canSend.value) return
  const text = input.value.trim()
  const photoData = photoAvailable.value ? attachment.value : ''
  const controller = new AbortController()
  activeRequest = controller
  const ownsRequest = () => currentSession() && activeRequest === controller
  sending.value = true; error.value = ''; refusal.value = ''
  partialTurn.value = null
  draftTurn.value = { input: text, text: '', hasPhoto: Boolean(photoData) }
  scrollMessages()
  try {
    const data = await streamAssistantChat({ input: text, conversationId, ...(status.value?.deepThinkingAvailable && deepThink.value ? { deepThink: true } : {}), ...(photoData ? { photoData } : {}) }, {
      signal: controller.signal,
      onDelta: delta => {
        if (!ownsRequest()) return
        draftTurn.value.text += delta
        scrollMessages({ follow: true })
      },
      onReset: () => { if (ownsRequest()) draftTurn.value.text = '' },
    })
    if (!ownsRequest()) return
    messages.value = data.messages
    if (showHistory.value) void loadResource('history', true)
    contextInfo.value = data.context
    input.value = ''
    removePhoto()
    publish('status', { ...status.value, usage: data.usage })
    scrollMessages({ follow: true })
  } catch (problem) {
    if (!ownsRequest()) return
    const stopped = controller.signal.aborted
    const safetyFailure = ['assistant_refusal', 'assistant_suspended'].includes(problem?.code)
    if (safetyFailure) refusal.value = problem.message
    else if (draftTurn.value.text || stopped) {
      partialTurn.value = { ...draftTurn.value, stopped }
      scrollMessages({ follow: true })
    }
    if (!stopped && !safetyFailure) showError(problem, '提问失败，内容已保留')
    void loadResource('status', true)
  } finally {
    if (ownsRequest()) { activeRequest = null; draftTurn.value = null; sending.value = false }
  }
}
function stopAnswer() { activeRequest?.abort() }
async function confirm(title, message) { try { await showConfirmDialog({ title, message }); return currentSession() } catch { return false } }
async function clearHistory() {
  if(!currentSession())return
  if (sending.value || clearing.value || !await confirm('清空对话？', '会删除当前账号保存的聊天记录，个人记忆单独管理。')) return
  clearing.value = true; error.value = ''
  try { await api('/api/assistant/history', { method: 'DELETE', retry: false }); if (currentSession()) { conversationId = crypto.randomUUID(); messages.value = []; partialTurn.value = null; contextInfo.value = null; publish('history',{messages:[]}) } }
  catch (e) { showError(e, '清空失败') }
  finally { if (currentSession()) clearing.value = false }
}
async function updateMemory(body) {
  if(!currentSession())return
  if (memorySaving.value || sending.value) return
  memorySaving.value = true; error.value = ''
  try { const data = await api('/api/assistant/memory', { method: 'PATCH', body, retry: false }); if (currentSession()) { publish('memory',data) } }
  catch (e) { showError(e, '记忆保存失败') }
  finally { if (currentSession()) memorySaving.value = false }
}
function toggleMemory(enabled) { updateMemory({ enabled }) }
function saveMemory() { updateMemory({ note: memoryNote.value }) }
async function clearMemory() {
  if(!currentSession())return
  if (memorySaving.value || sending.value || !await confirm('清空个人记忆？', '将删除备注并关闭记忆。以后重新开启时，仅从清空之后的新登记生成习惯。')) return
  memorySaving.value = true; error.value = ''
  try { const data = await api('/api/assistant/memory', { method: 'DELETE', retry: false }); if (currentSession()) { publish('memory',data) } }
  catch (e) { showError(e, '清空失败') }
  finally { if (currentSession()) memorySaving.value = false }
}
async function refreshSkills() {
  if(!currentSession())return; const data = await api('/api/assistant/skills'); if (currentSession()) publish('skills',data) }
async function createSkill() {
  if(!currentSession())return
  if (busySkill.value) return
  busySkill.value = true; error.value = ''
  try { const data = await api('/api/assistant/skills', { method: 'POST', body: { ...draft }, retry: false }); if (currentSession()) { await refreshSkills(); Object.assign(draft, { title: '', description: '', prompt: '' }); showToast('Skill 已保存') } }
  catch (e) { showError(e, 'Skill 保存失败') }
  finally { if (currentSession()) busySkill.value = false }
}
async function deleteSkill(skill) {
  if(!currentSession())return
  if (busySkill.value || !await confirm('删除这个 Skill？', skill.title)) return
  busySkill.value = true; error.value = ''
  try { await api('/api/assistant/skills/' + encodeURIComponent(skill.id), { method: 'DELETE', retry: false }); if (currentSession()) { await refreshSkills() } }
  catch (e) { showError(e, '删除失败') }
  finally { if (currentSession()) busySkill.value = false }
}
async function shareSkill(skill) {
  if(!currentSession())return
  if (busySkill.value) return
  busySkill.value = true; error.value = ''
  try { const data = await api('/api/assistant/skills/' + encodeURIComponent(skill.id) + '/share', { method: 'POST', body: {}, retry: false }); if (currentSession()) share.value = { title: skill.title, url: window.location.origin + window.location.pathname + '#/assistant?skill=' + encodeURIComponent(data.ticket) } }
  catch (e) { showError(e, '分享失败') }
  finally { if (currentSession()) busySkill.value = false }
}
function extractTicket(value) {
  try { const url = new URL(value); const index = url.hash.indexOf('?'); return index >= 0 ? new URLSearchParams(url.hash.slice(index + 1)).get('skill') || '' : url.searchParams.get('skill') || '' } catch { return value.trim() }
}
async function importSkill() {
  if(!currentSession())return
  if (busySkill.value) return
  busySkill.value = true; error.value = ''
  try {
    const data = await api('/api/assistant/skills/import', { method: 'POST', body: { ticket: extractTicket(importTicket.value) }, retry: false })
    if (currentSession()) { await refreshSkills(); importTicket.value = ''; if (route.query.skill) router.replace({ path: route.path, query: { ...route.query, skill: undefined } }); showToast('已导入你的 Skill 副本') }
  } catch (e) { showError(e, '导入失败') }
  finally { if (currentSession()) busySkill.value = false }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); if (currentSession()) showToast('已复制') }
  catch { showError(null, '当前浏览器无法自动复制，请长按文字复制') }
}
function stopVoiceWhenHidden() { if (document.hidden) stopVoice() }
onMounted(() => {
  if (typeof route.query.skill === 'string' && route.query.skill.length <= 10000) {
    importTicket.value = route.query.skill
    showOptions.value = true
    showSkills.value = true
  }
  for (const key of ASSISTANT_WARMUP_RESOURCES) loadResource(key)
  document.addEventListener('visibilitychange', stopVoiceWhenHidden)
})
onUnmounted(() => {
  alive = false
  activeRequest?.abort()
  activeRequest = null
  stopVoice()
  removePhoto()
  document.removeEventListener('visibilitychange', stopVoiceWhenHidden)
})
</script>

<style scoped>
.safety-notice{margin:10px 0;padding:10px 12px;border:1px solid #dc2626;border-radius:10px;color:var(--danger,#dc2626);background:rgba(220,38,38,.09);overflow-wrap:anywhere}
.assistant-page{max-width:840px;margin:0 auto;padding-bottom:24px}.assistant-page .card{margin:12px;padding:18px}.assistant-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:linear-gradient(130deg,rgba(37,99,235,.13),rgba(14,165,233,.04))}.assistant-top h1{font-size:20px;margin:0 0 8px}.assistant-top p{font-size:12px;margin:0;line-height:1.7}.quota{font-size:11px;border:1px solid var(--border,#334155);border-radius:999px;padding:6px 10px;white-space:nowrap}.notice{font-size:13px;line-height:1.8}.notice p{margin:8px 0}.notice a{color:#7dd3fc}.notice.error{margin:12px;padding:12px;border:1px solid rgba(248,113,113,.25);border-radius:10px;overflow-wrap:anywhere}.error{color:#fca5a5}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.section-head h2{font-size:15px;margin:0}.hint{font-size:11px;line-height:1.8}.text-button{border:0;background:transparent;color:#7dd3fc;cursor:pointer;font:inherit;font-size:12px;padding:6px 2px;min-height:32px}.text-button:disabled{opacity:.4;cursor:default}.text-button.danger{color:#fca5a5}.skill-options{display:flex;gap:8px;flex-wrap:wrap}.skill-options button{border:1px solid var(--border,#334155);background:var(--bg,#0b1526);color:var(--text,#e8f0fb);padding:8px 12px;border-radius:999px;min-height:38px;font-size:12px;cursor:pointer}.skill-options button.active{background:rgba(59,130,246,.18);border-color:#3b82f6;color:#bfdbfe}.skill-management{margin-top:14px;border-top:1px solid var(--border,#334155)}.skill-row{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid var(--border,#334155);padding:9px 0;flex-wrap:wrap}.skill-row b{font-size:12px;overflow-wrap:anywhere}.skill-row span{font-size:10px;margin-left:8px}.row-actions{display:flex;gap:10px;flex-wrap:wrap}.assistant-page summary{cursor:pointer;font-size:12px;padding:12px 0}.stack{display:grid;gap:12px}.stack label{display:grid;gap:6px;font-size:12px}.stack .van-button{justify-self:end}.resource-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--text-dim);font-size:12px;overflow-wrap:anywhere}.resource-notice span{min-width:0}.resource-notice button{flex:none}.assistant-page input:not([type=checkbox]),.assistant-page textarea,.assistant-page select{box-sizing:border-box;display:block;width:100%;max-width:100%;min-width:0;padding:10px;background:var(--bg,#0b1526);color:var(--text,#e8f0fb);border:1px solid var(--border,#334155);border-radius:9px;font:inherit;font-size:14px;line-height:1.7;resize:vertical}.assistant-page input:focus-visible,.assistant-page select:focus-visible,.assistant-page textarea:focus-visible,.assistant-page button:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}.assistant-page textarea:disabled{opacity:.5}.share-box{display:grid;gap:10px;margin-top:16px;padding:14px;border:1px solid var(--border,#334155);border-radius:10px}.share-box :deep(canvas),.share-box :deep(img){max-width:100%;height:auto;justify-self:center}.share-box .van-button{justify-self:start}.share-box b{font-size:13px}.messages{max-height:min(60vh,620px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:4px 0 12px;display:flex;flex-direction:column;gap:14px}.message{max-width:91%;border-radius:12px;padding:12px 14px;background:rgba(148,163,184,.08);box-sizing:border-box;overflow-wrap:anywhere}.message.user{align-self:flex-end;background:rgba(59,130,246,.15)}.speaker{font-size:10px;color:var(--text-dim,#94a3b8)}.message p{font-size:14px;line-height:1.85;white-space:pre-wrap;margin:5px 0 0}.copy-answer{font-size:10px;margin-top:2px;min-height:28px}.pending p{color:var(--text-dim,#94a3b8);font-size:12px}.empty-state{text-align:center;padding:30px 8px;color:var(--text-dim,#94a3b8);font-size:12px}.empty-state span{font-size:38px;color:#7dd3fc}.composer{border-top:1px solid var(--border,#334155);padding-top:14px}.composer>div{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:10px}.memory-toggle{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-dim,#94a3b8)}.memory-toggle input{width:20px;height:20px;accent-color:#3b82f6}.habit{font-size:12px;line-height:1.8;color:#bfdbfe}.forget{margin-top:12px}.mcp code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;color:#bfdbfe}.mcp summary{padding:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:400px){.assistant-page .card{margin:10px;padding:14px}.assistant-top h1{font-size:18px}.message{max-width:96%}.composer .hint{font-size:10px}.composer>div{gap:8px}.skill-options button{padding:8px 10px}}
.assistant-enter{animation:assistant-appear .36s cubic-bezier(.2,.75,.2,1) both}
@keyframes assistant-appear{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.assistant-enter{animation:none}}
.conversation-examples{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}
.conversation-examples button{min-height:40px;padding:6px 12px;border:1px solid var(--border);border-radius:999px;background:transparent;color:var(--text);font:inherit;cursor:pointer}
.conversation-examples button:disabled{opacity:.55;cursor:default}
.assistant-sheet {
  max-height: 75vh;
  max-height: 75dvh;
  padding: 18px max(16px, calc((100% - 750px) / 2)) calc(16px + env(safe-area-inset-bottom));
  overflow: auto;
  overscroll-behavior: contain;
}
.settings-sheet .card { margin-inline: 0; }
.history-sheet .messages { max-height: 48dvh; }

:global(.app-root:has(> .assistant-page)) {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  padding-bottom: calc(var(--van-tabbar-height, 50px) + env(safe-area-inset-bottom, 0px));
}
.assistant-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  padding-bottom: 0;
}
.assistant-page > :not(.conversation) { flex: none; }
.assistant-page .assistant-top {
  margin-block: 10px 4px;
  padding: 12px 14px;
  background: transparent;
  border: 0;
}
.assistant-top h1 { margin-bottom: 3px; }
.quota { padding: 2px 8px; }

.assistant-nav-actions { display: flex; align-items: center; gap: 2px; }
.assistant-nav-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  min-height: 44px;
  padding: 0 6px;
  gap: 4px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.assistant-nav-actions .van-icon {
  color: var(--text-dim);
  font-size: 17px;
}
.assistant-nav-actions button:hover { background: var(--van-active-color); }

.conversation {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-inline: clamp(12px, 3vw, 24px);
}
.conversation > .messages {
  flex: 1;
  min-height: 0;
  max-height: none;
  padding: 8px 2px;
}
.conversation > .messages > * { flex-shrink: 0; }
.conversation > .hint { margin: 4px 2px; }
.empty-state { margin-block: auto; padding: 16px 4px; }

.composer {
  flex: none;
  margin-block: 0 8px;
  padding: 0;
  border: 0;
}
.composer > .composer-field {
  display: block;
  margin: 0;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: var(--bg-elev);
}
.composer-field:focus-within { border-color: var(--primary); }
.composer-field input[hidden] { display: none; }
.composer-field #assistant-input {
  display: block;
  min-height: 40px;
  max-height: 24dvh;
  padding: 8px 10px 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 16px;
  line-height: 1.5;
  resize: none;
  field-sizing: content;
}
.composer-notice { margin: 4px 10px 6px; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.composer > .safety-notice { margin: 4px 0 6px; font-size: 13px; }
.composer-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.composer-tools button {
  flex-shrink: 0;
  min-height: 44px;
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.composer-tools button:disabled { cursor: default; opacity: .44; }
.composer-tools button:not(:disabled):hover { background: var(--van-active-color); }
.composer-icon { width: 44px; }
.composer-tools .van-icon { width: 20px; height: 20px; font-size: 20px; }
.composer-tools .thinking-toggle { padding-inline: 10px; font-size: 12px; white-space: nowrap; }
.composer-tools [aria-pressed='true'] { color: #a9cfff; background: rgba(59,130,246,.16); }
.composer-tools .composer-send {
  width: 44px;
  margin-inline-start: auto;
  background: #2563eb;
  color: #fff;
}
.composer-tools .composer-send:not(:disabled):hover { background: #1d4ed8; }
.stop-symbol { width: 12px; height: 12px; border-radius: 3px; background: currentColor; }
.photo-preview { display: flex; align-items: center; gap: 8px; margin: 4px 6px; }
.photo-preview .hint { flex: 1; min-width: 0; line-height: 1.4; }
.photo-preview img { flex: none; width: 48px; height: 48px; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); }
.photo-preview button { flex: none; }
.attachment-options { display: grid; gap: 8px; }
.attachment-options > button {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-card);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: start;
}
.attachment-options .van-icon { font-size: 19px; }
</style>
