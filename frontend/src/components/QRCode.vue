<template>
  <figure class="qr"><canvas v-show="!error" ref="canvas" role="img" aria-label="邀请二维码" /><figcaption v-if="error">二维码生成失败，可复制链接</figcaption></figure>
</template>
<script setup>
import { ref, watch, onMounted } from 'vue'
import QRCode from 'qrcode'
const props = defineProps({ value: { type: String, default: '' }, size: { type: Number, default: 220 } })
const canvas = ref(null)
const error = ref(false)
async function draw() {
  if (!canvas.value || !props.value) return
  try { await QRCode.toCanvas(canvas.value, props.value, { width: Math.max(120, Math.min(400, props.size)), margin: 4, errorCorrectionLevel: 'M', color: { dark: '#071321', light: '#ffffff' } }); error.value = false }
  catch { error.value = true }
}
watch(() => [props.value, props.size], draw)
onMounted(draw)
</script>
<style scoped>.qr{margin:12px auto;text-align:center}.qr canvas{max-width:100%;height:auto;border-radius:12px}.qr figcaption{font-size:13px;color:var(--text-dim)}</style>
