<template>
  <main class="assistant-page page">
    <van-nav-bar title="洗衣助手" />
    <section class="assistant-top card">
      <div><h1>今天怎么安排洗衣？</h1><p class="text-dim">{{ buildingName || '尚未绑定住宿楼' }} · 查询机器、洗护建议、安排时间</p></div>
      <span v-if="status" class="quota">今日剩余 {{ status.usage.dailyRemaining }} / {{ status.usage.dailyLimit }}</span>
    </section>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <section v-if="loading && !status" class="card notice" role="status">正在连接助手，个人资料会分别载入…</section>
    <section v-else-if="!status" class="card notice"><p>助手暂时无法连接。</p><van-button size="small" @click="load">重新连接</van-button></section>
    <section v-else-if="!status.ready" class="card notice"><b>AI 助手还未开放</b><p>管理员配置完成后即可提问。现在可以直接在看板查看机器。</p><router-link to="/list">查看机器状态 →</router-link></section>
    <section v-else-if="!status.dormBuilding" class="card notice"><b>先选一下住宿楼</b><p>助手会只查询你所绑定住宿楼的机器。</p><router-link to="/settings">前往设置 →</router-link></section>

    <template v-if="userStore.ready && userStore.isLoggedIn">
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

      <section class="conversation card" aria-label="与洗衣助手对话">
        <div class="section-head"><h2>对话</h2><button type="button" class="text-button" :disabled="sending || clearing || !messages.length" @click="clearHistory">清空对话</button></div>
        <p class="hint text-dim">回答仅供安排参考；登记、排队与提醒请前往相应页面确认。聊天保留 14 天，最多 256 条；接近128k上下文时自动提取压缩早期对话。</p>
        <p v-if="contextInfo?.compressed" class="hint text-dim" role="status">较早的对话已自动压缩，近期问题保留原文；需要时请补充细节。</p>
        <div ref="messageList" class="messages" aria-live="polite" aria-relevant="additions text" :aria-busy="sending">
          <div v-if="!messages.length && !sending && !resources.history.loading" class="empty-state"><span aria-hidden="true">◌</span><p>可以问我「现在有空闲烘干机吗？」</p></div>
          <article v-for="(message, index) in messages" :key="message.at + '-' + index" class="message" :class="message.role"><span class="speaker">{{ message.role === 'user' ? '你' : '洗衣助手' }}</span><p>{{ message.content }}</p><button v-if="message.role === 'assistant'" type="button" class="text-button copy-answer" @click="copy(message.content)">复制回答</button></article>
          <article v-if="sending" class="message assistant pending" role="status"><span class="speaker">洗衣助手</span><p>正在查看并整理建议…</p></article>
        </div>
        <form class="composer" @submit.prevent="send"><label class="sr-only" for="assistant-input">向洗衣助手提问</label><textarea id="assistant-input" v-model="input" rows="3" maxlength="1000" :disabled="!canChat || sending" placeholder="输入问题（最多 1000 字）" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" /><div><span class="text-dim hint">{{ input.length }}/1000 · Ctrl / ⌘ + Enter 发送</span><van-button type="primary" native-type="submit" size="small" :disabled="!canSend" :loading="sending">发送</van-button></div></form>
        <p v-if="status?.ready && !status.usage.dailyRemaining" class="hint text-dim">今日额度已用完，明天再来；看板仍可正常查询。</p>
      </section>

      <section v-if="memory" class="memory card">
        <div class="section-head"><h2>个人记忆</h2><label class="memory-toggle"><span>{{ memory.enabled ? '已开启' : '已关闭' }}</span><input type="checkbox" :checked="memory.enabled" :disabled="memorySaving || sending" @change="toggleMemory($event.target.checked)" /></label></div>
        <p class="hint text-dim">默认关闭。开启后会将你的备注和近 14 天登记的常用洗衣时段用于回答，仅属于你的账号。</p>
        <p v-if="memory.enabled" class="habit">{{ habitText }}</p>
        <form class="stack" @submit.prevent="saveMemory"><label>我希望助手记住<textarea v-model="memoryNote" maxlength="500" rows="3" placeholder="例如：周二晚上有空；尽量使用冷水。" :disabled="memorySaving || sending" /></label><div class="section-head"><span class="hint text-dim">{{ memoryNote.length }}/500{{ memory.enabled ? '' : ' · 关闭时不会用于回答' }}</span><van-button native-type="submit" size="small" :loading="memorySaving" :disabled="sending">保存备注</van-button></div></form>
        <button type="button" class="text-button danger forget" :disabled="memorySaving || sending" @click="clearMemory">清空并关闭记忆</button>
      </section>
      <details class="mcp card"><summary>连接个人只读 MCP</summary><p class="hint text-dim">支持 JSON-RPC HTTP。使用你的登录 Bearer 凭证访问同源 /api/mcp，可读取当前绑定住宿楼状态；不提供写入或通知工具。不要把个人登录凭证分享给他人。</p><code>{{ mcpUrl }}</code></details>
    </template>
  </main>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api, BASE } from '../api'
