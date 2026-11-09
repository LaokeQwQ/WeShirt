import { withOperationLock } from '../packages/core/operations.js'
import { inspectMp4, readMediaBytes } from '../packages/core/community-media.js'
import { validateInspectionPhoto } from './inspections.js'
const CHUNK = 48 * 1024
const GC_INDEX = 'community:media-gc'
const MEDIA_LOCK = 'community:media-mutations'
const metaKey = (id) => 'community:media:' + id
const partKey = (id, part) => metaKey(id) + ':' + part
const error = (message, status = 400) => { throw Object.assign(new Error(message), { code: 'bad_media', status }) }
const base64 = (bytes) => { let text = ''; for (let at = 0; at < bytes.length; at += 16384) text += String.fromCharCode(...bytes.subarray(at, at + 16384)); return btoa(text) }
export function publicMedia(entry) { return entry ? { id: entry.id, kind: entry.kind, mime: entry.mime, size: entry.size, width: entry.width, height: entry.height, duration: entry.duration, url: '/api/messages/media/' + entry.id } : null }

async function removeStoredMedia(store, entry) {
  if (!entry) return
  await Promise.all(Array.from({ length: entry.parts }, (_, i) => store.del(partKey(entry.id, i))))
  await store.del(metaKey(entry.id))
  const ownKey = 'community:media-index:' + entry.ownerId
  await store.put(ownKey, ((await store.get(ownKey, [])) || []).filter((id) => id !== entry.id))
}
export async function pruneCommunityMedia({ store, now = Date.now(), limit = 20 }) {
  return withOperationLock(store, MEDIA_LOCK, async () => {
    const entries = (await store.get(GC_INDEX, [])) || [], kept = []; let removed = 0
    for (const row of entries) {
      if (row.expiresAt > now || removed >= limit) { kept.push(row); continue }
      const entry = await store.get(metaKey(row.id), null)
      if (entry && entry.expiresAt > now) { kept.push({ id: entry.id, expiresAt: entry.expiresAt }); continue }
      await removeStoredMedia(store, entry); removed++
    }
    await store.put(GC_INDEX, kept)
    return { removed }
  })
}

export function createCommunityMedia({ store, now }) {
  async function remove(id) { return withOperationLock(store, MEDIA_LOCK, async () => { await removeStoredMedia(store, await store.get(metaKey(id), null)); await store.put(GC_INDEX, ((await store.get(GC_INDEX, [])) || []).filter((row) => row.id !== id)) }) }
  return {
    remove,
    async upload(request, uid, channel, avatar = false) {
      await withOperationLock(store, 'community:upload:' + uid, async () => {
        const key = 'community:upload-rate:' + uid
        const recent = ((await store.get(key, [])) || []).filter((at) => now() - at < 10 * 60000)
        if (recent.length >= 5) error('附件发送较频繁，请稍后再试', 429)
        await store.put(key, [...recent, now()])
      })
      const mime = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const bytes = await readMediaBytes(request, avatar ? 64 * 1024 : undefined)
      let details
      if (/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) {
        const dataUrl = `data:${mime};base64,${base64(bytes)}`
        try { validateInspectionPhoto(dataUrl) } catch { error('图片内容与类型不符、尺寸过大或超过 500KB，请重新选择静态图片') }
        details = { kind: 'image', mime, size: bytes.length }
        if (avatar) return { dataUrl }
      } else {
        if (avatar || !['video/mp4', 'video/quicktime'].includes(mime)) error('支持静态图片或 30 秒内的 H.264 MP4/MOV 视频')
        details = inspectMp4(bytes)
      }
      const id = 'media_' + crypto.randomUUID(), parts = Math.ceil(bytes.length / CHUNK)
      const entry = { id, ownerId: uid, channel, ...details, parts, createdAt: now(), expiresAt: now() + 30 * 60000, messageId: null }
      await withOperationLock(store, MEDIA_LOCK, async () => {
        const key = 'community:media-index:' + uid, previous = (await store.get(key, [])) || [], kept = []
        for (const old of previous) { const meta = await store.get(metaKey(old), null); if (!meta) continue; if (meta.expiresAt <= now()) await removeStoredMedia(store, meta); else kept.push(old) }
        if (kept.length >= 20) error('你的有效附件已达20个，请先删除不需要的含附件留言', 429)
        const gc = ((await store.get(GC_INDEX, [])) || []).filter((row) => !previous.includes(row.id) || kept.includes(row.id))
        if (gc.length >= 1000) error('附件存储暂满，请稍后再试', 429)
        // 配额预先检查，绝不为了新附件删除仍被留言引用的内容。
        await Promise.all(Array.from({ length: parts }, (_, i) => store.put(partKey(id, i), base64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)))))
        await store.put(metaKey(id), entry)
        await store.put(key, [...kept, id])
        await store.put(GC_INDEX, [...gc, { id, expiresAt: entry.expiresAt }])
      })
      return publicMedia(entry)
    },
    async get(id) { const entry = await store.get(metaKey(id), null); if (entry && entry.expiresAt <= now()) { await remove(id); return null }; return entry },
    async link(entry, uid, channel, messageId) {
      return withOperationLock(store, MEDIA_LOCK, async () => {
        const current = entry && await store.get(metaKey(entry.id), null)
        if (!current || current.ownerId !== uid || current.channel !== channel || current.messageId || current.expiresAt <= now()) error('附件已失效、已被使用或不属于当前频道', 403)
        const saved = { ...current, messageId, expiresAt: now() + 30 * 86400000 }
        await store.put(metaKey(entry.id), saved)
        await store.put(GC_INDEX, ((await store.get(GC_INDEX, [])) || []).map((row) => row.id === saved.id ? { id: saved.id, expiresAt: saved.expiresAt } : row))
        return publicMedia(saved)
      })
    },
    async bytes(entry) {
      const parts = await Promise.all(Array.from({ length: entry.parts }, (_, i) => store.get(partKey(entry.id, i), null)))
      if (parts.some((part) => typeof part !== 'string')) error('附件已过期', 404)
      const result = new Uint8Array(entry.size); let at = 0
      for (const part of parts) { const binary = atob(part); for (let i = 0; i < binary.length; i++) result[at++] = binary.charCodeAt(i) }
      if (at !== entry.size) error('附件不完整', 404)
      return result
    },
  }
}
