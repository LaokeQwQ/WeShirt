import { withOperationLock } from './operations.js'
import { currentDormCatalog, resolveMachineDorm, normalizeDormBuilding } from './buildings.js'
import { getUserPermissions } from './permissions.js'
import { taskLifecycle } from './task-retention.js'
import { mobileDigest } from './mobile-auth.js'
import { upstreamQueryFailure } from './upstream-query.js'
import { claimNotificationDelivery } from './notification-delivery.js'

const MINUTE = 60000
const MAX_ATTEMPTS = 4
const escape = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100).replace(/[\\`*_{}\[\]()<>#|]/g, '\\$&')

export function buildMachineFaultNotice(machine, { name = '本楼', eventId, group = false } = {}) {
  const label = machine.displayName || machine.name || '洗衣机'
  const title = group ? `⚠️ ${name} · 机器异常` : '⚠️ 洗衣机状态异常'
  const detail = '设备在两次独立查询中持续返回故障或离线状态，请到现场核实。'
  const action = group ? '本机有用户登记使用，请使用者和本楼巡检志愿管理员及时核实。' : '请先确认设备、衣物和供电情况；运行中的设备请勿强行开门。'
  const text = [title, label, detail, action, `事件 ${eventId}`].join('\n')
  return { type: 'machine_fault', title, text, markdown: [`### ${escape(title)}`, `**${escape(label)}**`, detail, action, `> 事件 ${escape(eventId)}`].join('\n\n'),
    machineId: String(machine.id), eventId, url: '/#/task', tag: 'fault-' + eventId,
    nativeEventKey: 'machine-fault:' + eventId, nativeKind: 'ANNOUNCEMENT' }
}

async function context(store, bid, machine, env, now) {
  const catalog = await currentDormCatalog(store, env.SITE_BUILDINGS)
  const mapping = (await store.get('mapping:' + bid, null))?.mapping || {}
  const dorm = resolveMachineDorm(machine, mapping, catalog)
  if (!normalizeDormBuilding(dorm, catalog)) return { dorm: null, users: [], registered: false }
  const occupancy = await store.get('occupancy:' + bid, {})
  const entry = occupancy?.[String(machine.id)]
  let occupant = null
  if (entry?.userId) {
    const [user, tasks] = await Promise.all([store.get('user:' + entry.userId, null), store.get('tasks:' + entry.userId, [])])
    const task = Array.isArray(tasks) && tasks.find(task => task && String(task.machineId) === String(machine.id)
      && (entry.taskId ? task.id === entry.taskId : entry.startAt && task.startAt === entry.startAt)
      && !task.done && !task.takenAt && !task.cancelled && !task.deleted && !taskLifecycle(task, now).archived
      && (!task.userId || task.userId === entry.userId) && (!task.ownerId || task.ownerId === entry.userId))
    if (user && !user.disabled && !user.blocked && task) occupant = user
  }
  const users = new Set()
  if (occupant?.notifyOn !== false && occupant?.id) users.add(occupant.id)
  const admins = await store.get('meta:siteAdmins', [])
  for (const uid of new Set((Array.isArray(admins) ? admins : []).filter(row => row?.role === 'volunteer' && row.buildings?.includes(dorm)).map(row => row.userId))) {
    const user = await store.get('user:' + uid, null)
    if (!user || user.disabled || user.blocked || user.notifyOn === false) continue
    const access = await getUserPermissions(store, user, catalog)
    const permission = access.permissions.inspections
    if (access.identity.role === 'volunteer' && permission?.view && permission.operate
      && (permission.viewBuildings === null || permission.viewBuildings.includes(dorm))
      && (permission.operateBuildings === null || permission.operateBuildings.includes(dorm))) users.add(uid)
  }
  return { dorm, name: catalog.find(row => row.code === dorm)?.name, users: [...users], registered: Boolean(occupant) }
}

export async function machineFaultRecipientAllowed(store, uid, policy, env = {}, now = Date.now()) {
  const bid = env.BUILDING_ID || 'b1'
  const board = (await store.get('machines:' + bid, null))?.board
  const at = Date.parse(board?.updatedAt || '')
  if (!Number.isFinite(at) || now - at > 7 * MINUTE || at > now + 30000 || upstreamQueryFailure(board) !== null) return false
  const machine = (board.floors || []).flatMap(floor => floor.machines || []).find(machine => String(machine.id) === policy.machineId)
  if (!machine?.health?.confirmedFault || machine.health.stale || machine.health.queryFailed || upstreamQueryFailure(machine) !== null
    || machine.health.eventId !== policy.eventId || machine.upstreamState && machine.upstreamState !== 'faulty') return false
  const current = await context(store, bid, machine, env, now)
  return current.dorm === policy.dormBuilding && current.users.includes(uid)
}

