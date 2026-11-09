<template>
  <div class="community-media">
    <video v-if="url && media.kind === 'video'" :src="url" controls playsinline preload="metadata" />
    <img v-else-if="url" :src="url" alt="频道图片" loading="lazy" @click="preview" />
    <button v-else type="button" :disabled="loading" @click.stop="load">{{ loading ? '正在读取附件…' : media.kind === 'video' ? `▶ 短视频${media.duration ? ' · '+Math.ceil(media.duration)+'秒' : ''} · 点击查看` : '▧ 图片 · 点击查看' }}</button>
    <p v-if="error" role="status">{{ error }}</p>
  </div>
</template>
<script setup>
import { ref, onUnmounted } from 'vue'
import { showImagePreview } from 'vant'
import { fetchCommunityMedia } from '../communityMedia'
const props = defineProps({ media: { type: Object, required: true } })
const url = ref(''), loading = ref(false), error = ref('')
let disposed = false
async function load() { if (loading.value) return; loading.value = true; error.value = ''; try { const blob = await fetchCommunityMedia(props.media); if (!disposed) url.value = URL.createObjectURL(blob) } catch (e) { if (!disposed) error.value = e.message } finally { if (!disposed) loading.value = false } }
function preview() { showImagePreview({ images: [url.value], closeable: true }) }
onUnmounted(() => { disposed = true; if (url.value) URL.revokeObjectURL(url.value) })
</script>
<style scoped>.community-media{margin:8px 0}.community-media img,.community-media video{display:block;max-width:100%;max-height:280px;border-radius:10px;background:#111827}.community-media button{padding:18px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);cursor:pointer}.community-media p{font-size:12px;color:#fbbf24}</style>
