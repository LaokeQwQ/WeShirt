import { getToken, apiError } from './api'
const BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? 'http://localhost:8787' : '')
const MAX_VIDEO = 4 * 1024 * 1024
const mediaPath = /^\/api\/messages\/media\/media_[a-f0-9-]{36}$/
async function checked(response) {
  if (response.ok) return response
  const data = await response.json().catch(() => null)
  throw apiError(data?.error?.message || '附件处理失败', { status: response.status, eventId: response.headers.get('X-Event-ID'), code: data?.error?.code })
}
async function mediaRequest(url, options) {
  try { return await fetch(url, options) }
  catch (error) { throw apiError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? '附件请求超时，请重试' : '网络连接失败，请检查网络后重试', { status: 0, code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' }) }
}
export async function prepareCommunityFile(file, avatar = false) {
  if (!file) throw new Error('请选择附件')
  if (/^image\/(?:png|jpeg|webp|gif)$/.test(file.type)) {
    if (file.size > 15 * 1024 * 1024) throw new Error('图片过大，请先压缩到 15MB 内')
    const image = await createImageBitmap(file)
    try {
      const limit = avatar ? 256 : 1280, scale = Math.min(1, limit / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale))
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const max = avatar ? 64 * 1024 : 500 * 1024
      for (const quality of [0.86, 0.72, 0.55]) { const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality)); if (blob && blob.size <= max) return blob }
      throw new Error('图片压缩后仍过大，请选择较小图片')
    } finally { image.close() }
  }
  if (avatar || !['video/mp4', 'video/quicktime'].includes(file.type)) throw new Error('请选择图片或 MP4/MOV 视频')
  if (file.size > MAX_VIDEO) throw new Error('视频最多 4MB，请压缩后发送')
  const url = URL.createObjectURL(file), video = document.createElement('video')
  try {
    const duration = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('视频读取超时，请重新选择')), 8000)
      video.preload = 'metadata'; video.onloadedmetadata = () => { clearTimeout(timer); resolve(video.duration) }; video.onerror = () => { clearTimeout(timer); reject(new Error('视频无法读取，请选择 H.264 MP4 视频')) }; video.src = url
    })
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error('视频须在 30 秒以内')
    return file
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) }
}
export async function uploadCommunityMedia(file, channel, avatar = false) {
  const token = getToken()
  if (!token) throw new Error('请先登录再发送附件')
  const path = avatar ? '/api/messages/channels/' + encodeURIComponent(channel) + '/avatar' : '/api/messages/media'
  const response = await checked(await mediaRequest(BASE + path + '?channel=' + encodeURIComponent(channel), { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': file.type }, body: file, signal: AbortSignal.timeout(30000), cache: 'no-store' }))
  return response.json()
}
export async function fetchCommunityMedia(media) {
  if (!mediaPath.test(media?.url || '')) throw new Error('附件地址无效')
  const token = getToken()
  if (!token) throw new Error('登录后可查看图片和视频')
  const response = await checked(await mediaRequest(BASE + media.url, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.timeout(30000) }))
  const mime = (response.headers.get('content-type') || '').split(';')[0]
  if (!/^(?:image\/(?:png|jpeg|gif|webp)|video\/mp4)$/.test(mime) || Number(response.headers.get('content-length')) > MAX_VIDEO) throw new Error('附件内容无效')
  const reader = response.body.getReader(), parts = []; let size = 0
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_VIDEO) { reader.cancel().catch(() => {}); throw new Error('附件过大') } parts.push(part.value) } } finally { reader.releaseLock() }
  return new Blob(parts, { type: mime })
}
