<template>
  <section class="ai-admin card">
    <header><h3>AI 助手</h3><span class="text-dim">Responses 兼容服务</span></header>
    <p class="text-dim intro">配置保存在服务端。助手可查询机器状态，操作由用户在相应页面确认。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading" class="text-dim">正在读取配置…</p>
    <form v-else-if="loaded" @submit.prevent="save">
      <label class="switch-row"><span>启用 AI 助手</span><input v-model="form.enabled" type="checkbox" :disabled="saving" /></label>
      <label>API 地址<input v-model.trim="form.endpoint" type="url" required maxlength="2048" placeholder="https://api.openai.com/v1" :disabled="saving" /><small>支持基础地址或完整 /responses 地址，仅限公网 HTTPS。</small></label>
      <label>模型<input v-model.trim="form.model" required maxlength="120" placeholder="服务支持的模型名称" :disabled="saving" /></label>
      <label>API Key <span class="key-state">{{ keyConfigured ? '已配置' : '未配置' }}</span><input v-model="apiKey" type="password" autocomplete="new-password" maxlength="512" :placeholder="keyConfigured ? '留空保留现有密钥' : '输入服务密钥'" :disabled="saving || clearKey" /></label>
      <label v-if="keyConfigured" class="switch-row small"><span>清除现有密钥</span><input v-model="clearKey" type="checkbox" :disabled="saving" /></label>
      <div class="limits"><label>每人每日额度<input v-model.number="form.dailyLimit" type="number" min="1" max="20" required :disabled="saving" /></label><label>每人每分钟额度<input v-model.number="form.minuteLimit" type="number" min="1" max="3" required :disabled="saving" /></label></div>
      <p class="text-dim small">每人同时处理 1 条，失败尝试也计入额度；每日额度按北京时间重置。</p>
      <div class="actions"><van-button type="primary" native-type="submit" size="small" :loading="saving">保存配置</van-button><van-button native-type="button" size="small" :disabled="saving" @click="load">重新读取</van-button><span v-if="saved" class="saved" role="status">已保存</span></div>
    </form>
    <van-button v-else size="small" @click="load">重试</van-button>
  </section>
</template>

<script setup>
import { reactive, ref, onMounted, onUnmounted } from 'vue'
import { api } from '../api'
const form = reactive({ enabled: false, endpoint: 'https://api.openai.com/v1', model: '', dailyLimit: 20, minuteLimit: 3 })
const loading = ref(false), loaded = ref(false), saving = ref(false), error = ref(''), saved = ref(false), apiKey = ref(''), clearKey = ref(false), keyConfigured = ref(false)
let alive = true
function apply(data) { for (const key of Object.keys(form)) if (data[key] !== undefined) form[key] = data[key]; keyConfigured.value = data.keyConfigured === true; apiKey.value = ''; clearKey.value = false }
async function load() {
  if (loading.value || saving.value) return
  loading.value = true; error.value = ''; saved.value = false
  try { const data = await api('/api/admin/assistant', { auth: false, retry: false }); if (alive) { apply(data); loaded.value = true } }
  catch (e) { if (alive) error.value = e?.message || '配置读取失败' }
  finally { if (alive) loading.value = false }
}
async function save() {
  if (saving.value) return
  saving.value = true; error.value = ''; saved.value = false
  const body = { ...form, ...(apiKey.value ? { apiKey: apiKey.value } : {}), ...(clearKey.value ? { clearKey: true } : {}) }
  try { const data = await api('/api/admin/assistant', { method: 'PATCH', auth: false, retry: false, body }); if (alive) { apply(data); saved.value = true } }
  catch (e) { if (alive) error.value = e?.message || '保存失败' }
  finally { if (alive) { apiKey.value = ''; saving.value = false } }
}
onMounted(load)
onUnmounted(() => { alive = false; apiKey.value = '' })
</script>

<style scoped>
.ai-admin{margin:12px;padding:16px}.ai-admin header{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.ai-admin h3{font-size:16px;margin:0}.ai-admin header span,.intro,.small{font-size:12px;line-height:1.6}.ai-admin form{display:grid;gap:14px}.ai-admin label{display:grid;gap:6px;font-size:13px;color:var(--text,#e8f0fb)}.ai-admin input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid var(--border,#334155);border-radius:8px;background:var(--bg,#0b1526);color:inherit;font:inherit}.ai-admin input:focus{outline:2px solid var(--primary,#3b82f6);outline-offset:1px}.ai-admin small{font-size:11px;color:var(--text-dim,#94a3b8)}.switch-row{display:flex!important;justify-content:space-between;align-items:center;gap:12px}.switch-row input{width:20px;height:20px;accent-color:#3b82f6}.key-state{color:#8bc7ff;font-size:11px}.limits{display:grid;grid-template-columns:1fr 1fr;gap:12px}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.error{color:#fca5a5;font-size:12px;overflow-wrap:anywhere}.saved{font-size:12px;color:#86efac}
</style>
