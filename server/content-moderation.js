import { validateInspectionPhoto } from './inspections.js'
import { parseTencentCiCallback } from '../packages/core/tencent-ci-moderation.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'
import { json, apiErr } from '../packages/core/util.js'

const invalid = () => Object.assign(new Error('请上传有效的头像图片'), { code: 'bad_avatar', status: 400 })

export async function reviewAvatar(moderation, { actorId, surface, dataUrl }) {
  if (!moderation?.enabled) return
  if (typeof dataUrl !== 'string') throw invalid()
  const normalized = dataUrl.replace(/^data:image\/jpg;/i, 'data:image/jpeg;')
  try { validateInspectionPhoto(normalized) } catch { throw invalid() }
  const separator = normalized.indexOf(',')
  const mime = normalized.slice(5, separator - ';base64'.length)
  const bytes = Uint8Array.from(atob(normalized.slice(separator + 1)), byte => byte.charCodeAt(0))
  await moderation.checkImage({ actorId, surface, mime, bytes })
}

export function registerContentReviewCallback(app, moderation) {
  if (!moderation.asyncEnabled) return
  app.post('/api/content-review/callback', async c => {
    const token = c.req.query('key')
    if (!/^[a-f0-9]{64}$/.test(token || ''))
      return apiErr('moderation_callback_unauthorized', '审核回调验签失败', 401)
    try {
      const bytes = await readStreamBytes(c.req.raw.body, 128 * 1024)
      if (!bytes) return apiErr('too_large', '审核回调内容过长', 413)
      const signal = parseTencentCiCallback(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!signal) return apiErr('bad_param', '审核回调格式无效', 400)
      const result = await moderation.callback(signal, token)
      return json({ ok: true, accepted: result.accepted }, 200, { 'Cache-Control': 'no-store' })
    } catch (error) {
      if (error.code === 'moderation_callback_unauthorized')
        return apiErr(error.code, error.message, 401)
      if (error instanceof TypeError) return apiErr('bad_param', '审核回调格式无效', 400)
      return apiErr('moderation_unavailable', '内容审核暂不可用，请稍后重试', 503)
    }
  })
}
