import { mobileDigest } from './mobile-auth.js'
import { assertMobileAtomicKey } from './mobile-store.js'

const unavailable = () => new Error('mobile_store_unavailable')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** CloudBase Node SDK 3.18.7 app.rdb(); each RPC is one PostgreSQL transaction. */
export function createCloudBasePostgresAtomicStore(rdb, { now = Date.now } = {}) {
  if (typeof rdb?.rpc !== 'function' || typeof now !== 'function') throw unavailable()
  async function rpc(name, args) {
    let response
    try { response = await rdb.rpc(name, args) } catch { throw unavailable() }
    // Always use an object envelope. This also preserves false/null when the
    // SDK's HTTP adapter would otherwise substitute {} for scalar responses.
    const body = response?.data
    if (response?.error || !object(body) || body.protocolVersion !== 1 || body.ok !== true || !Object.hasOwn(body, 'result')) throw unavailable()
    return body.result
  }
  return {
    consistency: 'linearizable', durable: true,
    async get(key) {
      assertMobileAtomicKey(key)
      const result = await rpc('weshirt_mobile_atomic_get', { p_key_digest: await mobileDigest(key) })
      if (result !== null && (!object(result) || typeof result.version !== 'string' || !result.version || result.version.length > 80 || !object(result.value))) throw unavailable()
      return result
    },
    async compareAndSet(key, expectedVersion, value, { expiresAt } = {}) {
      assertMobileAtomicKey(key)
      const time = now()
      if (expectedVersion !== null && (typeof expectedVersion !== 'string' || expectedVersion.length > 80) || !object(value) || !Number.isSafeInteger(expiresAt) || expiresAt <= time || expiresAt > time + 100 * 86400000) throw unavailable()
      const result = await rpc('weshirt_mobile_atomic_cas', {
        p_key_digest: await mobileDigest(key), p_expected_version: expectedVersion,
        p_next_version: crypto.randomUUID(), p_value: value, p_expires_at_ms: expiresAt,
      })
      if (typeof result !== 'boolean') throw unavailable()
      return result
    },
  }
}
