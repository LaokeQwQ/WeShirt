import { normalizeDormBuilding } from './buildings.js'

export const RETENTION_DAYS = 14
export const TELEMETRY_EVENTS = new Set(['page_view', 'api_request', 'web_vital', 'client_error', 'room_performance', 'room_interaction', 'dorm_select'])
const ROUTES = new Set(['/', '/list', '/display', '/task', '/settings', '/board', '/login', '/social', '/assistant'])
const ERROR_KINDS = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'NetworkError', 'UnhandledRejection', 'resource', 'vue', 'webgl'])
const API_PATHS = new Set(['/api/machines', '/api/tasks', '/api/tasks/:id', '/api/tasks/:id/take', '/api/auth', '/api/auth/me', '/api/auth/claim', '/api/user/profile', '/api/user/notify', '/api/messages', '/api/queue', '/api/occupancy', '/api/mapping', '/api/marks', '/api/faults/recover', '/api/urge', '/api/dryer/stuck', '/api/push/key', '/api/push/subscribe', '/api/other'])
const LATENCY_BOUNDS = [100, 300, 600, 1000, 2000, 5000, 10000, 30000, 60000]
const finite = (value, max, min = 0) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const round = (n) => Math.round(n * 100) / 100

export function telemetryRoute(value) {
  const path = typeof value === 'string' ? value.split(/[?#]/)[0] : ''
  return ROUTES.has(path) ? path : null
}

export function telemetryEndpoint(value) {
  const path = typeof value === 'string' ? value.split(/[?#]/)[0] : ''
  if (path.startsWith('/api/admin') || path.startsWith('/api/telemetry')) return null
  if (/^\/api\/tasks\/[^/]+\/take$/.test(path)) return '/api/tasks/:id/take'
  if (/^\/api\/tasks\/[^/]+$/.test(path)) return '/api/tasks/:id'
  return API_PATHS.has(path) ? path : '/api/other'
}

// 严格构造字段，绝不序列化调用者传入的任意对象/文本。
export function normalizeTelemetryEvent(raw) {
  if (!raw || !TELEMETRY_EVENTS.has(raw.name)) return null
  const route = telemetryRoute(raw.route)
  if (!route) return null
  const event = { name: raw.name, route, dorm: normalizeDormBuilding(raw.dorm) }
  if (raw.name === 'api_request') {
    const endpoint = telemetryEndpoint(raw.endpoint)
    if (!endpoint || !finite(raw.durationMs, 60000) || !Number.isInteger(raw.status) || raw.status < 0 || raw.status > 599) return null
    Object.assign(event, { endpoint, durationMs: Math.round(raw.durationMs), status: raw.status })
  } else if (raw.name === 'web_vital') {
    if (!['lcp', 'cls', 'inp'].includes(raw.metric) || !finite(raw.value, raw.metric === 'cls' ? 20 : 60000)) return null
    Object.assign(event, { metric: raw.metric, value: round(raw.value) })
  } else if (raw.name === 'client_error') {
    event.kind = ERROR_KINDS.has(raw.kind) ? raw.kind : 'Error'
  } else if (raw.name === 'room_performance') {
    if (!finite(raw.fps, 240) || !finite(raw.drawCalls, 10000) || !finite(raw.triangles, 10000000) || !['low', 'mid', 'high'].includes(raw.quality)) return null
    Object.assign(event, { fps: round(raw.fps), drawCalls: Math.round(raw.drawCalls), triangles: Math.round(raw.triangles), quality: raw.quality })
    if (finite(raw.durationMs, 60000)) event.durationMs = Math.round(raw.durationMs)
  } else if (raw.name === 'room_interaction') {
    if (!['select', 'reset', 'quality', 'fallback'].includes(raw.action)) return null
    event.action = raw.action
    if (['washer', 'dryer'].includes(raw.kind)) event.kind = raw.kind
  }
  return event
}

export function telemetryDay(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10)
}

export function emptyTelemetryBucket() {
  return { received: 0, pageViews: 0, errors: 0, api: { count: 0, failed: 0, sum: 0, histogram: Array(LATENCY_BOUNDS.length).fill(0) }, vitals: { lcp: [0, 0], cls: [0, 0], inp: [0, 0] }, room: { samples: 0, fps: 0, drawCalls: 0, triangles: 0, quality: {} }, routes: {}, buildings: {}, recentErrors: [] }
}

export function addTelemetry(bucket, event, now) {
  bucket.received++
  const dorm = event.dorm || 'unselected'
  bucket.buildings[dorm] = (bucket.buildings[dorm] || 0) + 1
  if (event.name === 'page_view') {
    bucket.pageViews++
    bucket.routes[event.route] = (bucket.routes[event.route] || 0) + 1
  } else if (event.name === 'api_request') {
    bucket.api.count++
    bucket.api.failed += event.status === 0 || event.status >= 400 ? 1 : 0
    bucket.api.sum += event.durationMs
    bucket.api.histogram[LATENCY_BOUNDS.findIndex((bound) => event.durationMs <= bound)]++
  } else if (event.name === 'web_vital') {
    bucket.vitals[event.metric][0] += event.value
    bucket.vitals[event.metric][1]++
  } else if (event.name === 'room_performance') {
    bucket.room.samples++
    bucket.room.fps += event.fps
    bucket.room.drawCalls += event.drawCalls
    bucket.room.triangles += event.triangles
    bucket.room.quality[event.quality] = (bucket.room.quality[event.quality] || 0) + 1
  }
  if (event.name === 'client_error' || (event.name === 'api_request' && (event.status === 0 || event.status >= 500))) {
    bucket.errors++
    bucket.recentErrors.push({ at: new Date(now).toISOString(), route: event.route, kind: event.kind || 'NetworkError', ...(event.status != null ? { status: event.status } : {}) })
    bucket.recentErrors = bucket.recentErrors.slice(-20)
  }
}

export function summarizeTelemetry(buckets, days) {
  const merged = emptyTelemetryBucket()
  for (const bucket of buckets.filter(Boolean)) {
    for (const key of ['received', 'pageViews', 'errors']) merged[key] += bucket[key] || 0
    for (const key of ['count', 'failed', 'sum']) merged.api[key] += bucket.api?.[key] || 0
    merged.api.histogram = merged.api.histogram.map((n, i) => n + (bucket.api?.histogram?.[i] || 0))
    for (const metric of ['lcp', 'cls', 'inp']) for (let i = 0; i < 2; i++) merged.vitals[metric][i] += bucket.vitals?.[metric]?.[i] || 0
    for (const key of ['samples', 'fps', 'drawCalls', 'triangles']) merged.room[key] += bucket.room?.[key] || 0
    for (const [key, count] of Object.entries(bucket.room?.quality || {})) merged.room.quality[key] = (merged.room.quality[key] || 0) + count
    for (const key of ['routes', 'buildings']) for (const [name, count] of Object.entries(bucket[key] || {})) merged[key][name] = (merged[key][name] || 0) + count
    merged.recentErrors.push(...(bucket.recentErrors || []))
  }
  let rank = Math.ceil(merged.api.count * .95)
  let p95 = null
  for (let i = 0; merged.api.count && i < LATENCY_BOUNDS.length; i++) {
    rank -= merged.api.histogram[i]
    if (rank <= 0) { p95 = LATENCY_BOUNDS[i]; break }
  }
  const avg = (sum, count) => count ? round(sum / count) : null
  return {
    days, received: merged.received, pageViews: merged.pageViews, errors: merged.errors,
    api: { count: merged.api.count, failed: merged.api.failed, avgMs: avg(merged.api.sum, merged.api.count), p95Ms: p95 },
    vitals: { lcpMs: avg(...merged.vitals.lcp), cls: avg(...merged.vitals.cls), inpMs: avg(...merged.vitals.inp) },
    room: { samples: merged.room.samples, avgFps: avg(merged.room.fps, merged.room.samples), avgDrawCalls: avg(merged.room.drawCalls, merged.room.samples), avgTriangles: avg(merged.room.triangles, merged.room.samples), quality: merged.room.quality },
    routes: Object.entries(merged.routes).map(([route, views]) => ({ route, views })).sort((a, b) => b.views - a.views),
    buildings: Object.entries(merged.buildings).map(([code, count]) => ({ code, count })),
    recentErrors: merged.recentErrors.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20), retentionDays: RETENTION_DAYS,
  }
}
