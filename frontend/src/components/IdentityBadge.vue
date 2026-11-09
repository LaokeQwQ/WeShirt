<template>
  <span v-if="badge" class="identity-badge" :class="badge.tone">{{ badge.label }}</span>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ identity: { type: [Object, String], default: null } })
const badge = computed(() => {
  const role = typeof props.identity === 'string' ? props.identity : props.identity?.role
  if (['super', 'superadmin', 'owner'].includes(role)) return { label: '总管', tone: 'super' }
  if (['admin', 'administrator'].includes(role)) return { label: '管理员', tone: 'admin' }
  if (role === 'volunteer') return { label: '志愿管理', tone: 'volunteer' }
  if (['operations', 'operator', 'ops'].includes(role)) return { label: '运维', tone: 'operator' }
  return null
})
</script>

<style scoped>
.identity-badge{display:inline-flex;align-items:center;flex:none;max-width:100%;padding:2px 7px;border:1px solid transparent;border-radius:999px;font-size:10px;font-weight:600;line-height:1.35;white-space:nowrap}.super{color:#fbd38d;background:rgba(180,83,9,.18);border-color:rgba(251,191,36,.25)}.admin{color:#bfdbfe;background:rgba(37,99,235,.2);border-color:rgba(96,165,250,.28)}.volunteer{color:#a7f3d0;background:rgba(5,150,105,.16);border-color:rgba(52,211,153,.25)}.operator{color:#ddd6fe;background:rgba(124,58,237,.15);border-color:rgba(167,139,250,.25)}
</style>