/** Persisted per-episode outbox; only active building volunteers and an active registration owner are eligible. */
export async function processMachineFaultNotices({ store, board, env = {}, now = Date.now(), notify, broadcast, broadcastTargets, atomicStore } = {}) {
  const at = Date.parse(board?.updatedAt || '')
  const stats = { sent: 0, groups: 0, failed: 0, deferredGroups: 0 }
  if (!Number.isFinite(at) || now - at > 7 * MINUTE || at > now + 30000 || upstreamQueryFailure(board) !== null) return { ...stats, stale: true }
  const bid = env.BUILDING_ID || board.buildingId || 'b1'
  const key = 'faults:notification-outbox:' + bid
  return withOperationLock(store, key, async () => {
    const previous = await store.get(key, {})
    const outbox = { ...previous }
    const machines = (board.floors || []).flatMap(floor => floor.machines || [])
    const present = new Set(machines.map(machine => String(machine.id)))
    for (const id of Object.keys(outbox)) if (!present.has(id)) delete outbox[id]
    let attempts = 0
    for (const machine of machines) {
      if (!machine.health?.confirmedFault || machine.health.stale || machine.health.queryFailed || upstreamQueryFailure(machine) !== null || machine.upstreamState && machine.upstreamState !== 'faulty') continue
      const eventId = machine.health.eventId
      if (!/^evt_[a-f0-9]{24}$/.test(eventId || '')) continue
      const initial = await context(store, bid, machine, env, now)
      if (!initial.dorm) continue
      const id = String(machine.id)
      const episode = outbox[id]?.eventId === eventId ? outbox[id] : { eventId, at: new Date(now).toISOString(), deliveries: {} }
      outbox[id] = episode
      const jobs = initial.users.map(uid => ({ key: 'user:' + uid, userId: uid }))
      if (initial.registered && typeof broadcastTargets === 'function') {
        for (const target of await broadcastTargets()) if (target.dormBuilding === initial.dorm) jobs.push({ key: 'group:' + target.key + ':' + (target.conversationId || target.via), target })
      } else stats.deferredGroups++
      for (const job of jobs) {
        if (attempts >= 12) break
        const delivery = episode.deliveries[job.key] || {}
        if (delivery.sentAt || delivery.attempts >= MAX_ATTEMPTS || delivery.nextAt > now) continue
        const current = await context(store, bid, machine, env, now)
        if (current.dorm !== initial.dorm || job.userId && !current.users.includes(job.userId) || job.target && !current.registered) continue
        if (job.target && !(await broadcastTargets()).some(target => target.key === job.target.key && target.dormBuilding === current.dorm && target.conversationId === job.target.conversationId && target.via === job.target.via)) continue
        const sender = job.target ? broadcast : notify
        if (typeof sender !== 'function') continue
        let claim
        try { claim = await claimNotificationDelivery(atomicStore, 'mobile:limit:fault-delivery:' + await mobileDigest(`${bid}|${id}|${job.key}`), eventId, now, {cooldownMs:30 * MINUTE}) }
        catch { stats.failed++; continue }
        if (!claim) continue
        attempts++
        const count = (delivery.attempts || 0) + 1
        episode.deliveries[job.key] = { attempts: count, nextAt: now + MINUTE * 2 ** (count - 1), status: 'sending', eventId }
        await store.put(key, outbox)
        let ok = false
        try {
          const notice = buildMachineFaultNotice(machine, { name: current.name, eventId, group: Boolean(job.target) })
          const result = job.target ? await broadcast({ target: job.target, machine, notice, eventId }) : await notify(job.userId, { ...notice, dormBuilding: current.dorm,
            machineFault:{machineId:id,eventId,dormBuilding:current.dorm} })
          ok = result?.ok === true
        } catch { /* Only fixed delivery categories are persisted. */ }
        await claim.finish(ok).catch(() => {})
        episode.deliveries[job.key] = { attempts: count, nextAt: ok ? 0 : now + MINUTE * 2 ** (count - 1), status: ok ? 'sent' : 'notification_failed', eventId,
          ...(ok ? { sentAt: new Date(now).toISOString() } : {}) }
        await store.put(key, outbox)
        if (ok) { if (job.target) stats.groups++; else stats.sent++ } else stats.failed++
      }
    }
    await store.put(key, outbox)
    return stats
  })
}
