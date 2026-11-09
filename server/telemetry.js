import { apiErr, json } from '../packages/core/util.js'
import { normalizeDormBuilding } from '../packages/core/buildings.js'
import { normalizeTelemetryEvent, telemetryDay, emptyTelemetryBucket, addTelemetry, summarizeTelemetry, RETENTION_DAYS } from '../packages/core/telemetry.js'

const queues = new WeakMap()
const limits = new WeakMap()
const cleanups = new WeakMap()
const DAY_MS = 86400000

function serialized(store, operation) {
  const job = (queues.get(store) || Promise.resolve()).catch(() => {}).then(operation)
  queues.set(store, job)
  job.finally(() => { if (queues.get(store) === job) queues.delete(store) }).catch(() => {})
  return job
}

export function registerTelemetryRoutes(app, { store, checkAdmin }) {
  app.post('/api/telemetry', async (c) => {
    try {
      // 限制真实读入的字节数（不信 Content-Length），避免遥测挤占业务资源。
      const reader = c.req.raw.body?.getReader()
      if (!reader) return apiErr('bad_param', '缺少遥测数据')
      const chunks = []
      let length = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 16384) { await reader.cancel(); return apiErr('too_large', '遥测批次过大', 413) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      let body
      try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return apiErr('bad_param', '遥测格式错误') }
      if (!Array.isArray(body?.events) || body.events.length < 1 || body.events.length > 20) return apiErr('bad_param', '每批需要1–20条事件')
      const now = Date.now()
      let limiter = limits.get(store)
      if (!limiter || now - limiter.at >= 60000) limits.set(store, (limiter = { at: now, count: 0 }))
      if (++limiter.count > 120) return apiErr('rate_limited', '稍后再提交', 429)
      const events = body.events.map(normalizeTelemetryEvent).filter(Boolean)
      if (!events.length) return json({ accepted: 0 }, 202)
      const accepted = await serialized(store, async () => {
        const day = telemetryDay(now)
        const key = `telemetryday:${day}`
        const record = await store.get(key, null) || { day, scopes: {} }
        record.scopes.all ||= emptyTelemetryBucket()
        let count = 0
        for (const event of events) {
          if (record.scopes.all.received >= 20000) break
          addTelemetry(record.scopes.all, event, now)
          const dorm = event.dorm || 'unselected'
          record.scopes[dorm] ||= emptyTelemetryBucket()
          addTelemetry(record.scopes[dorm], event, now)
          count++
        }
        if (count) await store.put(key, record)
        if (!cleanups.has(store) || now - cleanups.get(store) > DAY_MS) {
          cleanups.set(store, now)
          const cutoff = telemetryDay(now - (RETENTION_DAYS - 1) * DAY_MS)
          const old = await store.list('telemetryday:').catch(() => [])
          await Promise.all(old.filter((entry) => /^telemetryday:\d{4}-\d{2}-\d{2}$/.test(entry.key) && entry.key.slice(13) < cutoff).map((entry) => store.del(entry.key)))
        }
        return count
      })
      return json({ accepted }, 202, { 'Cache-Control': 'no-store' })
    } catch {
      // 不回传可能含请求内容的异常，客户端遥测失败也不影响业务。
      return apiErr('telemetry_unavailable', '遥测暂不可用', 503)
    }
  })

  app.get('/api/admin/telemetry', async (c) => {
    if (!(await checkAdmin(c))) return apiErr('unauthorized', '后台会话已失效', 401)
    const rawDays = c.req.query('days') || '7'
    const days = Number(rawDays)
    const dorm = c.req.query('dorm') || ''
    if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS || (dorm && !normalizeDormBuilding(dorm))) return apiErr('bad_param', '遥测筛选无效')
    const records = await Promise.all(Array.from({ length: days }, (_, i) => store.get(`telemetryday:${telemetryDay(Date.now() - i * DAY_MS)}`, null)))
    return json(summarizeTelemetry(records.map((record) => record?.scopes?.[dorm || 'all']), days), 200, { 'Cache-Control': 'no-store' })
  })
}
