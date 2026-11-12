import { withOperationLock } from './operations.js'
import { buildMachineLabel, hhmm } from './notice.js'
import { currentDormCatalog, isMachineDormEnabled } from './buildings.js'
import { resolveMachineTime } from './machine-time.js'
import { claimNotificationDelivery } from './notification-delivery.js'
import { mobileDigest } from './mobile-auth.js'

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
  const reported = state === 'idle' && machine.availabilitySource === 'user_report' && machine.registrationPending === true
    && Number.isFinite(finishAt) && finishAt <= now + 4 * 60 * MINUTE && finishAt >= now - 30 * MINUTE
  if (reported) {
    const newReport = !previous || previous.state === 'idle'
      || previous.source === 'user_report' && previous.finishAt <= now && finishAt > now && finishAt !== previous.finishAt
    const cycle = newReport ? { id: 'cycle_' + crypto.randomUUID(), observedAt: snapshotAt, phases: {} } : previous
    return { ...cycle, source: 'user_report', state: 'occupied', finishAt, estimated: true, confirmed: false,
      endedAt: finishAt <= now ? finishAt : null, snapshotAt }
  }
  // 登记投影到期后会从看板移除；保留原登记周期，只提示计时到点，不把 raw idle 当完成确认。
  if (previous?.source === 'user_report' && state === 'idle') {
    return { ...previous, state: 'occupied', confirmed: false, estimated: true,
      endedAt: previous.finishAt <= now ? previous.finishAt : null, snapshotAt }
  }
  // 硬件重新明确运行后，旧登记时间不再参与提醒。缺少新的硬件结束时间就等待更新。
  if (previous?.source === 'user_report' && running) {
    const actualFinish = machine.availabilitySource !== 'user_report' && finishAt <= now + 24 * 60 * MINUTE ? finishAt : NaN
    return { ...previous, source: 'upstream', state, confirmed: false, endedAt: null, snapshotAt,
      finishAt: Number.isFinite(actualFinish) ? actualFinish : null,
      estimated: Number.isFinite(actualFinish) && machine.estimated === true }
  }
  if (!running && state !== 'idle') return previous
  if (!running) return previous ? { ...previous, state: 'idle', finishAt: previous.finishAt || snapshotAt, endedAt: previous.endedAt || snapshotAt, confirmed: true, snapshotAt } : null
  if (!Number.isFinite(finishAt) || finishAt > now + 24 * 60 * MINUTE) return previous && previous.state !== 'idle' ? { ...previous, state, snapshotAt } : null
  const newRun = !previous || previous.state === 'idle' || Number.isFinite(startAt) && previous.startAt && previous.startAt !== startAt
  if (newRun) {
    if (finishAt < now - 30 * MINUTE) return null
    return { id: 'cycle_' + crypto.randomUUID(), startAt: Number.isFinite(startAt) ? startAt : null, finishAt, estimated: machine.estimated === true, state, observedAt: snapshotAt, snapshotAt, phases: {} }
  }
  // Every platform deadline update supersedes an old registration/estimate;
  // it remains the same cycle, with its existing phase deduplication.
  return { ...previous, state, snapshotAt, finishAt, estimated: machine.estimated === true }
}

function buildNotice(machine, cycle, phase, now) {
  const kind = machine.kind === 'dryer' ? 'dryer' : 'washer'
  const cleanLabel = (value) => {
    const name = String(value || '').split(String(machine.id || '\u0000')).join('').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    return /^[a-f0-9]{16,}$/i.test(name) || /^\d{8,}$/.test(name) ? '' : name
  }
  const label = buildMachineLabel({ machineLabel: cleanLabel(machine.displayName || machine.machineLabel), machineName: cleanLabel(machine.name), slot: machine.slot, kind })
  const reported = cycle.source === 'user_report'
  const confirmed = phase === 'end' && cycle.confirmed === true && !reported
  const minutes = Math.max(1, Math.ceil((cycle.finishAt - now) / MINUTE))
  const title = reported ? phase === 'lead' ? '登记计时即将结束' : '登记计时已到'
    : phase === 'lead' ? '快轮到你了' : confirmed ? '你等的机器已结束' : '预约机器预计计时结束'
  const message = reported ? phase === 'lead'
    ? `登记计时约 ${minutes} 分钟后结束，请准备。设备实际状态和桶内衣物请到场确认。`
    : '用户登记计时已到，请现场确认设备状态和上一位的衣物；确认可用后再使用。'
    : phase === 'lead'
    ? `预计 ${minutes} 分钟后结束，请准备。请现场确认上一位的衣物已取走。`
    : confirmed ? `已结束${kind === 'dryer' ? '烘干' : '洗衣'}，请现场确认衣物并使用。`
      : '预计计时结束，请现场确认机器状态和衣物情况。'
  const end = Number.isFinite(cycle.finishAt) ? `${reported ? '登记' : ''}预计结束 ${hhmm(iso(cycle.finishAt))}${cycle.estimated ? '（估时）' : ''}` : ''
  const action = '在等衣查看预约；排队提醒不会自动占用机器。'
  const text = ['【等衣】' + title, label, message, end, action].filter(Boolean).join('\n')
  const escape = (value) => value.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
  return { title, text, markdown: ['### ' + title, '**' + escape(label) + '**', message, end, action].filter(Boolean).join('\n\n'), machineName: label, kind, confirmed, estimated: cycle.estimated === true, availabilitySource: reported ? 'user_report' : 'upstream', finishAt: iso(cycle.finishAt), url: '/#/task' }
}

