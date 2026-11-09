import { randomBytes } from 'node:crypto'
import { createHaierClient } from '../../../packages/core/haier.js'

export const TIMEOUT_MS = 30000
const MAX_UPSTREAM_BYTES = 1024 * 1024
const MAX_EDGE_BYTES = 64 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 256 * 1024
const eventPattern = /^evt_[a-f0-9]{24}$/

class AdapterError extends Error {
  constructor(reason, status = 0, eventId = null) {
    super(reason)
    this.reason = reason
    this.status = status
    this.eventId = eventId
  }
}

const traceId = () => 'trigger_' + randomBytes(12).toString('hex')
const fail = (reason, status = 0, eventId = null) => new AdapterError(reason, status, eventId)
const safeFailure = (error, fallback, eventId) => ({
  reason: error instanceof AdapterError ? error.reason : fallback,
  status: error instanceof AdapterError ? error.status : 0,
  eventId: error instanceof AdapterError && error.eventId || eventId,
})

function endpoint(value, path) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw fail('invalid_endpoint') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== path) throw fail('invalid_endpoint')
  return url
}

export function readConfig(env = {}) {
  const key = String(env.WESHIRT_SYNC_KEY || env.SYNC_KEY || '').trim()
  if (!key) throw fail('missing_sync_key')
  const ingest = endpoint(env.WESHIRT_INGEST_URL || env.INGEST_URL, '/api/cron/ingest')
  const syncValue = env.WESHIRT_SYNC_URL || env.SYNC_URL
  const sync = syncValue ? endpoint(syncValue, '/api/cron/sync') : null
  if (sync && sync.origin !== ingest.origin) throw fail('endpoint_origin_mismatch')
  let upstream
  try { upstream = new URL(String(env.HAIER_URL || '').trim()) } catch { throw fail('invalid_upstream') }
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.origin === ingest.origin) throw fail('invalid_upstream')
  return { key, ingest, sync, upstream }
}

function deadline(milliseconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), milliseconds)
  return { signal: controller.signal, stop: () => { clearTimeout(timer); controller.abort() } }
}

// Race the body reads as well as response headers: a silent socket cannot extend the budget.
function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(fail('timeout'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('timeout'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function boundedBody(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.body?.cancel().catch(() => {})
    throw fail('response_too_large', response.status)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw fail('response_too_large', response.status)
      chunks.push(value)
    }
  } catch (error) {
    reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function restrictedFetch(fetchImpl, { origin, signal, maxBytes, total, failure }) {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.hash) throw fail('request_origin_mismatch')
    const controller = new AbortController()
    const abort = () => controller.abort()
    const signals = [signal, init.signal].filter(Boolean)
    for (const item of signals) {
      if (item.aborted) controller.abort()
      else item.addEventListener('abort', abort, { once: true })
    }
    let responseStatus = 0, responseEventId = null
    try {
      if (controller.signal.aborted) throw fail('timeout')
      const response = await abortable(fetchImpl(url.toString(), { ...init, signal: controller.signal, redirect: 'manual' }), controller.signal)
      const supplied = response.headers.get('x-event-id')
      const eventId = supplied && eventPattern.test(supplied) ? supplied : null
      responseStatus = response.status
      responseEventId = eventId
      if (response.status >= 300 && response.status < 400) {
        response.body?.cancel().catch(() => {})
        throw fail('redirect_rejected', response.status, eventId)
      }
      const bytes = await boundedBody(response, maxBytes, controller.signal)
      total.bytes += bytes.byteLength
      if (total.bytes > MAX_TOTAL_BYTES) throw fail('response_too_large', response.status, eventId)
      failure.lastStatus = response.status
      return new Response(bytes, { status: response.status, headers: response.headers })
    } catch (error) {
      const safe = error instanceof AdapterError ? error : fail(controller.signal.aborted ? 'timeout' : 'network_error')
      if (!safe.status && responseStatus) safe.status = responseStatus
      if (!safe.eventId && responseEventId) safe.eventId = responseEventId
      failure.lastError = safe
      throw safe
    } finally {
      for (const item of signals) item.removeEventListener('abort', abort)
    }
  }
}

// Never forward normalized labels as raw state codes or discard malformed rows.
export function ingestRows(machines) {
  if (!Array.isArray(machines) || !machines.length || machines.length > 500) throw fail('snapshot_invalid')
  const seen = new Set()
  return machines.map((machine) => {
    const id = String(machine?.id ?? '').trim()
    const raw = machine?.rawState
    const state = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : NaN
    if (!id || id.length > 128 || seen.has(id) || !Number.isSafeInteger(state)) throw fail('snapshot_invalid')
    seen.add(id)
    let finishTime = null
    if (machine.finishAt != null) {
      const time = Date.parse(machine.finishAt)
      if (!Number.isFinite(time)) throw fail('snapshot_invalid')
      finishTime = new Date(time).toISOString()
    }
    return { id, name: String(machine.name ?? '').slice(0, 64), floorCode: String(machine.floorCode ?? '').slice(0, 8), state, finishTime }
  })
}

async function postEdge(fetchImpl, target, body, mode, eventId) {
  const response = await fetchImpl(target.toString(), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  })
  const supplied = response.headers.get('x-event-id')
  const trace = supplied && eventPattern.test(supplied) ? supplied : eventId
  if (!response.ok) throw fail('http_error', response.status, trace)
  let data
  try { data = JSON.parse(await response.text()) } catch { throw fail('invalid_response', response.status, trace) }
  // sync's existing contract is {error:null,fetched,...}; ingest additionally returns ok.
  const succeeded = data && data.ok !== false && !data.error && (data.ok === true || mode === 'fallback' && data.error === null && Number.isInteger(data.fetched) && data.fetched > 0)
  if (!succeeded) throw fail('business_error', response.status, trace)
  return { status: response.status, eventId: trace }
}

