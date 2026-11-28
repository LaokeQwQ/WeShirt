import { timingSafeEqual } from '../../packages/core/auth.js'
import { readStreamBytes } from '../../packages/core/stream-bytes.js'

const keySize = 512
const pageSize = 100
const requestSize = 16 * 1024
const chunkSize = 256 * 1024
const maxKeys = 8
const maxValue = 25 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= keySize &&
    !key.includes('\0') && encoder.encode(key).length <= keySize
}

function base64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function listKeys(binding, cursor) {
  const page = await binding.list({ limit: pageSize, ...(cursor ? { cursor } : {}) })
  if (!page || page instanceof Error || page.error || page.errors || page.Error) throw new Error()
  const next = page.cursor ?? null
  const complete = page.complete === true || page.complete !== false && !next && Array.isArray(page.keys)
  if ((complete ? Boolean(next) : typeof next !== 'string' || !next || next === cursor || next.length > 2048) ||
      (!Array.isArray(page.keys) && !(complete && page.keys === undefined))) throw new Error()
  const keys = (page.keys ?? []).map(entry => typeof entry === 'string' ? entry : entry?.key ?? entry?.name)
  if (keys.length > pageSize || keys.some(key => !validKey(key)) || new Set(keys).size !== keys.length) throw new Error()
  return { keys, next: complete ? null : next }
}

async function getValues(binding, keys, offset) {
  const rows = []
  const limit = Math.floor(chunkSize / keys.length)
  for (const key of keys) {
    const raw = await binding.get(key, { type: 'arrayBuffer' })
    // The listing is the source of truth. A disappearing value requires a new
    // complete snapshot, and cannot silently become a deleted or empty row.
    if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) throw new Error()
    const bytes = raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    if (bytes.length > maxValue || offset > bytes.length || offset !== 0 && offset === bytes.length) throw new Error()
    rows.push({
      key, offset, bytes: bytes.length, sha256: await digest(bytes),
      data: base64(bytes.subarray(offset, offset + limit)),
    })
  }
  return { rows }
}

/** Read-only export for a frozen, explicitly selected Pages binding. */
export function createEdgeStoreExportHandler({ binding, secret } = {}) {
  return async function exportRequest(request) {
    const eventId = 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    const respond = (status, body) => new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
        'X-Event-ID': eventId,
      },
    })
    const fail = (status, code) => respond(status, { error: { code, status, eventId } })
    if (request.method !== 'POST' || !/^[\x21-\x7e]{32,512}$/.test(secret || '') ||
        !timingSafeEqual(request.headers.get('authorization') || '', 'Bearer ' + secret)) return fail(404, 'not_found')
    if (typeof binding?.get !== 'function' || typeof binding.list !== 'function') return fail(503, 'source_export_unavailable')
    let command
    try {
      const bytes = await readStreamBytes(request.body, requestSize)
      if (!bytes) return fail(413, 'source_export_request_too_large')
      command = JSON.parse(decoder.decode(bytes))
    } catch { return fail(400, 'source_export_invalid_request') }

    try {
      let result
      if (command?.op === 'list' && (command.cursor === null ||
          typeof command.cursor === 'string' && command.cursor.length > 0 && command.cursor.length <= 2048)) {
        result = await listKeys(binding, command.cursor)
      } else if (command?.op === 'get' && Array.isArray(command.keys) &&
          command.keys.length >= 1 && command.keys.length <= maxKeys &&
          command.keys.every(validKey) && new Set(command.keys).size === command.keys.length &&
          Number.isSafeInteger(command.offset) && command.offset >= 0 && command.offset < maxValue &&
          (command.offset === 0 || command.keys.length === 1)) {
        result = await getValues(binding, command.keys, command.offset)
      } else return fail(400, 'source_export_invalid_request')
      return respond(200, { protocolVersion: 1, result })
    } catch { return fail(503, 'source_export_unavailable') }
  }
}
