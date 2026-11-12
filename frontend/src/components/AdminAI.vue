<template>
  <section class="ai-admin card">
    <header><h3>AI 助手</h3><span class="text-dim">协议、模型与默认提示词</span></header>
    <p class="text-dim intro">凭据仅保存在服务端。Skills 与当前住宿楼的只读机器查询自动可用。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading" class="text-dim">正在读取配置…</p>
    <form v-else-if="loaded" @submit.prevent="save">
      <label class="switch-row"><span>启用 AI 助手</span><input v-model="form.enabled" type="checkbox" :disabled="saving" /></label>
      <label>API 协议<select v-model="form.protocol" :disabled="saving || discovering"><option value="responses">OpenAI Responses</option><option value="chat-completions">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>
      <label>API 地址<input v-model.trim="form.endpoint" type="url" required maxlength="2048" placeholder="https://api.openai.com/v1" :disabled="saving || discovering" /><small>基础地址或完整接口地址均可，切换协议时自动适配路径。仅限公网 HTTPS。</small></label>
      <label>API Key <span class="key-state">{{ keyConfigured ? '已配置' : '未配置' }}</span><input v-model="apiKey" type="password" autocomplete="new-password" maxlength="512" :placeholder="keyConfigured ? '留空保留现有密钥' : '输入服务密钥'" :disabled="saving || discovering || clearKey" /></label>
      <label v-if="keyConfigured" class="switch-row small"><span>清除现有密钥</span><input v-model="clearKey" type="checkbox" :disabled="saving || discovering" /></label>
      <label>模型<input v-model.trim="form.model" list="assistant-models" required maxlength="120" placeholder="选择或手动填写模型 ID" :disabled="saving" /><datalist id="assistant-models"><option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option></datalist></label>
      <div class="actions"><van-button native-type="button" size="small" :disabled="saving || clearKey || (!apiKey && !keyConfigured)" :loading="discovering" @click="discover">获取可用模型</van-button><small>{{ modelNotice || '模型列表不受支持时仍可手动填写。' }}</small></div>
      <div class="limits"><label>思考模式<select v-model="form.reasoningMode" :disabled="saving"><option value="auto">自动匹配模型能力</option><option value="off">关闭（模型支持时）</option><option value="on">开启（确认模型支持）</option></select></label><label>思考强度<select v-model="form.reasoningEffort" :disabled="saving || form.reasoningMode === 'off'"><option value="auto">模型默认</option><option v-for="level in efforts" :key="level" :value="level">{{ level }}</option></select></label></div>
      <small>能力：{{ capabilityText }}。未知模型默认不发送额外思考参数；可手动确认开启。</small>
      <label v-if="form.protocol === 'anthropic'">Claude 思考方式<select v-model="form.thinkingMode" :disabled="saving"><option value="auto">自动匹配</option><option value="adaptive">Adaptive</option><option value="budget">Token budget（兼容旧模型）</option></select></label>
      <div class="limits"><label>每人每日提问额度<input v-model.number="form.dailyLimit" type="number" min="1" max="10000" required :disabled="saving" /></label><label>每人每分钟模型请求<input v-model.number="form.minuteLimit" type="number" min="1" max="30" required :disabled="saving" /></label></div>
      <p class="text-dim small">每分钟最多 30 次，工具续问及失败尝试也占用请求额度。上下文最多128k，接近上限自动压缩早期对话；每日按北京时间重置。</p>
      <fieldset><legend>平台默认提示词</legend><label>当前默认<select v-model="form.activePromptId" :disabled="saving"><option v-for="item in form.promptProfiles" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><template v-if="activePrompt"><label>模板名称<input v-model.trim="activePrompt.name" required maxlength="40" :disabled="saving" /></label><label>模板内容<textarea v-model="activePrompt.text" required maxlength="6000" rows="5" :disabled="saving" /></label></template><div class="actions"><van-button native-type="button" size="small" :disabled="saving || form.promptProfiles.length >= 8" @click="addPrompt">新建模板</van-button><van-button native-type="button" size="small" :disabled="saving || form.promptProfiles.length <= 1" @click="removePrompt">删除此模板</van-button></div><small>用户可以复制默认模板并修改、切换自己的提示词。任何模板都不能扩大工具权限。</small></fieldset>
      <div class="actions"><van-button type="primary" native-type="submit" size="small" :loading="saving" :disabled="discovering">保存配置</van-button><van-button native-type="button" size="small" :disabled="saving || discovering" @click="load">重新读取</van-button><span v-if="saved" class="saved" role="status">已保存</span></div>
    </form>
    <van-button v-else size="small" @click="load">重试</van-button>
  </section>
</template>

