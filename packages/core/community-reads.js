import { mobileDigest } from './mobile-auth.js'
import { readMachineDocument, updateMachineDocument } from './machine-documents.js'

const LIMIT = 1000
const digestOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const unavailable = () => { throw Object.assign(new Error('频道已读状态暂不可用，请稍后重试'), { code: 'community_read_unavailable', status: 503 }) }
const options = (store, buildingId, userId) => ({ store, key: `community:read:${buildingId}:${userId}`, fallback: { seen: [] } })
function seen(value) {
  if (!value || !Array.isArray(value.seen) || value.seen.length > LIMIT || value.seen.some(id => !digestOK(id))) unavailable()
  return value.seen
}
export const communityMessageDigest = (channel, id) => mobileDigest(channel + '|' + id)

export async function readCommunityReadState(store, buildingId, userId) {
  try { return new Set(seen(await readMachineDocument(options(store, buildingId, userId)))) }
  catch { unavailable() }
}

/** Explicit, exact message acknowledgements. CAS union keeps independent devices
 * from rewinding one another. No client clock or ordering watermark is trusted. */
export async function acknowledgeCommunityMessages({ store, buildingId, userId, validate }) {
  try {
    const result = await updateMachineDocument(options(store, buildingId, userId), async state => {
      const previous = seen(state), { acknowledged, retained } = await validate()
      const next = [...new Set([...previous, ...acknowledged])]
      // The message collection retains at most 300 rows. Preserve all surviving
      // read messages (including old pins) plus a generous recent-ID window for
      // workers whose KV snapshot is a little behind a concurrent writer.
      const recent=new Set(next.slice(-(LIMIT-retained.size)))
      const keep = next.length <= LIMIT ? next : next.filter(id => retained.has(id) || recent.has(id))
      if (keep.length > LIMIT) unavailable()
      return { document: { seen: keep }, result: new Set(keep) }
    })
    return result.result
  } catch (error) {
    if (['bad_param', 'forbidden', 'unauthorized', 'not_found'].includes(error?.code) && [400, 401, 403, 404].includes(error.status)) throw error
    unavailable()
  }
}
