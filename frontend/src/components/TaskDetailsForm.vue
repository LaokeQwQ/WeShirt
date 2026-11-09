<template>
  <div class="task-details-form">
    <label class="note-field">
      <span>洗衣备注 <small>选填，公开显示在机器面板 · {{ count }}/200</small></span>
      <textarea :value="note" :disabled="disabled" rows="2" maxlength="400" aria-label="洗衣备注" placeholder="例如衣物特征或取衣注意事项" @input="updateNote" />
    </label>
    <label v-if="showDisinfectant" class="disinfectant-field">
      <span>使用消毒液 <small>仅作本次洗衣记录</small></span>
      <input type="checkbox" :checked="useDisinfectant" :disabled="disabled" @change="$emit('update:useDisinfectant', $event.target.checked)" />
    </label>
    <label v-if="showDisinfectant" class="disinfectant-field"><span>洗衣前已自清洁 <small>备注、消毒液和自清洁情况均公开可见</small></span><input type="checkbox" :checked="selfCleaned" :disabled="disabled" @change="$emit('update:selfCleaned', $event.target.checked)" /></label>
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ note: { type: String, default: '' }, useDisinfectant: { type: Boolean, default: false }, selfCleaned: { type: Boolean, default: false }, showDisinfectant: { type: Boolean, default: true }, disabled: Boolean })
const emit = defineEmits(['update:note', 'update:useDisinfectant', 'update:selfCleaned'])
const count = computed(() => [...props.note].length)
function updateNote(event) {
  const value = [...event.target.value].slice(0, 200).join('')
  event.target.value = value
  emit('update:note', value)
}
</script>

<style scoped>
.task-details-form{margin:12px 0}.note-field{display:grid;gap:7px;font-size:13px}.note-field>span{display:flex;justify-content:space-between;gap:8px}.task-details-form small{font-size:10px;color:var(--text-dim,#94a3b8);font-weight:normal}.note-field textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;max-height:150px;min-height:64px;padding:9px 10px;border:1px solid var(--border,#334155);border-radius:8px;background:var(--bg,#0b1220);color:var(--text,#e8f0fb);font:inherit;line-height:1.5}.note-field textarea:focus{outline:1px solid var(--primary,#3b82f6)}.disinfectant-field{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;padding:11px 0 1px}.disinfectant-field small{display:block;margin-top:3px}.disinfectant-field input{width:20px;height:20px;accent-color:#3b82f6}
</style>
