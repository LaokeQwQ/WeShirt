// 运营规则仅依赖标准 Web API。不同页面读取健康投影时不会增加确认次数。
import { applyRegisteredAvailability } from './availability.js'
import { currentDormCatalog, enabledMachineBoard, filterDormFloors } from './buildings.js'
import { upstreamQueryFailure } from './upstream-query.js'
import { mobileDigest } from './mobile-auth.js'
import { claimNotificationDelivery } from './notification-delivery.js'
const MINUTE = 60000
// 容忍短暂抓取失败和调度抖动；超过窗口统一显示过期。
const FRESH_MS = 7 * MINUTE
const locks = new WeakMap()
export const DEFAULT_OPERATIONS_CONFIG = Object.freeze({ broadcast: { enabled: true, startHour: 8, endHour: 22, hours: [] } })

export async function withOperationLock(store, key, task) {
  let pending = locks.get(store)
  if (!pending) { pending = new Map(); locks.set(store, pending) }
  const previous = pending.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  pending.set(key, current)
  try { return await current }
  finally { if (pending.get(key) === current) pending.delete(key) }
}

export function normalizeOperationsConfig(input = {}) {
  const value = input.broadcast || {}
  const hour = (n) => Number.isInteger(n) && n >= 0 && n <= 23
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('群播报开关必须是布尔值')
  const startHour = value.startHour ?? 8
  const endHour = value.endHour ?? 22
  if (!hour(startHour) || !hour(endHour) || startHour > endHour) throw new Error('播报时段须为同一天的 0~23 时，开始不能晚于结束')
  const hours = value.hours ?? []
  if (!Array.isArray(hours) || hours.some((n) => !hour(n)) || hours.length > 24) throw new Error('播报小时须为 0~23 的整数列表')
  return { broadcast: { enabled: value.enabled ?? true, startHour, endHour, hours: [...new Set(hours)].sort((a, b) => a - b) } }
}

function machines(board) { return (board?.floors || []).flatMap((floor) => floor.machines || []) }
function freshSnapshot(board, now) {
  if (upstreamQueryFailure(board) !== null) return null
  const at = Date.parse(board?.updatedAt || '')
  return Number.isFinite(at) && now - at <= FRESH_MS && at <= now + 30000 ? at : null
}
function projectBoard(board, transform) {
  const result = { ...board, floors: (board?.floors || []).map((floor) => ({ ...floor, machines: (floor.machines || []).map(transform) })) }
  const list = machines(result)
  for (const state of ['idle', 'occupied', 'faulty', 'unknown']) result[state] = list.filter((m) => m.state === state || (state === 'occupied' && m.state === 'abnormal')).length
  result.total = list.length
  return result
}

export function evaluateMachineHealth(board, previousState = {}, now = Date.now()) {
  const snapshotAt = freshSnapshot(board, now)
  const state = { machines: { ...(previousState?.machines || {}) }, updatedAt: new Date(now).toISOString() }
  for (const machine of machines(board)) {
    const id = String(machine.id)
    const prior = state.machines[id] || { confirmedFault: false, count: 0, candidate: null, lastSnapshotAt: 0 }
    if (snapshotAt === null || upstreamQueryFailure(machine) !== null) {
      state.machines[id] = { ...prior, candidate: null, count: 0, firstAt: null }
      continue
    }
    if (snapshotAt <= (prior.lastSnapshotAt || 0)) continue
    const raw = machine.upstreamState || machine.state
    const next = { ...prior, lastSnapshotAt: snapshotAt, rawState: machine.rawState, upstreamState: raw }
    const candidate = raw === 'faulty' ? 'fault' : ['idle', 'occupied', 'abnormal'].includes(raw) ? 'healthy' : null
    if (!candidate) { next.candidate = null; next.count = 0; next.firstAt = null }
    else if (candidate !== prior.candidate || !prior.firstAt) {
      next.candidate = candidate
      next.count = 1
      next.firstAt = snapshotAt
    } else if (snapshotAt - prior.firstAt >= 30000) next.count = Math.min(2, (prior.count || 1) + 1)
    if (next.count >= 2) next.confirmedFault = candidate === 'fault'
    if (next.confirmedFault && (!prior.confirmedFault || !prior.faultEventId)) {
      next.faultEventId = 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
      next.faultSince = new Date(snapshotAt).toISOString()
    }
    state.machines[id] = next
  }
  // 健康表只保留最近一次看板中的设备，避免已下线设备无限增长。
  const present = new Set(machines(board).map((m) => String(m.id)))
  for (const id of Object.keys(state.machines)) if (!present.has(id)) delete state.machines[id]
  return { board: applyMachineHealth(board, state, now), health: state }
}

