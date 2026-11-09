import { withOperationLock } from './operations.js'
import { buildMachineLabel, hhmm } from './notice.js'

const MINUTE = 60000
const MAX_ATTEMPTS = 4
const MAX_SENDS_PER_RUN = 12
const phaseNames = ['lead', 'end']
const stamp = (value) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN
const iso = (value) => new Date(value).toISOString()

export function activeQueueEntries(queue) {
  return (Array.isArray(queue) ? queue : []).filter((entry) => entry?.userId && entry.machineId && !entry.done && !entry.cancelledAt && !entry.canceledAt && !entry.cancelled && !entry.canceled && !entry.completedAt && !entry.deleted && (!entry.status || ['active', 'waiting', 'queued'].includes(entry.status)))
}

function heads(queue) {
  const result = new Map()
  for (const entry of activeQueueEntries(queue)) if (!result.has(String(entry.machineId))) result.set(String(entry.machineId), entry)
  return result
}

function reservationId(entry) {
  return String(entry.id || JSON.stringify([entry.userId, entry.machineId, entry.at || entry.createdAt || 'legacy']))
}

function rawState(machine, env) {
  const raw = machine.rawState
  if (['idle', 'occupied', 'abnormal', 'faulty', 'unknown'].includes(raw)) return raw
  if (raw != null) {
    let map = { idle: [1], occupied: [2], faulty: [3] }
    try { map = typeof env.HAIER_STATE_MAP === 'string' ? JSON.parse(env.HAIER_STATE_MAP) : env.HAIER_STATE_MAP || map } catch { /* 默认真实状态表 */ }
    for (const state of ['idle', 'occupied', 'faulty']) if (Array.isArray(map[state]) && map[state].some((n) => String(n) === String(raw))) return state
    return 'unknown'
  }
  return machine.upstreamState || machine.state
}

function nextCycle(machine, previous, state, snapshotAt, now) {
  const running = ['occupied', 'abnormal'].includes(state)
  const finishAt = stamp(machine.finishAt)
  const startAt = stamp(machine.startAt || machine.runStartAt)
  if (!running && state !== 'idle') return previous
  if (!running) return previous ? { ...previous, state: 'idle', endedAt: previous.endedAt || snapshotAt, confirmed: true, snapshotAt } : null
  if (!Number.isFinite(finishAt) || finishAt > now + 24 * 60 * MINUTE) return previous && previous.state !== 'idle' ? { ...previous, state, snapshotAt } : null
  const newRun = !previous || previous.state === 'idle' || Number.isFinite(startAt) && previous.startAt && previous.startAt !== startAt
  if (newRun) {
    if (finishAt < now - 30 * MINUTE) return null
    return { id: 'cycle_' + crypto.randomUUID(), startAt: Number.isFinite(startAt) ? startAt : null, finishAt, estimated: machine.estimated === true, state, observedAt: snapshotAt, snapshotAt, phases: {} }
  }
  // 自己计算的估时只锚定一次；上游真实结束时间更新也不创建新周期。
  const updateFinish = !machine.estimated || previous.estimated === true && !previous.finishAt
  return { ...previous, state, snapshotAt, ...(updateFinish ? { finishAt, estimated: machine.estimated === true } : {}) }
}

function buildNotice(machine, cycle, phase, now) {
  const kind = machine.kind === 'dryer' ? 'dryer' : 'washer'
  const cleanLabel = (value) => {
    const name = String(value || '').split(String(machine.id || '\u0000')).join('').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    return /^[a-f0-9]{16,}$/i.test(name) || /^\d{8,}$/.test(name) ? '' : name
  }
  const label = buildMachineLabel({ machineLabel: cleanLabel(machine.displayName || machine.machineLabel), machineName: cleanLabel(machine.name), slot: machine.slot, kind })
  const confirmed = phase === 'end' && cycle.confirmed === true
  const minutes = Math.max(1, Math.ceil((cycle.finishAt - now) / MINUTE))
  const title = phase === 'lead' ? '快轮到你了' : confirmed ? '你等的机器已结束' : '预约机器预计计时结束'
  const message = phase === 'lead'
    ? `预计 ${minutes} 分钟后结束，请准备。到场后请先确认上一位的衣物已取走。`
    : confirmed ? `已结束${kind === 'dryer' ? '烘干' : '洗衣'}，请现场确认衣物并使用。`
      : '预计计时结束，请现场确认机器状态和衣物情况。'
  const end = Number.isFinite(cycle.finishAt) ? `预计结束 ${hhmm(iso(cycle.finishAt))}${cycle.estimated ? '（估时）' : ''}` : ''
  const action = '在等衣查看预约；排队提醒不会自动占用机器。'
  const text = ['【等衣】' + title, label, message, end, action].filter(Boolean).join('\n')
  const escape = (value) => value.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
  return { title, text, markdown: ['### ' + title, '**' + escape(label) + '**', message, end, action].filter(Boolean).join('\n\n'), machineName: label, kind, confirmed, estimated: cycle.estimated === true, finishAt: iso(cycle.finishAt), url: '/#/task' }
}