export async function runIngest(env = {}, { fetch: fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const eventId = traceId()
  let config
  try { config = readConfig(env) } catch (error) { return { ok: false, mode: 'none', snapshotComplete: false, ...safeFailure(error, 'invalid_config', eventId) } }
  const budget = Math.max(1, Math.min(TIMEOUT_MS, Number(timeoutMs) || TIMEOUT_MS))
  const overall = deadline(budget)
  // Reserve five seconds for ingest/fallback under the fixed thirty-second function budget.
  const scrape = deadline(Math.max(1, budget - Math.min(5000, budget / 3)))
  const total = { bytes: 0 }, upstream = {}, edge = {}
  const upstreamFetch = restrictedFetch(fetchImpl, { origin: config.upstream.origin, signal: scrape.signal, maxBytes: MAX_UPSTREAM_BYTES, total, failure: upstream })
  const edgeFetch = restrictedFetch(fetchImpl, { origin: config.ingest.origin, signal: overall.signal, maxBytes: MAX_EDGE_BYTES, total, failure: edge })
  let snapshotComplete = false, initialFailure
  try {
    try {
      const client = createHaierClient({ ...env, HAIER_MODE: 'real' }, { fetch: upstreamFetch })
      let machines
      try { machines = await abortable(client.fetchStatus(), scrape.signal) }
      catch (error) {
        if (scrape.signal.aborted) throw fail('timeout')
        if (upstream.lastError) throw upstream.lastError
        throw fail('upstream_incomplete', upstream.lastStatus || 0)
      }
      const raws = ingestRows(machines)
      snapshotComplete = true
      const body = { k: config.key, raws, source: 'cloudbase' }
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_PAYLOAD_BYTES) throw fail('payload_too_large')
      const sent = await postEdge(edgeFetch, config.ingest, body, 'ingest', eventId)
      return { ok: true, mode: 'ingest', snapshotComplete, fetched: raws.length, ...sent }
    } catch (error) { initialFailure = safeFailure(error, 'upstream_incomplete', eventId) }
    if (!config.sync || overall.signal.aborted) return { ok: false, mode: 'none', snapshotComplete, ...initialFailure }
    try {
      const sent = await postEdge(edgeFetch, config.sync, { k: config.key }, 'fallback', eventId)
      return { ok: true, mode: 'fallback', snapshotComplete, initialFailure, ...sent }
    } catch (error) {
      return { ok: false, mode: 'fallback', snapshotComplete, initialFailure, ...safeFailure(error, 'request_error', eventId) }
    }
  } finally { scrape.stop(); overall.stop() }
}

// CloudBase CommonJS bundle exposes index.main. Never read event arguments as credentials.
export async function main() {
  const result = await runIngest(process.env)
  const failures = result.initialFailure ? [result.initialFailure, ...(!result.ok ? [result] : [])] : !result.ok ? [result] : []
  for (const failure of failures) console.warn(JSON.stringify({ reason: failure.reason, status: failure.status, eventId: failure.eventId }))
  return result
}