export function applyMachineHealth(board, health = {}, now = Date.now()) {
  const fresh = freshSnapshot(board, now) !== null
  return projectBoard(board, (machine) => {
    const record = health.machines?.[String(machine.id)]
    const upstreamState = machine.upstreamState || machine.state
    const queryFailed = upstreamQueryFailure(board) !== null || upstreamQueryFailure(machine) !== null
    const confirmedFault = !queryFailed && Boolean(record?.confirmedFault)
    const suspect = upstreamState === 'faulty' && !confirmedFault
    return { ...machine, upstreamState, state: !fresh || queryFailed ? 'unknown' : confirmedFault ? 'faulty' : suspect ? 'unknown' : upstreamState,
      health: { confirmedFault, suspectedFault: !queryFailed && suspect, recovering: confirmedFault && ['idle', 'occupied'].includes(upstreamState), stale: !fresh || queryFailed,
        ...(queryFailed ? { queryFailed: true } : {}), ...(confirmedFault ? { eventId: record.faultEventId, faultSince: record.faultSince } : {}),
        label: queryFailed ? '上游查询失败，等待重试' : !fresh ? '数据已过期，等待更新' : suspect ? '故障待复核' : confirmedFault && upstreamState !== 'faulty' ? '恢复待复核' : confirmedFault ? '故障已确认' : '' } }
  })
}

export function meaningfulBoardHash(board, previousHash) {
  let previous = []
  try { previous = JSON.parse(previousHash || '[]') } catch { /* 首次无历史 */ }
  const previousById = new Map(Array.isArray(previous) ? previous.map((row) => [row[0], row]) : [])
  // 未知/复核中的故障不能当作新故障群通知；保留上次已确认的有意义状态。
  const rows = machines(board).map((m) => ['idle', 'occupied', 'abnormal', 'faulty'].includes(m.state) && !m.health?.suspectedFault
    ? [String(m.id), m.state, Boolean(m.suspectedUncollected)] : previousById.get(String(m.id))).filter(Boolean).sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify(rows)
}

