import { telemetryErrorKind, telemetryEventId } from '../../packages/core/telemetry.js'

const objectLike = (value) => value !== null && (typeof value === 'object' || typeof value === 'function')
function field(value, key) { try { return objectLike(value) ? value[key] : undefined } catch { return undefined } }
function validStatus(value) { return Number.isInteger(value) && (value === 0 || value >= 100 && value <= 599) ? value : 0 }

export function newClientTraceId(random = globalThis.crypto) {
  const bytes = new Uint8Array(12)
  try { random.getRandomValues(bytes) }
  catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256) }
  return 'client_' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

// Store object identities only. Never read message, stack, cause, URLs or event text.
export function createClientErrorReporter({ track, enabled = () => true, logger = globalThis.console, random = globalThis.crypto } = {}) {
  const seen = new WeakMap()
  return function report(error, { kind, identity } = {}) {
    const key = objectLike(error) ? error : objectLike(identity) ? identity : null
    if (key && seen.has(key)) return seen.get(key)
    const trace = Object.freeze({
      eventId: telemetryEventId(field(error, 'eventId')) || newClientTraceId(random),
      status: validStatus(field(error, 'status')),
      kind: telemetryErrorKind(kind || field(error, 'name')),
    })
    if (key) seen.set(key, trace)
    // Correlation on the Error is best-effort; frozen/foreign objects still dedupe.
    if (objectLike(error)) {
      try { Object.assign(error, { eventId: trace.eventId, status: trace.status }) } catch { /* WeakMap remains authoritative. */ }
    }
    try { logger?.error?.(`[WeShirt client] event=${trace.eventId} status=${trace.status} kind=${trace.kind}`) } catch { /* Logging must not cause another error. */ }
    try { if (enabled()) track?.('client_error', trace) } catch { /* Diagnostics never interrupt the app. */ }
    return trace
  }
}
