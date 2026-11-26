import { timingSafeEqual } from './auth.js'
import { createModerationCallbackToken, createTencentCiModeration } from './tencent-ci-moderation.js'

const encoder = new TextEncoder()
const HOUR = 3_600_000
const LEASE = 30_000
const RETRY = 10_000
const PREFIX = 'mobile:moderation:'
const RATE_PREFIX = 'mobile:moderation-rate:'
const marker = /^[a-f0-9]{64}$/
const denied = (code, message, status) => Object.assign(new Error(message), { code, status })
const unavailable = () => denied('moderation_unavailable', '内容审核暂不可用，请稍后重试', 503)
const pending = () => denied('moderation_pending', '内容正在审核，请稍后重新提交相同内容', 409)
const imageExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('')
}

function enforce(result) {
  if (result?.decision === 'pass') return
  if (result?.decision === 'pending') throw pending()
  if (result?.decision === 'review' || result?.decision === 'block')
    throw denied('moderation_rejected', '内容未通过自动审核，请修改后重试', 422)
  throw unavailable()
}

/** Async review records store only bounded correlation metadata, never uploaded content. */
export function createContentModeration({ env = {}, atomicStore, provider = createTencentCiModeration(env), now = Date.now } = {}) {
  const mode = String(env.MODERATION_MODE || 'off').trim().toLowerCase()
  const secret = env.MODERATION_CALLBACK_SECRET
  let callback
  try { callback = new URL(env.MODERATION_CALLBACK_URL) } catch { /* async remains unavailable */ }
  const hasAtomicStore = atomicStore?.consistency === 'linearizable' && atomicStore.durable === true
  const asyncReady = hasAtomicStore &&
    typeof secret === 'string' && /^[\x21-\x7e]{32,128}$/.test(secret) && callback?.protocol === 'https:' &&
    !callback.username && !callback.password && !callback.search && !callback.hash &&
    callback.pathname === '/api/content-review/callback'
  const localLimits = new Map()

  async function admit(actorId) {
    const time = now()
    const window = Math.floor(time / 60_000)
    const reject = () => denied('moderation_too_frequent', '提交较频繁，请稍后重试', 429)
    if (!asyncReady) {
      if (localLimits.size >= 1_024)
        for (const [id, row] of localLimits) if (row.window !== window) localLimits.delete(id)
      const previous = localLimits.get(actorId)
      if (!previous && localLimits.size >= 1_024) throw reject()
      const count = previous?.window === window ? previous.count : 0
      if (count >= 30) throw reject()
      localLimits.set(actorId, { window, count: count + 1 })
      return
    }
    const key = RATE_PREFIX + await digest(encoder.encode(actorId))
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await atomicStore.get(key)
      const count = row?.value.window === window ? row.value.count : 0
      if (count >= 30) throw reject()
      if (await atomicStore.compareAndSet(key, row?.version ?? null, { window, count: count + 1 },
        { expiresAt: (window + 2) * 60_000 })) return
    }
    throw reject()
  }

  async function readResult(saved) {
    if (!saved?.jobId || !saved.objectKey || saved.expiresAt <= now()) return null
    const result = await provider.getResult(saved)
    if (!['pass', 'review', 'block', 'pending'].includes(result?.decision)) throw unavailable()
    return result
  }

  async function settle(key, row, result) {
    if (!result || result.decision === 'pending') return false
    const next = { ...row.value, decision: result.decision }
    return atomicStore.compareAndSet(key, row.version, next, { expiresAt: next.expiresAt })
  }

  async function review({ kind, actorId, surface, text, mime, bytes }) {
    try { return await reviewContent({ kind, actorId, surface, text, mime, bytes }) }
    catch (error) { if (error?.status) throw error; throw unavailable() }
  }

  async function reviewContent({ kind, actorId, surface, text, mime, bytes }) {
    if (mode === 'off') return
    if (!provider || !['sync', 'async'].includes(mode)) throw unavailable()
    if (typeof actorId !== 'string' || !actorId || actorId.length > 100) throw unavailable()
    if (mode === 'sync') {
      await admit(actorId)
      const dataId = crypto.randomUUID()
      return enforce(await (kind === 'text' ? provider.checkText({ text, dataId }) :
        provider.checkImage({ mime, bytes, dataId })))
    }
    if (!asyncReady) throw unavailable()
    const content = kind === 'text' ? encoder.encode(text) : bytes
    const dataId = await digest(encoder.encode(JSON.stringify([actorId, surface, kind, mime || null, await digest(content)])))
    const key = PREFIX + dataId
    const row = await atomicStore.get(key)
    if (row?.value.decision && row.value.decision !== 'pending') return enforce(row.value)
    const started = now()
    const prev = row?.value
    if (prev?.jobId) {
      if (prev.nextCheck > started) throw pending()
      const lease = { ...prev, nextCheck: started + RETRY }
      if (!await atomicStore.compareAndSet(key, row.version, lease, { expiresAt: lease.expiresAt })) throw pending()
      const result = await readResult(lease)
      const current = await atomicStore.get(key)
      if (current?.value.jobId !== prev.jobId) throw pending()
      // A callback may independently settle the same job during this check.
      if (current.value.decision !== 'pending') return enforce(current.value)
      if (await settle(key, current, result)) return enforce(result)
      throw pending()
    }
    if (prev?.nextCheck > started) throw pending()
    await admit(actorId)
    const objectKey = 'moderation/pending/' + kind + '/' + crypto.randomUUID() + '.' + (kind === 'text' ? 'txt' : imageExtensions[mime])
    const expiresAt = started + HOUR
    const preparing = { kind, dataId, objectKey, decision: 'pending', expiresAt, nextCheck: started + LEASE }
    if (!await atomicStore.compareAndSet(key, row?.version ?? null, preparing, { expiresAt })) throw pending()
    const url = new URL(callback)
    url.searchParams.set('key', await createModerationCallbackToken(secret, dataId, objectKey))
    await provider.stage({ kind, objectKey, mime: kind === 'text' ? 'text/plain; charset=utf-8' : mime, bytes: content })
    const submitted = await provider.submit({ kind, dataId, objectKey, callbackUrl: url.href })
    if (!submitted?.jobId) throw unavailable()
    const current = await atomicStore.get(key)
    if (current?.value.objectKey === objectKey && !current.value.jobId)
      await atomicStore.compareAndSet(key, current.version,
        { ...preparing, jobId: submitted.jobId, nextCheck: started + RETRY }, { expiresAt })
    throw pending()
  }

  return {
    enabled: mode !== 'off',
    asyncEnabled: mode === 'async' && Boolean(asyncReady && provider),
    async checkText({ actorId, surface, text }) {
      if (typeof text !== 'string' || !text.trim() || text.length > 1024)
        throw denied('moderation_invalid_request', '需要有效的待审核文本', 400)
      return review({ kind: 'text', actorId, surface, text })
    },
    async checkImage({ actorId, surface, mime, bytes }) {
      if (!Object.hasOwn(imageExtensions, mime) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65536)
        throw denied('bad_avatar', '请上传不超过 64KB 的头像图片', 400)
      return review({ kind: 'image', actorId, surface, mime, bytes })
    },
    async callback(signal, token) {
      if (mode !== 'async' || !provider || !asyncReady) throw unavailable()
      if (!signal || !marker.test(signal.dataId) || !marker.test(token || '') ||
        !timingSafeEqual(token, await createModerationCallbackToken(secret, signal.dataId, signal.objectKey) || '')) {
        throw denied('moderation_callback_unauthorized', '审核回调验签失败', 401)
      }
      const key = PREFIX + signal.dataId
      const row = await atomicStore.get(key)
      const saved = row?.value
      if (!saved || saved.expiresAt <= now() || saved.kind !== signal.kind || saved.objectKey !== signal.objectKey)
        return { accepted: false }
      if (!saved.jobId) return { accepted: false }
      if (saved.jobId !== signal.jobId) return { accepted: false }
      if (saved.decision !== 'pending') return { accepted: true }
      if (saved.nextCallback > now()) return { accepted: true }
      const lease = { ...saved, nextCallback: now() + RETRY }
      if (!await atomicStore.compareAndSet(key, row.version, lease, { expiresAt: saved.expiresAt })) return { accepted: true }
      const result = await readResult(lease)
      const current = await atomicStore.get(key)
      if (current?.value.jobId === saved.jobId && current.value.decision === 'pending') await settle(key, current, result)
      return { accepted: true }
    }
  }
}
