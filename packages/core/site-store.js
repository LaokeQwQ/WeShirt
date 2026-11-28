import { timingSafeEqual } from './auth.js'
import { readStreamBytes } from './stream-bytes.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const maxKeyBytes = 512
const maxBodyBytes = 96 * 1024
const maxValueBytes = 25 * 1024 * 1024
const chunkChars = 65_000
const maxParts = 512
const pageSize = 100
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSecret = value => typeof value === 'string' && /^[\x21-\x7e]{32,512}$/.test(value)
const isKey = (value, allowEmpty = false) => typeof value === 'string' && (allowEmpty || value.length > 0) &&
  !value.includes('\0') && encoder.encode(value).byteLength <= maxKeyBytes
const uploadId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const size = value => encoder.encode(value).byteLength

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

function serialize(value) {
  try {
    const text = JSON.stringify(value)
    if (typeof text === 'string') return text
  } catch { /* invalid JSON */ }
  throw siteStoreUnavailable()
}

/** Split serialized JSON at Unicode boundaries, accounting for HTTP JSON escaping. */
export function splitSiteStoreValue(value) {
  const text = serialize(value)
  if (size(text) > maxValueBytes) throw siteStoreUnavailable()
  const parts = []
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + chunkChars, text.length)
    while (true) {
      if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
      const part = text.slice(offset, end)
      if (size(serialize(part)) <= maxBodyBytes - 1024) {
        parts.push(part)
        offset = end
        break
      }
      end = offset + Math.floor((end - offset) / 2)
    }
  }
  if (parts.length > maxParts) throw siteStoreUnavailable()
  return parts
}

