<template>
  <div class="floor-tabs">
    <button
      v-for="f in floors"
      :key="f.code"
      class="floor-tab"
      :class="{ active: modelValue === f.code }"
      @click="$emit('update:modelValue', f.code)"
    >
      <span class="floor-code">{{ f.name || (/^[0-9]+$/.test(f.code) ? f.code + ' 层' : f.code) }}</span>
      <span class="floor-idle">空闲 {{ idleCount(f) }}</span>
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  floors: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' }
})
defineEmits(['update:modelValue'])

// 计算某楼层空闲机器数量，显示在标签上
function idleCount(f) {
  return (f.machines || []).filter((m) => m.state === 'idle').length
}
</script>

<style scoped>
.floor-tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 8px 12px;
}
.floor-tab {
  flex: 0 0 auto;
  min-width: 88px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
}
.floor-tab.active {
  border-color: var(--primary);
  color: var(--text);
}
.floor-code { font-weight: 600; }
.floor-idle { font-size: 12px; }
</style>
