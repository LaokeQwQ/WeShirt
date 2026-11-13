<template>
  <div ref="container" class="community-media">
    <video v-if="url && media.kind === 'video'" ref="video" :src="url" controls playsinline preload="metadata" @webkitbeginfullscreen="setVideoFullscreen(true)" @webkitendfullscreen="setVideoFullscreen(false)" />
    <img v-else-if="url" :src="url" alt="频道图片" loading="lazy" @click="preview" />
    <button v-else-if="media.kind === 'video' || error" type="button" :disabled="loading" @click.stop="load">{{ loading ? '正在读取附件…' : media.kind === 'video' ? `短视频${media.duration ? ' · '+Math.ceil(media.duration)+'秒' : ''} · 点击播放` : '图片加载失败，点击重试' }}</button>
    <div v-else class="image-placeholder" role="status">图片加载中…</div>
    <p v-if="error" role="status">{{ error }}</p>
  </div>
</template>
<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { showImagePreview } from 'vant'
import { fetchCommunityMedia } from '../communityMedia'
const props = defineProps({ media: { type: Object, required: true } })
const emit = defineEmits(['preview-visibility'])
const url = ref(''), loading = ref(false), error = ref('')
const video = ref(null)
const container = ref(null)
const previewSource = Symbol('community-media-preview')
let disposed = false, imageOpen = false, videoOpen = false, previewVisible = false, imagePreview, observer
function publishVisibility() { const visible = imageOpen || videoOpen; if (visible !== previewVisible) { previewVisible = visible; emit('preview-visibility', visible, previewSource) } }
function setVideoFullscreen(visible) { if (disposed && visible) return; videoOpen = Boolean(visible); publishVisibility() }
function syncVideoFullscreen() { const full = document.fullscreenElement || document.webkitFullscreenElement; setVideoFullscreen(Boolean(video.value && (full === video.value || full?.contains?.(video.value) || video.value.webkitDisplayingFullscreen))) }
async function load() { if (loading.value) return; loading.value = true; error.value = ''; try { const blob = await fetchCommunityMedia(props.media); if (!disposed) url.value = URL.createObjectURL(blob) } catch (e) { if (!disposed) error.value = e.message } finally { if (!disposed) loading.value = false } }
function preview() {
  if (disposed || !url.value || imageOpen) return
  imageOpen = true; publishVisibility()
  try { imagePreview = showImagePreview({ images: [url.value], closeable: true, onClosed() { imageOpen = false; imagePreview = null; publishVisibility() } }) }
  catch (e) { imageOpen = false; publishVisibility(); error.value = e.message }
}
onMounted(() => {
  document.addEventListener('fullscreenchange', syncVideoFullscreen); document.addEventListener('webkitfullscreenchange', syncVideoFullscreen)
  if (props.media.kind === 'image') {
    if (typeof IntersectionObserver === 'function' && container.value) { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load() } }, { rootMargin: '200px' }); observer.observe(container.value) }
    else load()
  }
})
onUnmounted(() => { disposed = true; observer?.disconnect(); document.removeEventListener('fullscreenchange', syncVideoFullscreen); document.removeEventListener('webkitfullscreenchange', syncVideoFullscreen); if (imageOpen) imagePreview?.close(); imageOpen = false; videoOpen = false; publishVisibility(); if (url.value) URL.revokeObjectURL(url.value) })
</script>
<style scoped>.image-placeholder{display:grid;place-items:center;min-height:120px;min-width:140px;max-width:100%;border-radius:10px;background:var(--bg);color:var(--text-dim);font-size:12px}.community-media img{cursor:zoom-in}</style>
<style scoped>.community-media{margin:8px 0}.community-media img,.community-media video{display:block;max-width:100%;max-height:280px;border-radius:10px;background:#111827}.community-media button{padding:18px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);cursor:pointer}.community-media p{font-size:12px;color:#fbbf24}</style>