import QRCode from '../components/QRCode.vue'
import { dormBuildingName } from '../../../packages/core/buildings.js'
import { useUserStore } from '../stores/user'
import { assistantData } from '../assistantData'
const route = useRoute(), router = useRouter()
const userStore = useUserStore(), resources = assistantData.state
const resourceLabels = [{key:'history',label:'对话记录'},{key:'skills',label:'Skills'},{key:'memory',label:'个人记忆'},{key:'preferences',label:'回答风格'}]
const pendingResources = computed(() => resourceLabels.filter(row => resources[row.key].loading && !resources[row.key].data))
const failedResources = computed(() => resourceLabels.filter(row => resources[row.key].error))
const status = ref(null), messages = ref([]), skills = ref([]), memory = ref(null), memoryNote = ref(''), input = ref(''), error = ref('')
const loading = ref(false), sending = ref(false), clearing = ref(false), memorySaving = ref(false), busySkill = ref(false), showSkills = ref(false), importTicket = ref(''), share = ref(null), messageList = ref(null)
const preferences=ref(null),promptSaving=ref(false),contextInfo=ref(null)
const activePrompt=computed(()=>preferences.value?.promptProfiles.find(row=>row.id===preferences.value.activePromptId))
const draft = reactive({ title: '', description: '', prompt: '' })
let alive = true
const sessionIdentity = {id:userStore.user?.id,token:userStore.token}
function currentSession(){return alive && userStore.ready && userStore.isLoggedIn && sessionIdentity.id===userStore.user?.id && sessionIdentity.token===userStore.token}
watch(() => [userStore.ready,userStore.user?.id,userStore.token], () => {
  if (currentSession()) return
  status.value=null;messages.value=[];skills.value=[];memory.value=null;memoryNote.value='';preferences.value=null;input.value='';share.value=null;contextInfo.value=null;error.value=''
  Object.assign(draft,{title:'',description:'',prompt:''})
}, {flush:'sync'})
const buildingName = computed(() => status.value?.buildingName || dormBuildingName(status.value?.dormBuilding))
const canChat = computed(() => !!(userStore.ready && userStore.isLoggedIn && status.value?.ready && status.value?.dormBuilding && status.value?.usage.dailyRemaining > 0))
const canSend = computed(() => canChat.value && !sending.value && !clearing.value && !memorySaving.value && input.value.trim().length > 0 && input.value.length <= 1000)
const habitText = computed(() => memory.value?.habits?.count ? `常用时段（北京时间）：${memory.value.habits.commonHours.map((hour) => String(hour).padStart(2, '0') + ':00').join('、')}，来自你近 14 天的 ${memory.value.habits.count} 次登记。` : '登记记录积累后，会显示你的常用洗衣时段。')
const mcpUrl = computed(() => new URL((BASE || '') + '/api/mcp', window.location.origin).href)
function showError(e, fallback) { if (currentSession()) error.value = e?.message || fallback }
async function scrollMessages() { await nextTick(); const el = messageList.value; if (el) el.scrollTop = el.scrollHeight }
function applyResource(key, value) {
  if(value !== null && !currentSession()) return
  const data = value == null ? null : JSON.parse(JSON.stringify(value))
  if (key === 'status') status.value = data
  if (key === 'history') { messages.value = data?.messages || []; scrollMessages() }
  if (key === 'skills') skills.value = data?.skills || []
  if (key === 'memory') { memory.value = data; memoryNote.value = data?.note || '' }
  if (key === 'preferences') preferences.value = data
}
for (const key of ['status','history','skills','memory','preferences']) {
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
  for (const key of ['status','history','skills','memory','preferences']) loadResource(key, true)
}
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
  if(!currentSession())return
  if (!canSend.value) return
  const text = input.value.trim()
  sending.value = true; error.value = ''
  const oldMessages = messages.value
  messages.value = [...oldMessages, { role: 'user', content: text, at: new Date().toISOString() }]
  scrollMessages()
  try {
    const data = await api('/api/assistant/chat', { method: 'POST', body: { input: text }, retry: false, timeout: 20000 })
    if (currentSession()) { publish('history',{messages:data.messages}); contextInfo.value=data.context; input.value = ''; publish('status',{ ...status.value, usage: data.usage }); scrollMessages() }
  } catch (e) {
    if (currentSession()) { messages.value = oldMessages; showError(e, '提问失败，内容已保留'); api('/api/assistant/status', { retry: false, silent: true }).then((data) => { if (currentSession()) publish('status',data) }).catch(() => {}) }
  } finally { if (currentSession()) sending.value = false }
}
async function confirm(title, message) { try { await showConfirmDialog({ title, message }); return currentSession() } catch { return false } }
async function clearHistory() {
  if(!currentSession())return
  if (sending.value || clearing.value || !await confirm('清空对话？', '会删除当前账号保存的聊天记录，个人记忆单独管理。')) return
  clearing.value = true; error.value = ''
  try { await api('/api/assistant/history', { method: 'DELETE', retry: false }); if (currentSession()) publish('history',{messages:[]}) }
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
onMounted(() => { if (typeof route.query.skill === 'string' && route.query.skill.length <= 10000) { importTicket.value = route.query.skill; showSkills.value = true } for(const key of ['status','history','skills','memory','preferences'])loadResource(key) })
onUnmounted(() => { alive = false })
</script>

<style scoped>
.assistant-page{max-width:840px;margin:0 auto;padding-bottom:24px}.assistant-page .card{margin:12px;padding:18px}.assistant-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:linear-gradient(130deg,rgba(37,99,235,.13),rgba(14,165,233,.04))}.assistant-top h1{font-size:20px;margin:0 0 8px}.assistant-top p{font-size:12px;margin:0;line-height:1.7}.quota{font-size:11px;border:1px solid var(--border,#334155);border-radius:999px;padding:6px 10px;white-space:nowrap}.notice{font-size:13px;line-height:1.8}.notice p{margin:8px 0}.notice a{color:#7dd3fc}.notice.error{margin:12px;padding:12px;border:1px solid rgba(248,113,113,.25);border-radius:10px;overflow-wrap:anywhere}.error{color:#fca5a5}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.section-head h2{font-size:15px;margin:0}.hint{font-size:11px;line-height:1.8}.text-button{border:0;background:transparent;color:#7dd3fc;cursor:pointer;font:inherit;font-size:12px;padding:6px 2px;min-height:32px}.text-button:disabled{opacity:.4;cursor:default}.text-button.danger{color:#fca5a5}.skill-options{display:flex;gap:8px;flex-wrap:wrap}.skill-options button{border:1px solid var(--border,#334155);background:var(--bg,#0b1526);color:var(--text,#e8f0fb);padding:8px 12px;border-radius:999px;min-height:38px;font-size:12px;cursor:pointer}.skill-options button.active{background:rgba(59,130,246,.18);border-color:#3b82f6;color:#bfdbfe}.skill-management{margin-top:14px;border-top:1px solid var(--border,#334155)}.skill-row{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid var(--border,#334155);padding:9px 0;flex-wrap:wrap}.skill-row b{font-size:12px;overflow-wrap:anywhere}.skill-row span{font-size:10px;margin-left:8px}.row-actions{display:flex;gap:10px;flex-wrap:wrap}.assistant-page summary{cursor:pointer;font-size:12px;padding:12px 0}.stack{display:grid;gap:12px}.stack label{display:grid;gap:6px;font-size:12px}.stack .van-button{justify-self:end}.resource-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--text-dim);font-size:12px;overflow-wrap:anywhere}.resource-notice span{min-width:0}.resource-notice button{flex:none}.assistant-page input:not([type=checkbox]),.assistant-page textarea,.assistant-page select{box-sizing:border-box;display:block;width:100%;max-width:100%;min-width:0;padding:10px;background:var(--bg,#0b1526);color:var(--text,#e8f0fb);border:1px solid var(--border,#334155);border-radius:9px;font:inherit;font-size:14px;line-height:1.7;resize:vertical}.assistant-page input:focus-visible,.assistant-page select:focus-visible,.assistant-page textarea:focus-visible,.assistant-page button:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}.assistant-page textarea:disabled{opacity:.5}.share-box{display:grid;gap:10px;margin-top:16px;padding:14px;border:1px solid var(--border,#334155);border-radius:10px}.share-box :deep(canvas),.share-box :deep(img){max-width:100%;height:auto;justify-self:center}.share-box .van-button{justify-self:start}.share-box b{font-size:13px}.messages{max-height:min(60vh,620px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:4px 0 12px;display:flex;flex-direction:column;gap:14px}.message{max-width:91%;border-radius:12px;padding:12px 14px;background:rgba(148,163,184,.08);box-sizing:border-box;overflow-wrap:anywhere}.message.user{align-self:flex-end;background:rgba(59,130,246,.15)}.speaker{font-size:10px;color:var(--text-dim,#94a3b8)}.message p{font-size:14px;line-height:1.85;white-space:pre-wrap;margin:5px 0 0}.copy-answer{font-size:10px;margin-top:2px;min-height:28px}.pending p{color:var(--text-dim,#94a3b8);font-size:12px}.empty-state{text-align:center;padding:30px 8px;color:var(--text-dim,#94a3b8);font-size:12px}.empty-state span{font-size:38px;color:#7dd3fc}.composer{border-top:1px solid var(--border,#334155);padding-top:14px}.composer>div{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:10px}.memory-toggle{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-dim,#94a3b8)}.memory-toggle input{width:20px;height:20px;accent-color:#3b82f6}.habit{font-size:12px;line-height:1.8;color:#bfdbfe}.forget{margin-top:12px}.mcp code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;color:#bfdbfe}.mcp summary{padding:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:400px){.assistant-page .card{margin:10px;padding:14px}.assistant-top h1{font-size:18px}.message{max-width:96%}.composer .hint{font-size:10px}.composer>div{gap:8px}.skill-options button{padding:8px 10px}}
</style>
