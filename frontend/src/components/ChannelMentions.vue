<template><button v-if="outside.length && !route.meta.full" class="mention-banner" type="button" @click="open">有人@你 <b>{{ outside.length }}</b><span>查看 ›</span></button></template>
<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import { api } from '../api'
const route = useRoute(), router = useRouter(), user = useUserStore(), notices = ref([])
const current = computed(() => route.path === '/board' && typeof route.query.channel === 'string' ? route.query.channel : '')
const outside = computed(() => notices.value.filter((entry) => !entry.readAt && entry.channel !== current.value))
let disposed = false, timer, loading = false, generation = 0
async function load() { if (loading || !user.isLoggedIn || document.visibilityState !== 'visible') return; loading = true; const owner = user.user.id, version = generation; try { const data = await api('/api/messages/notices', { silent: true }); if (!disposed && version === generation && owner === user.user?.id) { notices.value = data.notices || []; if (notices.value.some((entry) => entry.channel === current.value && !entry.readAt)) markChannel() } } catch {} finally { loading = false } }
async function markChannel() { if (!current.value || !user.isLoggedIn || document.visibilityState !== 'visible') return; const channel = current.value, owner = user.user.id, version = generation; try { await api('/api/messages/notices/read', { method: 'POST', body: { channel }, silent: true }); if (!disposed && version === generation && owner === user.user?.id) notices.value = notices.value.map((entry) => entry.channel === channel ? { ...entry, readAt: new Date().toISOString() } : entry) } catch {} }
function open() { const item = outside.value[0]; if (item) router.push({ path: '/board', query: { channel: item.channel, message: item.messageId } }) }
function visible() { if (document.visibilityState === 'visible') { load(); markChannel() } }
watch(() => user.user?.id, () => { generation++; notices.value = []; load() }, { immediate: true })
watch(current, () => { markChannel(); load() })
onMounted(() => { load(); timer = setInterval(load, 60000); document.addEventListener('visibilitychange', visible); window.addEventListener('community:changed', load) })
onUnmounted(() => { disposed = true; generation++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('community:changed', load) })
</script>
<style scoped>.mention-banner{position:fixed;top:calc(78px + env(safe-area-inset-top));right:12px;z-index:1080;display:flex;align-items:center;gap:8px;background:#fff7ed;color:#9a3412;border:1px solid #fb923c;border-radius:24px;padding:10px 14px;box-shadow:0 5px 20px #0002;font-size:13px;cursor:pointer}.mention-banner b{background:#ea580c;color:#fff;border-radius:15px;padding:2px 6px;font-size:11px}.mention-banner span{font-size:11px}</style>
