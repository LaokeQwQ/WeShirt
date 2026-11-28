<template><button v-if="outside.length && !route.meta.full" class="mention-banner" type="button" @click="open">有人@你 <b>{{ outside.length }}</b><span>查看 ›</span></button></template>
<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { api } from '../api'
const route = useRoute(), router = useRouter(), user = useUserStore(), notices = ref([])
const current = computed(() => route.path === '/board' && typeof route.query.channel === 'string' ? route.query.channel : '')
const currentMachine = computed(() => current.value && typeof route.query.machine === 'string' ? route.query.machine : '')
function machineFor(entry) {
  if (entry.machineId) return entry.machineId
  return new URLSearchParams((entry.url || '').split('?')[1]).get('machine') || ''
}
function inCurrentConversation(entry) {
  return entry.channel === current.value && machineFor(entry) === currentMachine.value
}
const outside = computed(() => notices.value.filter((entry) => !entry.readAt && !inCurrentConversation(entry)))
let disposed = false, timer, loading = false, generation = 0
async function load() {
  if (loading || !user.isLoggedIn || document.visibilityState !== 'visible') return
  loading = true
  const owner = user.user.id, version = generation
  try {
    const data = await api('/api/messages/notices', { silent: true })
    if (!disposed && version === generation && owner === user.user?.id) {
      notices.value = data.notices || []
      markChannel()
    }
  } catch {} finally { loading = false }
}
async function markChannel() {
  if (!current.value || !user.isLoggedIn || document.visibilityState !== 'visible') return
  const channel = current.value, machineId = currentMachine.value, owner = user.user.id, version = generation
  const matching = notices.value.filter((entry) => !entry.readAt && inCurrentConversation(entry))
  if (!matching.length) return
  const ids = new Set(matching.map((entry) => entry.id))
  try {
    await api('/api/messages/notices/read', { method: 'POST', body: machineId ? { channel, machineId } : { channel }, silent: true })
    if (!disposed && version === generation && owner === user.user?.id) {
      const readAt = new Date().toISOString()
      notices.value = notices.value.map((entry) => ids.has(entry.id) ? { ...entry, readAt } : entry)
    }
  } catch {}
}
function open() {
  const item = outside.value[0]
  if (item) router.push({ path: '/board', query: { channel: item.channel, machine: machineFor(item) || undefined, message: item.messageId } })
}
function visible() { if (document.visibilityState === 'visible') { load(); markChannel() } }
watch(() => user.user?.id, () => { generation++; notices.value = []; load() }, { immediate: true })
watch([current, currentMachine], () => { markChannel(); load() })
onMounted(() => { load(); timer = setInterval(load, 60000); document.addEventListener('visibilitychange', visible); window.addEventListener('community:changed', load) })
onUnmounted(() => { disposed = true; generation++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('community:changed', load) })
</script>
<style scoped>.mention-banner{position:fixed;top:calc(78px + env(safe-area-inset-top));right:12px;z-index:1080;display:flex;align-items:center;gap:8px;background:#fff7ed;color:#9a3412;border:1px solid #fb923c;border-radius:24px;padding:10px 14px;box-shadow:0 5px 20px #0002;font-size:13px;cursor:pointer}.mention-banner b{background:#ea580c;color:#fff;border-radius:15px;padding:2px 6px;font-size:11px}.mention-banner span{font-size:11px}</style>