export async function readQueueNotices(store, userId) {
  const list = await store.get('queue-notices:' + userId, [])
  const recent = (Array.isArray(list) ? list : []).slice(-30).reverse()
  const queues = new Map()
  for (const bid of new Set(recent.map((entry) => entry.buildingId || 'b1'))) queues.set(bid, heads(await store.get('queue:' + bid, [])))
  return recent.map(({ id, phase, machineId, machineName, kind, title, text, at, readAt, confirmed, estimated, finishAt, url, dm, buildingId, reservationId: qid, obsoleteAt }) => {
    const head = queues.get(buildingId || 'b1').get(machineId)
    const active = Boolean(head && head.userId === userId && reservationId(head) === qid && !obsoleteAt)
    return { id, phase, machineId, machineName, kind, title, text, at, readAt: readAt || null, confirmed, estimated, finishAt, url, active, delivery: { sent: Boolean(dm?.sentAt), pending: active && !dm?.sentAt && !dm?.suppressed && (dm?.attempts || 0) < MAX_ATTEMPTS } }
  })
}

export async function markQueueNoticeRead(store, userId, id, now = Date.now()) {
  return withOperationLock(store, 'queue-notices:' + userId, async () => {
    const list = await store.get('queue-notices:' + userId, [])
    const notice = Array.isArray(list) && list.find((entry) => entry.id === id)
    if (!notice) return false
    notice.readAt ||= iso(now)
    await store.put('queue-notices:' + userId, list.slice(-30))
    return true
  })
}