<script setup>
import { reactive, ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api } from '../api'
const form = reactive({enabled:false,protocol:'responses',endpoint:'https://api.openai.com/v1',model:'',dailyLimit:1000,minuteLimit:30,reasoningMode:'auto',reasoningEffort:'auto',thinkingMode:'auto',modelCapabilities:{reasoning:null,effortLevels:[],thinkingModes:[],contextWindow:128000},promptProfiles:[],activePromptId:''})
const loading=ref(false),loaded=ref(false),saving=ref(false),discovering=ref(false),error=ref(''),saved=ref(false),apiKey=ref(''),clearKey=ref(false),keyConfigured=ref(false),models=ref([]),modelNotice=ref('')
let alive=true,applying=false
const activePrompt=computed(()=>form.promptProfiles.find(row=>row.id===form.activePromptId))
const efforts=computed(()=>form.modelCapabilities.effortLevels?.length ? form.modelCapabilities.effortLevels : ['none','minimal','low','medium','high','xhigh','max'])
const capabilityText=computed(()=>form.modelCapabilities.reasoning===true ? '支持思考，可用强度 '+(form.modelCapabilities.effortLevels?.join(' / ') || '由服务决定') : form.modelCapabilities.reasoning===false ? '模型未提供思考能力' : '服务未声明，请按模型文档选择')
watch(()=>[form.model,form.protocol],()=>{if(applying)return;form.modelCapabilities=models.value.find(row=>row.id===form.model)?.capabilities || {reasoning:null,effortLevels:[],thinkingModes:[],contextWindow:128000};form.reasoningEffort='auto'})
function apply(data){applying=true;for(const key of Object.keys(form))if(data[key]!==undefined)form[key]=data[key];keyConfigured.value=data.keyConfigured===true;apiKey.value='';clearKey.value=false;queueMicrotask(()=>{applying=false})}
async function load(){if(loading.value||saving.value)return;loading.value=true;error.value='';saved.value=false;try{const data=await api('/api/admin/assistant',{auth:'optional',retry:false});if(alive){apply(data);loaded.value=true}}catch(e){if(alive)error.value=e?.message||'配置读取失败'}finally{if(alive)loading.value=false}}
async function discover(){if(discovering.value||saving.value)return;discovering.value=true;modelNotice.value='';error.value='';try{const data=await api('/api/admin/assistant/models',{method:'POST',auth:'optional',retry:false,timeout:12000,body:{protocol:form.protocol,endpoint:form.endpoint,...(apiKey.value?{apiKey:apiKey.value}:{})}});if(alive){models.value=data.models||[];modelNotice.value=models.value.length?'已读取 '+models.value.length+' 个模型，可从模型输入框选择':'未返回模型，可手动填写';const found=models.value.find(row=>row.id===form.model);if(found)form.modelCapabilities=found.capabilities}}catch(e){if(alive)error.value=e?.message||'列表不可用，请手动填写模型'}finally{if(alive)discovering.value=false}}
async function save(){if(saving.value)return;saving.value=true;error.value='';saved.value=false;const body={...form,...(apiKey.value?{apiKey:apiKey.value}:{}),...(clearKey.value?{clearKey:true}:{})};try{const data=await api('/api/admin/assistant',{method:'PATCH',auth:'optional',retry:false,body});if(alive){apply(data);saved.value=true}}catch(e){if(alive)error.value=e?.message||'保存失败'}finally{if(alive){apiKey.value='';saving.value=false}}}
function addPrompt(){const row={id:'prompt-'+crypto.randomUUID(),name:'新模板',text:'请结合当前机器状态，简洁说明洗衣安排。'};form.promptProfiles.push(row);form.activePromptId=row.id}
function removePrompt(){form.promptProfiles=form.promptProfiles.filter(row=>row.id!==form.activePromptId);form.activePromptId=form.promptProfiles[0].id}
onMounted(load)
onUnmounted(()=>{alive=false;apiKey.value=''})
</script>

<style scoped>
.ai-admin{margin:12px;padding:16px}.ai-admin header{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.ai-admin h3{font-size:16px;margin:0}.ai-admin header span,.intro,.small{font-size:12px;line-height:1.6}.ai-admin form,.ai-admin fieldset{display:grid;gap:14px}.ai-admin fieldset{border:1px solid var(--border,#334155);border-radius:10px;padding:14px;min-width:0}.ai-admin legend{font-size:13px}.ai-admin label{display:grid;gap:6px;font-size:13px;color:var(--text,#e8f0fb)}.ai-admin input:not([type=checkbox]),.ai-admin select,.ai-admin textarea{box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid var(--border,#334155);border-radius:8px;background:var(--bg,#0b1526);color:inherit;font:inherit}.ai-admin textarea{resize:vertical}.ai-admin :is(input,select,textarea):focus{outline:2px solid var(--primary,#3b82f6);outline-offset:1px}.ai-admin small{font-size:11px;color:var(--text-dim,#94a3b8);line-height:1.6}.switch-row{display:flex!important;justify-content:space-between;align-items:center;gap:12px}.switch-row input{width:20px;height:20px;accent-color:#3b82f6}.key-state{color:#8bc7ff;font-size:11px}.limits{display:grid;grid-template-columns:1fr 1fr;gap:12px}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.error{color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.saved{font-size:12px;color:#86efac}@media(max-width:450px){.limits{grid-template-columns:1fr}}
</style>