export function broadcastWindow(config, now = Date.now()) {
  const d = new Date(now + 8 * 3600000)
  const hour = d.getUTCHours()
  const minute = d.getUTCMinutes()
  const b = config.broadcast || {}
  const hours = b.hours?.length ? b.hours : Array.from({ length: (b.endHour ?? 22) - (b.startHour ?? 8) + 1 }, (_, i) => i + (b.startHour ?? 8))
  if (!b.enabled || !hours.includes(hour) || minute >= 10) return null
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}`
}

export function broadcastReviewWindow(config, now = Date.now()) {
  return new Date(now + 8 * 3600000).getUTCMinutes() === 59 ? broadcastWindow(config, now + MINUTE) : null
}

// A failed upstream request breaks the sequence of hardware observations.
// Keep confirmed history, but do not combine faults across a 405/timeout gap.
export async function resetHealthObservation(store, bid, { now = Date.now(), status = 0, eventId } = {}) {
  return withOperationLock(store, `run:${bid}`, async () => {
    const prior = await store.get(`operations:health:${bid}`, {})
    const health = { ...prior, machines: Object.fromEntries(Object.entries(prior?.machines || {}).map(([id, row]) => [id, { ...row, candidate: null, count: 0, firstAt: null }])),
      lastQueryFailure: { at: new Date(now).toISOString(), status, eventId } }
    await store.put(`operations:health:${bid}`, health)
  })
}

export async function recordAdminAlert(store, alert, { now = Date.now(), notify } = {}) {
  return withOperationLock(store, 'alerts', async () => {
    const key = String(alert.key || `${alert.kind || 'system'}:${alert.title || ''}`).slice(0, 160)
    const list = (await store.get('operations:alerts', [])) || []
    const existing = list.find((item) => item.key === key && !item.resolvedAt)
    const entry = existing || { id: 'alert_' + crypto.randomUUID(), key, at: new Date(now).toISOString(), count: 0, readAt: null, resolvedAt: null, channels: {} }
    Object.assign(entry, { kind: String(alert.kind || 'system').slice(0, 40), severity: ['info', 'warn', 'error'].includes(alert.severity) ? alert.severity : 'warn', title: String(alert.title || '运营告警').slice(0, 100), message: String(alert.message || '').slice(0, 500), lastAt: new Date(now).toISOString(), count: entry.count + 1 })
    // 未解决同类告警合并，通知每小时最多一次；再次通知失败仍记录明确结果。
    if (notify && (!entry.lastNotifyAt || now - Date.parse(entry.lastNotifyAt) >= 3600000)) {
      try { entry.channels = await notify(entry) || { dm: { ok: false, error: '通知通道未返回结果' } } }
      catch (e) { entry.channels = { dm: { ok: false, error: String(e?.message || e).slice(0, 160) } } }
      entry.lastNotifyAt = new Date(now).toISOString()
    }
    const next = [entry, ...list.filter((item) => item.id !== entry.id)].slice(0, 100)
    await store.put('operations:alerts', next)
    return entry
  })
}

export function buildQueueSchedule(queue, machineList, now = Date.now()) {
  const byId = new Map(machineList.map((m) => [String(m.id), m]))
  const cursors = new Map()
  const positions = new Map()
  const uncertain = new Map()
  return queue.map((entry) => {
    const id = String(entry.machineId)
    const machine = byId.get(id)
    const defaultMin = machine?.kind === 'dryer' || String(machine?.name || '').includes('烘干') ? 60 : 30
    if (!cursors.has(id)) {
      const finishAt = Date.parse(machine?.finishAt || '')
      const running = ['occupied', 'abnormal'].includes(machine?.state)
      const available = machine?.state === 'idle' && !machine?.suspectedUncollected
      const base = running && Number.isFinite(finishAt) && finishAt > now ? finishAt : available ? now : now + defaultMin * MINUTE
      cursors.set(id, base)
      uncertain.set(id, !available && !(running && Number.isFinite(finishAt) && finishAt > now))
    }
    const start = cursors.get(id)
    const requested = Number(entry.durationMin)
    const durationMin = Number.isInteger(requested) && requested >= 10 && requested <= 180 ? requested : defaultMin
    const position = (positions.get(id) || 0) + 1
    positions.set(id, position)
    const end = start + durationMin * MINUTE
    cursors.set(id, end)
    return { ...entry, position, durationMin, startAt: new Date(start).toISOString(), eta: new Date(start).toISOString(), endAt: new Date(end).toISOString(), waitMin: Math.max(0, Math.ceil((start - now) / MINUTE)), estimated: true, uncertain: uncertain.get(id) }
  })
}

export async function runOperations({ store, board, env = {}, now = Date.now(), broadcast, broadcastTargets, notify, beforeNotify, reviewRequired = false, atomicStore }) {
  const bid = env.BUILDING_ID || board?.buildingId || 'b1'
  return withOperationLock(store, `run:${bid}`, async () => {
    const previous = await store.get(`operations:health:${bid}`, {})
    const result = evaluateMachineHealth(board, previous, now)
    const health = result.health
    let projected = result.board
    await store.put(`operations:health:${bid}`, health)
    const occupancy = (await store.get(`occupancy:${bid}`, {})) || {}
    const users = [...new Set(Object.values(occupancy).map((o) => o?.userId).filter(Boolean))]
    const tasksByUser = new Map(await Promise.all(users.map(async (id) => [id, await store.get(`tasks:${id}`, [])])))
    projected = projectBoard(projected, (machine) => {
      const o = occupancy[machine.id]
      const task = o && (tasksByUser.get(o.userId) || []).find((t) => String(t.machineId) === String(machine.id) && (!o.taskId || t.id === o.taskId) && !t.done && !t.takenAt)
      const suspectedUncollected = Boolean(task && Date.parse(task.endAt) <= now - 5 * MINUTE && !['occupied', 'abnormal', 'faulty'].includes(machine.state) && !machine.health?.stale)
      return { ...machine, suspectedUncollected }
    })
    projected = applyRegisteredAvailability(projected, { occupancy, tasksByUser, now })
    // The projected state is ready now; external delivery must not delay its commit.
    if (typeof beforeNotify === 'function') await beforeNotify(projected)
    const alerts = []
    for (const m of machines(projected)) {
      if (m.health?.confirmedFault && !previous.machines?.[String(m.id)]?.confirmedFault) {
        // Hardware faults have scoped volunteer/occupant delivery, never the
        // global system-alert recipient. Keep an auditable management record.
        alerts.push(await recordAdminAlert(store, { key: `fault:${bid}:${m.id}`, kind: 'machine_fault', severity: 'warn', title: '设备故障已复核', message: `${m.name || m.id} 在两次独立快照中持续故障，请现场确认。事件 ${m.health.eventId}` }, { now }))
      }
    }
    const config = normalizeOperationsConfig(await store.get('operations:config', DEFAULT_OPERATIONS_CONFIG))
    const hourKey = broadcastWindow(config, now)
    const reviewKey = `operations:broadcast-review:${bid}`
    const reviewHour = broadcastReviewWindow(config, now)
    const snapshotAt = freshSnapshot(board, now)
    if (reviewRequired && reviewHour && snapshotAt !== null && now - snapshotAt < MINUTE) {
      await store.put(reviewKey, { hourKey: reviewHour, snapshotAt, checkedAt: now })
    }
    let reviewed = !reviewRequired
    if (reviewRequired && hourKey && snapshotAt !== null) {
      const review = await store.get(reviewKey, {})
      const hourAt = Date.parse(hourKey + ':00:00+08:00')
      reviewed = review.hourKey === hourKey && (review.snapshotAt >= hourAt - MINUTE && review.snapshotAt < hourAt
        || now - review.checkedAt >= MINUTE && snapshotAt > review.snapshotAt)
      // Missing scheduler ticks must not turn into an unreviewed broadcast.
      // Check now, then require a new independent snapshot at least a minute later.
      if (!reviewed && review.hourKey !== hourKey) await store.put(reviewKey, { hourKey, snapshotAt, checkedAt: now })
    }
    let broadcastResult = { sent: false, reason: hourKey ? 'not_sent' : 'outside_window' }
    if (hourKey && reviewRequired && !reviewed) broadcastResult.reason = 'awaiting_recheck'
    if (hourKey && reviewed && snapshotAt !== null) {
      const targets = typeof broadcastTargets === 'function' ? await broadcastTargets() : [{}]
      const deliveries = []
      for (const target of targets) {
        const key = `operations:broadcast:${bid}${target.key ? ':' + target.key : ''}`
        const last = (await store.get(key, {})) || {}
        const catalog = await currentDormCatalog(store, env.SITE_BUILDINGS)
        const scoped = (catalog) => {
          const enabled = enabledMachineBoard(projected, catalog)
          return target.dormBuilding ? projectBoard({ ...enabled, floors: filterDormFloors(enabled, target.dormBuilding, catalog) }, m => m) : enabled
        }
        const hash = meaningfulBoardHash(scoped(catalog), last.successHash)
        broadcastResult = { sent: false, reason: 'not_sent' }
        if (last.checkedHour === hourKey && (last.success || last.unchanged)) broadcastResult.reason = 'already_checked'
        else if (hash === '[]' || last.successHash === hash) {
          await store.put(key, { ...last, checkedHour: hourKey, unchanged: true, success: false })
          broadcastResult.reason = 'unchanged'
        } else if (Number(last.retryAfter || 0) > now) broadcastResult.reason = 'retry_cooldown'
        else if (typeof broadcast !== 'function') broadcastResult.reason = 'not_configured'
        else {
          const attempt = { ...last, checkedHour: hourKey, unchanged: false, success: false, retryAfter: now + MINUTE, attemptAt: now }
          await store.put(key, attempt)
          let claim
          try {
            // Site configuration can change while an earlier notification awaits
            // I/O. Recheck just before handing the public summary to its sender.
            const current = scoped(await currentDormCatalog(store, env.SITE_BUILDINGS))
            const currentHash = meaningfulBoardHash(current, last.successHash)
            const targetCurrent = typeof broadcastTargets !== 'function' || (await broadcastTargets()).some(t => t.key === target.key && t.dormBuilding === target.dormBuilding && t.via === target.via && t.conversationId === target.conversationId)
            const currentConfig = normalizeOperationsConfig(await store.get('operations:config', DEFAULT_OPERATIONS_CONFIG))
            if (!targetCurrent || broadcastWindow(currentConfig, now) !== hourKey) broadcastResult.reason = 'configuration_changed'
            else if (currentHash === '[]' || last.successHash === currentHash) {
              await store.put(key, { ...attempt, unchanged: true, retryAfter: 0 })
              broadcastResult.reason = 'unchanged'
            } else {
              const broadcastBoard = projectBoard({ ...current, floors: current.floors.map((floor) => ({ ...floor, machines: floor.machines.filter((m) => m.state !== 'unknown' && !m.health?.suspectedFault) })) }, (m) => m)
              claim = await claimNotificationDelivery(atomicStore, 'mobile:limit:group-delivery:' + await mobileDigest(`${bid}|${target.key || 'legacy'}|${target.conversationId || target.via || ''}`), hourKey, now, {stateHash:currentHash})
              if (!claim) broadcastResult = {sent:false,reason:'delivery_claimed'}
              else {
                const sent = await broadcast({ board: broadcastBoard, hourKey, config, target })
                if (!sent?.ok) throw new Error(sent?.error || sent?.err || '群播报发送失败')
                await claim.finish(true)
                await store.put(key, { ...attempt, success: true, successHash: currentHash, successAt: new Date(now).toISOString(), retryAfter: 0 })
                broadcastResult = { sent: true, hourKey }
              }
            }
          } catch (e) {
            await claim?.finish(false).catch(() => {})
            broadcastResult = { sent: false, reason: 'failed', error: String(e?.message || e).slice(0, 160) }
            await store.put(key, { ...attempt, error: broadcastResult.error })
            alerts.push(await recordAdminAlert(store, { key: 'broadcast:' + bid + ':' + (target.key || 'legacy'), kind: 'notification', severity: 'warn', title: '整点群播报未送达', message: broadcastResult.error }, { now, notify }))
          }
        }
        deliveries.push({ ...broadcastResult, building: target.dormBuilding || null })
      }
      if (typeof broadcastTargets === 'function') broadcastResult = { sent: deliveries.some(d => d.sent), reason: deliveries.some(d => d.sent) ? 'sent' : deliveries[0]?.reason || 'not_configured', deliveries }
    }
    return { board: projected, health, broadcast: broadcastResult, alerts }
  })
}