/** 仅遍历当前队首和他们的 outbox；不推进队列，不扫描用户表。notify 仅返回钉钉投递结果。 */
export async function processQueueReminders({ store, board, env = {}, now = Date.now(), notify } = {}) {
  now = typeof now === 'function' ? now() : stamp(now)
  const snapshotAt = stamp(board?.updatedAt)
  const stats = { created: 0, sent: 0, failed: 0, stale: false }
  if (!Number.isFinite(now) || !Number.isFinite(snapshotAt) || now - snapshotAt > 7 * MINUTE || snapshotAt > now + 30000) return { ...stats, stale: true }
  const bid = env.BUILDING_ID || board.buildingId || 'b1'
  return withOperationLock(store, 'queue-reminders:' + bid, async () => {
    const active = activeQueueEntries(await store.get('queue:' + bid, []))
    const queue = heads(active)
    const activeIds = new Set(active.map(reservationId))
    const saved = await store.get('queue-reminder-state:' + bid, { machines: {} })
    const cycles = Object.assign(Object.create(null), saved?.machines || {})
    const present = new Set()
    const jobs = []
    for (const machine of (board.floors || []).flatMap((floor) => floor.machines || [])) {
      const id = String(machine.id)
      present.add(id)
      if (machine.health?.stale || machine.health?.confirmedFault) continue
      const state = rawState(machine, env)
      if (!['occupied', 'abnormal', 'idle'].includes(state)) continue
      const previous = Object.hasOwn(cycles, id) ? cycles[id] : null
      if (previous && snapshotAt < previous.snapshotAt) continue
      const cycle = nextCycle(machine, previous, state, snapshotAt, now)
      if (!cycle) continue
      cycle.phases = Object.assign(Object.create(null), cycle.phases || {})
      for (const qid of Object.keys(cycle.phases)) if (!activeIds.has(qid)) delete cycle.phases[qid]
      cycles[id] = cycle
      const entry = queue.get(id)
      if (!entry || !cycle.finishAt || state !== 'idle' && !['occupied', 'abnormal'].includes(state)) continue
      const joinedAt = stamp(entry.at || entry.createdAt)
      if (cycle.endedAt && Number.isFinite(joinedAt) && joinedAt > cycle.endedAt) continue
      const user = await store.get('user:' + entry.userId, null)
      if (!user?.id || user.notifyOn === false) continue
      const qid = reservationId(entry)
      cycle.phases = Object.assign(Object.create(null), cycle.phases || {})
      const phases = cycle.phases[qid] || {}
      const left = cycle.finishAt - now
      const eligible = cycle.confirmed && state === 'idle' ? 'end'
        : ['occupied', 'abnormal'].includes(state) && left > 0 && left <= 3 * MINUTE ? 'lead'
          : ['occupied', 'abnormal'].includes(state) && left <= 0 && cycle.estimated ? 'end' : null
      let list = await store.get('queue-notices:' + entry.userId, [])
      list = Array.isArray(list) ? list : []
      if (eligible && !phases[eligible]) {
        const existing = list.find((notice) => notice.cycleId === cycle.id && notice.reservationId === qid && notice.phase === eligible)
        const notice = existing || { ...buildNotice(machine, cycle, eligible, now), id: 'qn_' + crypto.randomUUID(), phase: eligible, machineId: id, cycleId: cycle.id, reservationId: qid, buildingId: bid, at: iso(now), readAt: null, dm: { attempts: 0, nextAt: 0 } }
        phases[eligible] = notice.id
        cycle.phases[qid] = phases
        if (!existing) {
          await withOperationLock(store, 'queue-notices:' + entry.userId, async () => {
            const current = await store.get('queue-notices:' + entry.userId, [])
            list = [...(Array.isArray(current) ? current : []), notice].slice(-30)
            await store.put('queue-notices:' + entry.userId, list)
          })
          stats.created++
        }
      }
      for (const phase of phaseNames) {
        let item = list.find((notice) => notice.id === phases[phase])
        if (item && !item.dm?.sentAt) {
          const current = phase === eligible
          await withOperationLock(store, 'queue-notices:' + entry.userId, async () => {
            const stored = await store.get('queue-notices:' + entry.userId, [])
            const notice = Array.isArray(stored) && stored.find((candidate) => candidate.id === item.id)
            if (!notice) return
            if (current) { Object.assign(notice, buildNotice(machine, cycle, phase, now)); delete notice.obsoleteAt }
            else notice.obsoleteAt ||= iso(now)
            item = notice
            await store.put('queue-notices:' + entry.userId, stored.slice(-30))
          })
        }
        if (!item || item.dm?.sentAt || item.dm?.suppressed || (item.dm?.attempts || 0) >= MAX_ATTEMPTS || Number(item.dm?.nextAt || 0) > now) continue
        if (phase !== eligible) continue
        if (typeof notify === 'function' && jobs.length < MAX_SENDS_PER_RUN) jobs.push({ userId: user.id, item, qid })
      }
    }
    for (const id of Object.keys(cycles)) if (!present.has(id)) delete cycles[id]
    await store.put('queue-reminder-state:' + bid, { machines: cycles, updatedAt: iso(now) })

    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const { userId, item, qid } = jobs[cursor++]
        let sending
        let allowed = false
        await withOperationLock(store, 'queue:' + bid, async () => {
          const current = heads(await store.get('queue:' + bid, []))
          const head = current.get(item.machineId)
          const user = await store.get('user:' + userId, null)
          if (!head || head.userId !== userId || reservationId(head) !== qid || !user?.id || user.notifyOn === false) return
          allowed = true
          // 请求在排队锁内发起，完成等待在锁外，取消预约不会等待网络。
          try { sending = Promise.resolve(notify(userId, { title: item.title, text: item.text, markdown: item.markdown, url: item.url, type: 'queue', machineId: item.machineId, machineName: item.machineName, kind: item.kind, confirmed: item.confirmed, estimated: item.estimated, finishAt: item.finishAt, phase: item.phase, noticeId: item.id })) }
          catch { sending = Promise.resolve({ ok: false }) }
        })
        if (!allowed) continue
        let timer
        const result = await Promise.race([sending.catch(() => ({ ok: false })), new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false }), 9000) })]).finally(() => clearTimeout(timer))
        const ok = result?.ok === true
        await withOperationLock(store, 'queue-notices:' + userId, async () => {
          const list = await store.get('queue-notices:' + userId, [])
          const current = Array.isArray(list) && list.find((notice) => notice.id === item.id)
          if (!current) return
          const attempts = (current.dm?.attempts || 0) + 1
          current.dm = { attempts, lastAttemptAt: iso(now), nextAt: ok ? 0 : now + Math.min(30 * MINUTE, MINUTE * 2 ** (attempts - 1)), ...(ok ? { sentAt: iso(now) } : {}) }
          await store.put('queue-notices:' + userId, list.slice(-30))
        })
        stats[ok ? 'sent' : 'failed']++
      }
    }))
    return stats
  })
}