export async function readQueueNotices(store, userId) {
  const list = await store.get('queue-notices:' + userId, [])
  const recent = (Array.isArray(list) ? list : []).slice(-30).reverse()
  const queues = new Map()
  for (const bid of new Set(recent.map((entry) => entry.buildingId || 'b1'))) queues.set(bid, heads(await store.get('queue:' + bid, [])))
  return recent.map(({ id, phase, machineId, machineName, kind, title, text, at, readAt, confirmed, estimated, availabilitySource, finishAt, url, dm, buildingId, reservationId: qid, obsoleteAt }) => {
    const head = queues.get(buildingId || 'b1').get(machineId)
    const active = Boolean(head && head.userId === userId && reservationId(head) === qid && !obsoleteAt)
    return { id, phase, machineId, machineName, kind, title, text, at, readAt: readAt || null, confirmed, estimated, availabilitySource, finishAt, url, active, delivery: { sent: Boolean(dm?.sentAt), pending: active && !dm?.sentAt && !dm?.suppressed && (dm?.attempts || 0) < MAX_ATTEMPTS } }
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
export async function processQueueReminders({ store, board, env = {}, now = Date.now(), notify, atomicStore } = {}) {
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
    const catalog = await currentDormCatalog(store, env.SITE_BUILDINGS)
    const machineList = (board.floors || []).flatMap((floor) => floor.machines || [])
    const machineById = new Map(machineList.map((machine) => [String(machine.id), machine]))
    const present = new Set()
    const jobs = []
    for (const machine of machineList) {
      const id = String(machine.id)
      present.add(id)
      if (!isMachineDormEnabled(machine, catalog, board.slotMapping) || machine.health?.stale || machine.health?.confirmedFault) continue
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
      if (!entry || state !== 'idle' && !['occupied', 'abnormal'].includes(state)) continue
      const joinedAt = stamp(entry.at || entry.createdAt)
      if (cycle.endedAt && Number.isFinite(joinedAt) && joinedAt > cycle.endedAt) continue
      const user = await store.get('user:' + entry.userId, null)
      if (!user?.id || user.disabled || user.blocked || user.notifyOn === false) continue
      const qid = reservationId(entry)
      cycle.phases = Object.assign(Object.create(null), cycle.phases || {})
      const phases = cycle.phases[qid] || {}
      const left = Number.isFinite(cycle.finishAt) ? cycle.finishAt - now : NaN
      const eligible = cycle.source === 'user_report' ? left > 0 && left <= 3 * MINUTE ? 'lead' : left <= 0 ? 'end' : null
        : cycle.confirmed && state === 'idle' ? 'end'
        : ['occupied', 'abnormal'].includes(state) && left > 0 && left <= 3 * MINUTE ? 'lead'
          : null
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
        let claim
        await withOperationLock(store, 'queue:' + bid, async () => {
          const current = heads(await store.get('queue:' + bid, []))
          const head = current.get(item.machineId)
          const user = await store.get('user:' + userId, null)
          if (!head || head.userId !== userId || reservationId(head) !== qid || !user?.id || user.disabled || user.blocked || user.notifyOn === false) return
          const machine = machineById.get(item.machineId)
          if (!machine || !isMachineDormEnabled(machine, await currentDormCatalog(store, env.SITE_BUILDINGS), board.slotMapping)) return
          const latest = (await store.get('machines:' + bid,null))?.board
          const currentMachine = latest ? latest.floors.flatMap(f=>f.machines).find(machine=>String(machine.id)===item.machineId) : machine
          if (!currentMachine) return
          const time = resolveMachineTime(currentMachine,{now,snapshotAt:latest?.updatedAt || board.updatedAt})
          if (time.stale || item.phase === 'lead' && (time.remainingMinutes === null || time.remainingMinutes <= 0 || time.remainingMinutes > 3)
            || item.phase === 'end' && !time.confirmedFinished && item.availabilitySource !== 'user_report') return
          if (time.deadline && item.phase === 'lead') Object.assign(item,buildNotice(currentMachine,{...cycles[item.machineId],finishAt:Date.parse(time.deadline)},item.phase,now))
          try {claim=await claimNotificationDelivery(atomicStore,'mobile:limit:queue-delivery:'+await mobileDigest(`${bid}|${item.machineId}|${qid}|${item.phase}`),`${qid}:${item.phase}`,now)}
          catch {stats.failed++;return}
          if(!claim)return
          allowed = true
          // 请求在排队锁内发起，完成等待在锁外，取消预约不会等待网络。
          try { sending = Promise.resolve(notify(userId, { title: item.title, text: item.text, markdown: item.markdown, url: item.url, type: 'queue', machineId: item.machineId, machineName: item.machineName, kind: item.kind, confirmed: item.confirmed, estimated: item.estimated, availabilitySource: item.availabilitySource, finishAt: item.finishAt, phase: item.phase, noticeId: item.id, reservationId: qid,revision:Math.floor(now/1000) })) }
          catch { sending = Promise.resolve({ ok: false }) }
        })
        if (!allowed) continue
        let timer
        const result = await Promise.race([sending.catch(() => ({ ok: false })), new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false }), 9000) })]).finally(() => clearTimeout(timer))
        const ok = result?.ok === true
        await claim.finish(ok).catch(()=>{})
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