/** Edge entry uses only authenticated HTTPS. No browser receives the credential. */
export function createRemoteSiteStore({ url, secret, fetch: fetcher = globalThis.fetch } = {}) {
  let endpoint
  try { endpoint = new URL(url) } catch { return null }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !isSecret(secret)) return null

  async function call(payload) {
    const body = serialize(payload)
    if (size(body) > maxBodyBytes) throw siteStoreUnavailable()

    // Repeat transient reads once. A timed-out mutation may have committed and
    // replaying it could overwrite another writer's newer record.
    const read = ['get', 'read_chunk', 'list_keys'].includes(payload.op)
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

  async function read(key) {
    const first = await call({ op: 'get', key })
    if (first?.found !== true) {
      if (first?.found === false) return first
      throw siteStoreUnavailable()
    }
    if (Object.hasOwn(first, 'value')) return { found: true, value: validateRecord(key, first.value) }
    if (first.chunked !== true) throw siteStoreUnavailable()
    const chunks = []
    let offset = 0, digest = null, bytes = 0
    while (offset !== null) {
      const part = await call({ op: 'read_chunk', key, offset, digest })
      if (part?.found === false && offset === 0) return part
      if (part?.found !== true || !hash(part.digest) || digest !== null && digest !== part.digest ||
        typeof part.text !== 'string' || part.next !== null && (!Number.isSafeInteger(part.next) || part.next <= offset)) throw siteStoreUnavailable()
      bytes += size(part.text)
      if (bytes > maxValueBytes * 2 || chunks.length >= maxParts * 2) throw siteStoreUnavailable()
      chunks.push(part.text)
      offset = part.next
      digest = part.digest
    }
    let value
    try { value = JSON.parse(chunks.join('')) } catch { throw siteStoreUnavailable() }
    return { found: true, value: validateRecord(key, value) }
  }

  return {
    async get(key, fallback = null) {
      checkKey(key)
      const result = await read(key)
      return result.found ? result.value : fallback
    },
    async put(key, value) {
      checkKey(key)
      if (value === undefined) throw siteStoreUnavailable()
      validateRecord(key, value)
      const payload = { op: 'put', key, value }
      if (size(serialize(payload)) <= maxBodyBytes) {
        if (await call(payload) !== true) throw siteStoreUnavailable()
      } else {
        const chunks = splitSiteStoreValue(value)
        const id = crypto.randomUUID()
        for (let start = 0; start < chunks.length; start += 4) {
          const writes = chunks.slice(start, start + 4).map((text, index) => call({ op: 'stage', id, part: start + index, text }))
          if (!(await Promise.all(writes)).every(result => result === true)) throw siteStoreUnavailable()
        }
        if (await call({ op: 'commit', id, parts: chunks.length, key }) !== true) throw siteStoreUnavailable()
      }
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
        const page = await call({ op: 'list_keys', prefix, after, limit: pageSize })
        if (!Array.isArray(page?.rows) || page.rows.length > pageSize ||
          page.next !== null && (!isKey(page.next) || page.next !== page.rows.at(-1)?.key)) throw siteStoreUnavailable()
        for (const row of page.rows) {
          if (!isKey(row?.key) || !row.key.startsWith(prefix) || seen.has(row.key) ||
            (!Object.hasOwn(row, 'value') && row.chunked !== true)) throw siteStoreUnavailable()
          seen.add(row.key)
        }
        for (let start = 0; start < page.rows.length; start += 4) {
          const fetched = await Promise.all(page.rows.slice(start, start + 4).map(async row => {
            if (Object.hasOwn(row, 'value')) return { key: row.key, value: validateRecord(row.key, row.value) }
            const current = await read(row.key)
            return current.found ? { key: row.key, value: current.value } : null
          }))
          rows.push(...fetched.filter(Boolean))
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
    if (event.isBase64Encoded || typeof event.body !== 'string' || size(event.body) > maxBodyBytes)
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
    } else if (body.op === 'stage') {
      if (!uploadId(body.id) || !Number.isInteger(body.part) || body.part < 0 || body.part >= maxParts ||
        typeof body.text !== 'string' || !body.text) return failure(400, 'bad_param')
      args = { p_id: body.id, p_part: body.part, p_text: body.text, p_import: importing }
    } else if (body.op === 'commit') {
      if (!uploadId(body.id) || !isKey(body.key) || !Number.isInteger(body.parts) || body.parts < 1 || body.parts > maxParts)
        return failure(400, 'bad_param')
      args = { p_id: body.id, p_parts: body.parts, p_key: body.key, p_import: importing }
    } else if (!runtime) return failure(403, 'import_only')
    else if (body.op === 'list_keys') {
      if (!isKey(body.prefix, true) || body.after !== null && !isKey(body.after) ||
        !Number.isInteger(body.limit) || body.limit < 1 || body.limit > pageSize) return failure(400, 'bad_param')
      args = { p_prefix: body.prefix, p_after: body.after, p_limit: body.limit }
    } else if (body.op === 'read_chunk') {
      if (!isKey(body.key) || !Number.isInteger(body.offset) || body.offset < 0 || body.offset > maxValueBytes * 2 ||
        (body.offset === 0 ? body.digest !== null : !hash(body.digest))) return failure(400, 'bad_param')
      args = { p_key: body.key, p_offset: body.offset, p_digest: body.digest }
    } else {
      if (!['get', 'put', 'delete'].includes(body.op) || !isKey(body.key) ||
        body.op === 'put' && !Object.hasOwn(body, 'value')) return failure(400, 'bad_param')
      args = body.op === 'put' ? { p_key: body.key, p_value: body.value } : { p_key: body.key }
    }

    try {
      const response = await rdb.rpc('weshirt_site_store_' + body.op, args)
      if (response?.error) throw siteStoreUnavailable()
      const result = unwrap(response?.data)
      const output = reply(200, response.data, eventId)
      if (size(output.body) <= maxBodyBytes) return output
      if (body.op === 'get' && result?.found === true)
        return reply(200, { protocolVersion: 1, ok: true, result: { found: true, chunked: true } }, eventId)
      return failure(503, 'site_store_unavailable')
    } catch { return failure(503, 'site_store_unavailable') }
  }
}
