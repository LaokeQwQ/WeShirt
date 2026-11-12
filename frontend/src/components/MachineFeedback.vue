<template>
  <section class="machine-feedback">
    <van-button block plain :disabled="!machineId" @click="expanded = !expanded">{{ expanded ? '收起机器信息反馈' : '机器名称 / 位置 / 状态有误？' }}</van-button>
    <form v-if="expanded" @submit.prevent="submit">
      <label>反馈类型<select v-model="type" :disabled="saving"><option value="name">名称有误</option><option value="location">机位不符</option><option value="state">状态不符</option><option value="other">其他情况</option></select></label>
      <label>具体情况<textarea v-model="detail" rows="3" maxlength="300" :disabled="saving" placeholder="请说明现场机器与页面不一致的地方，便于管理员核对。" /></label>
      <p class="hint">反馈交由管理员核实，不会直接改变机器运行状态。</p>
      <p v-if="error" class="feedback-error" role="alert">{{ error }}</p><p v-if="receipt" class="receipt" role="status">{{ receipt }}</p>
      <van-button block type="primary" native-type="submit" :loading="saving" :disabled="!detail.trim()">提交反馈</van-button>
    </form>
  </section>
</template>
<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { showConfirmDialog } from 'vant'
import { api, getToken } from '../api'
const props = defineProps({ machineId: { type: [String, Number], required: true }, name: { type: String, default: '' } })
const expanded = ref(false), type = ref('name'), detail = ref(''), saving = ref(false), error = ref(''), receipt = ref('')
let generation = 0, disposed = false
watch(() => props.machineId, () => { generation++; expanded.value = false; type.value = 'name'; detail.value = ''; error.value = ''; receipt.value = ''; saving.value = false })
async function submit() {
  if (saving.value || !props.machineId || !detail.value.trim()) return
  const target = { id: String(props.machineId), type: type.value, detail: detail.value.trim(), token: getToken(), generation }
  saving.value = true; error.value = ''; receipt.value = ''
  try {
    await showConfirmDialog({ title: '确认提交机器反馈', message: `${props.name || '这台机器'}\n${target.detail}` })
    if (disposed || target.generation !== generation || target.token !== getToken()) return
    const data = await api('/api/machines/' + encodeURIComponent(target.id) + '/feedback', { method: 'POST', body: { type: target.type, detail: target.detail } })
    if (!disposed && target.generation === generation && target.token === getToken()) { receipt.value = data.duplicate ? '这条反馈已在处理中，无需重复提交。' : '反馈已提交，等待管理员核实。'; detail.value = '' }
  } catch (e) { if (!disposed && target.generation === generation && e instanceof Error) error.value = e.message }
  finally { if (!disposed && target.generation === generation) saving.value = false }
}
onUnmounted(() => { disposed = true; generation++ })
</script>
<style scoped>
.machine-feedback{margin-top:14px}.machine-feedback form{display:grid;gap:12px;margin-top:14px}.machine-feedback label{display:grid;gap:6px;font-size:13px}.machine-feedback select,.machine-feedback textarea{box-sizing:border-box;width:100%;min-width:0;background:var(--bg-card);color:var(--text);font:inherit;border:1px solid var(--border);border-radius:10px;padding:10px}.hint{font-size:12px;color:var(--text-dim);margin:0;line-height:1.6}.feedback-error,.receipt{font-size:12px;line-height:1.6;overflow-wrap:anywhere;margin:0}.feedback-error{color:var(--van-danger-color,#dc2626)}.receipt{color:var(--van-primary-color,#2563eb)}
</style>
