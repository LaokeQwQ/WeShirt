import { mobileDigest } from './mobile-auth.js'
import { timingSafeEqual } from './auth.js'
import { readStreamBytes } from './stream-bytes.js'

const keyOK = key => typeof key === 'string' && /^mobile:(?:challenge|session|limit|installation|installation-index|push-users):[A-Za-z0-9_:-]{1,180}$/.test(key)
const error = () => new Error('mobile_store_unavailable')
const assertKey = key => { if (!keyOK(key)) throw error() }
export { assertKey as assertMobileAtomicKey }
const unwrap = result => result && Object.hasOwn(result, 'result') ? result.result : result

/** CloudBase Node SDK 3.x database instance; no SDK imports in Edge bundles. */
export function createCloudBaseMobileAtomicStore(db, { collection = 'weshirt_mobile_sessions', now = Date.now } = {}) {
  if (typeof db?.runTransaction !== 'function' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(collection)) throw error()
  async function transaction(key, change) {
    assertKey(key)
    const documentId = await mobileDigest(key)
    return unwrap(await db.runTransaction(async tx => {
      const document = tx.collection(collection).doc(documentId)
      const response = await document.get()
      if (response?.code) throw error()
      const saved = Array.isArray(response?.data) ? response.data[0] : response?.data
      const row = saved && saved.expiresAt > now() ? saved : null
      if (row && (typeof row.version !== 'string' || !row.value)) throw error()
      return change(document, row)
    }))
  }
  return {
    consistency: 'linearizable', durable: true,
    get(key) { return transaction(key, async (_document, row) => row ? { version: row.version, value: row.value } : null) },
    compareAndSet(key, expectedVersion, value, { expiresAt } = {}) {
      if (expectedVersion !== null && (typeof expectedVersion !== 'string' || expectedVersion.length > 80) || !value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 100 * 86400000) throw error()
      return transaction(key, async (document, row) => {
        if ((row?.version ?? null) !== expectedVersion) return false
        // Node SDK transaction.set accepts fields directly (not Web SDK {data}).
        const result = await document.set({ version: crypto.randomUUID(), value, expiresAt, expireAt: new Date(expiresAt) })
        if (result?.code) throw error()
        return true
      })
    },
  }
}

/** Private HTTPS bridge. Static secret is only in server environment variables. */
export function createRemoteMobileAtomicStore(env = {}, fetcher = fetch) {
  let url
  try { url = new URL(env.MOBILE_ATOMIC_STORE_URL) } catch { return null }
  const secret = env.MOBILE_ATOMIC_STORE_SECRET
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || /[\r\n]/.test(secret)) return null
  async function call(payload) {
    assertKey(payload.key)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetcher(url.href, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: JSON.stringify(payload), signal: controller.signal })
      if (!response.ok) throw error()
      const bytes = await readStreamBytes(response.body, 65536)
      if (!bytes) throw error()
      let data
      try { data = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw error() }
      if (data?.protocolVersion !== 1 || data.ok !== true || !Object.hasOwn(data, 'result')) throw error()
      return data.result
    } finally { clearTimeout(timeout) }
  }
  return {
    consistency: 'linearizable', durable: true,
    async get(key) {
      const result = await call({ op: 'get', key })
      if (result !== null && (!result || typeof result.version !== 'string' || !result.value)) throw error()
      return result
    },
    async compareAndSet(key, expectedVersion, value, { expiresAt }) {
      const result = await call({ op: 'compareAndSet', key, expectedVersion, value, expiresAt })
      if (typeof result !== 'boolean') throw error()
      return result
    },
  }
}

export function createMobileAtomicHttpHandler({ atomicStore, secret }) {
  const reply = (statusCode, result) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) })
  return async event => {
    const eventId = 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    const failure = (status, code) => reply(status, { error: { code, message: '请求未能完成', status, eventId } })
    if (typeof secret !== 'string' || secret.length < 32 || !atomicStore) return failure(503, 'mobile_store_not_configured')
    const method = event.httpMethod || event.requestContext?.http?.method
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
    if (method !== 'POST') return failure(405, 'method_not_allowed')
    if (!timingSafeEqual(headers.authorization || '', 'Bearer ' + secret)) return failure(401, 'unauthorized')
    // This internal endpoint does not accept raw function invocation objects.
    if (event.isBase64Encoded || typeof event.body !== 'string' || new TextEncoder().encode(event.body).byteLength > 65536) return failure(400, 'bad_param')
    let body
    try { body = JSON.parse(event.body) } catch { return failure(400, 'bad_param') }
    if (!body || !keyOK(body.key) || !['get', 'compareAndSet'].includes(body.op)) return failure(400, 'bad_param')
    try {
      const result = body.op === 'get' ? await atomicStore.get(body.key) : await atomicStore.compareAndSet(body.key, body.expectedVersion, body.value, { expiresAt: body.expiresAt })
      return reply(200, { protocolVersion: 1, ok: true, result })
    } catch { return failure(503, 'mobile_store_unavailable') }
  }
}
