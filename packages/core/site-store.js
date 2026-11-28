import { timingSafeEqual } from './auth.js'
import { readStreamBytes } from './stream-bytes.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const maxKeyBytes = 512
const maxBodyBytes = 4 * 1024 * 1024
const pageSize = 100
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSecret = value => typeof value === 'string' && /^[\x21-\x7e]{32,512}$/.test(value)
const isKey = (value, allowEmpty = false) => typeof value === 'string' && (allowEmpty || value.length > 0) &&
  !value.includes('\0') && encoder.encode(value).byteLength <= maxKeyBytes

export function siteStoreUnavailable() {
  return Object.assign(new Error('CloudBase site storage unavailable'), { code: 'site_store_unavailable' })
}

function validateRecord(key, value) {
  // Authorization must fail closed if a legacy record is malformed.
  if (key === 'meta:siteAdmins' && !Array.isArray(value) ||
    key.startsWith('access:user:') && (!isObject(value) || !isObject(value.permissions)) ||
    key.startsWith('user:') && !isObject(value)) throw siteStoreUnavailable()
  return value
}

function unwrap(data) {
  if (data?.protocolVersion !== 1 || data.ok !== true || !Object.hasOwn(data, 'result')) throw siteStoreUnavailable()
  return data.result
}

function checkKey(key, allowEmpty) {
  if (!isKey(key, allowEmpty)) throw siteStoreUnavailable()
}

/** Edge entry uses only authenticated HTTPS. No browser receives the credential. */
export function createRemoteSiteStore({ url, secret, fetch: fetcher = globalThis.fetch } = {}) {
  let endpoint
  try { endpoint = new URL(url) } catch { return null }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !isSecret(secret)) return null

  async function call(payload) {
    let body
    try { body = JSON.stringify(payload) } catch { throw siteStoreUnavailable() }
    if (encoder.encode(body).byteLength > maxBodyBytes) throw siteStoreUnavailable()

    // Repeat transient reads once. A timed-out mutation may have committed and
    // replaying it could overwrite another writer's newer record.
    const read = payload.op === 'get' || payload.op === 'list'
    const deadline = Date.now() + 8000
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(read && attempt === 0 ? 3500 : 8000, deadline - Date.now())))
      let transient = false
      try {
        let response
        try {
          response = await fetcher(endpoint.href, {
            method: 'POST', redirect: 'error', signal: controller.signal, body,
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
          })
        } catch { transient = true; throw siteStoreUnavailable() }
        if (!response.ok) {
          transient = [408, 429, 500, 502, 503, 504].includes(response.status)
          await response.body?.cancel().catch(() => {})
          throw siteStoreUnavailable()
        }
        let bytes
        try { bytes = await readStreamBytes(response.body, maxBodyBytes) }
        catch { transient = true; throw siteStoreUnavailable() }
        if (!bytes) throw siteStoreUnavailable()
        return unwrap(JSON.parse(decoder.decode(bytes)))
      } catch {
        if (!read || attempt !== 0 || !transient || Date.now() + 100 >= deadline) throw siteStoreUnavailable()
      } finally { clearTimeout(timer) }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  return {
    async get(key, fallback = null) {
      checkKey(key)
      const result = await call({ op: 'get', key })
      if (result?.found === false) return fallback
      if (result?.found !== true || !Object.hasOwn(result, 'value')) throw siteStoreUnavailable()
      return validateRecord(key, result.value)
    },
    async put(key, value) {
      checkKey(key)
      if (value === undefined) throw siteStoreUnavailable()
      validateRecord(key, value)
      if (await call({ op: 'put', key, value }) !== true) throw siteStoreUnavailable()
      return value
    },
    async del(key) {
      checkKey(key)
      const result = await call({ op: 'delete', key })
      if (typeof result !== 'boolean') throw siteStoreUnavailable()
      return result
    },
    async list(prefix = '') {
      checkKey(prefix, true)
      const rows = [], seen = new Set()
      let after = null
      do {
        const page = await call({ op: 'list', prefix, after, limit: pageSize })
        if (!Array.isArray(page?.rows) || page.rows.length > pageSize ||
          page.next !== null && (!isKey(page.next) || page.next !== page.rows.at(-1)?.key)) throw siteStoreUnavailable()
        for (const row of page.rows) {
          if (!isKey(row?.key) || !row.key.startsWith(prefix) || seen.has(row.key) || !Object.hasOwn(row, 'value')) throw siteStoreUnavailable()
          rows.push({ key: row.key, value: validateRecord(row.key, row.value) })
          seen.add(row.key)
        }
        after = page.next
      } while (after !== null)
      return rows
    },
  }
}

export function createSiteStoreHttpHandler({ rdb, secret, importSecret } = {}) {
  const reply = (statusCode, data, eventId) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Event-Id': eventId },
    body: JSON.stringify(data),
  })

  return async (event = {}) => {
    const eventId = 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    const failure = (status, code) => reply(status, { error: { code, status, eventId } }, eventId)
    if (typeof rdb?.rpc !== 'function' || !isSecret(secret)) return failure(503, 'site_store_unavailable')
    if ((event.httpMethod || event.requestContext?.http?.method) !== 'POST') return failure(405, 'method_not_allowed')
    const authorization = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
    const runtime = typeof authorization === 'string' && timingSafeEqual(authorization, 'Bearer ' + secret)
    const importing = typeof authorization === 'string' && isSecret(importSecret) && importSecret !== secret &&
      timingSafeEqual(authorization, 'Bearer ' + importSecret)
    if (!runtime && !importing) return failure(401, 'unauthorized')
    if (event.isBase64Encoded || typeof event.body !== 'string' || encoder.encode(event.body).byteLength > maxBodyBytes)
      return failure(400, 'bad_param')
    let body
    try { body = JSON.parse(event.body) } catch { return failure(400, 'bad_param') }
    if (!isObject(body)) return failure(400, 'bad_param')

    let args
    if (body.op === 'import') {
      if (!importing) return failure(403, 'import_disabled')
      if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > pageSize ||
        !body.rows.every(row => isKey(row?.key) && Object.hasOwn(row, 'value'))) return failure(400, 'bad_param')
      args = { p_rows: body.rows }
    } else if (!runtime) return failure(403, 'import_only')
    else if (body.op === 'list') {
      if (!isKey(body.prefix, true) || body.after !== null && !isKey(body.after) ||
        !Number.isInteger(body.limit) || body.limit < 1 || body.limit > pageSize) return failure(400, 'bad_param')
      args = { p_prefix: body.prefix, p_after: body.after, p_limit: body.limit }
    } else {
      if (!['get', 'put', 'delete'].includes(body.op) || !isKey(body.key) ||
        body.op === 'put' && !Object.hasOwn(body, 'value')) return failure(400, 'bad_param')
      args = body.op === 'put' ? { p_key: body.key, p_value: body.value } : { p_key: body.key }
    }

    try {
      const response = await rdb.rpc('weshirt_site_store_' + body.op, args)
      if (response?.error) throw siteStoreUnavailable()
      unwrap(response?.data)
      const output = reply(200, response.data, eventId)
      return encoder.encode(output.body).byteLength <= maxBodyBytes ? output : failure(503, 'site_store_unavailable')
    } catch { return failure(503, 'site_store_unavailable') }
  }
}
