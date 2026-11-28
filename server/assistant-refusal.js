import { AssistantError } from '../packages/core/assistant-stream.js'
import { mobileDigest } from '../packages/core/mobile-auth.js'

const WINDOW = 3 * 60 * 60_000
const BLOCK = 8 * 60 * 60_000

export function nextRefusalState(previous, now, refused) {
  if (previous?.blockedUntil > now) return previous
  if (!refused) return null
  const recent = (Array.isArray(previous?.recent) ? previous.recent : []).filter(at => Number.isFinite(at) && at <= now && now - at <= WINDOW)
  recent.push(now)
  return { recent: recent.slice(-3), blockedUntil: recent.length >= 3 ? now + BLOCK : 0 }
}

export function speechOrChatBlocked(until) {
  const error = new AssistantError('assistant_suspended', '连续 3 次未通过内容审核，助手已暂停使用 8 小时', 403)
  error.blockedUntil = new Date(until).toISOString()
  return error
}

export function assistantRefusalGuard(store, atomicStore, now = Date.now) {
  const rowKey = async id => 'mobile:limit:assistant-refusals:' + await mobileDigest(id)
  async function read(id) {
    try {
      const key = await rowKey(id)
      return atomicStore ? (await atomicStore.get(key))?.value : await store.get(key, null)
    } catch { throw new AssistantError('safety_unavailable', '暂时无法核验审核状态，请稍后重试', 503) }
  }
  async function blockedUntil(id) {
    const until = (await read(id))?.blockedUntil
    return Number.isFinite(until) && until > now() ? until : 0
  }
  async function record(id, refused) {
    const key = await rowKey(id)
    const at = now()
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const row = atomicStore ? await atomicStore.get(key) : { value: await store.get(key, null) }
        const state = nextRefusalState(row?.value, at, refused)
        if (!state && !row?.value) return 0
        if (!atomicStore) {
          if (state) await store.put(key, state)
          else await store.del(key)
          return state?.blockedUntil || 0
        }
        const value = state || { recent: [], blockedUntil: 0 }
        if (await atomicStore.compareAndSet(key, row?.version || null, value, {
          expiresAt: Math.max(value.blockedUntil, at + WINDOW) + 60_000,
        })) return value.blockedUntil
      }
    } catch { /* a failed write is never replayed */ }
    throw new AssistantError('safety_unavailable', '暂时无法记录审核状态，请稍后重试', 503)
  }
  return { blockedUntil, record }
}
