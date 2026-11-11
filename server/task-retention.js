import { retainedTasks } from '../packages/core/task-retention.js'
import { withTaskMutation } from './task-mutation-lock.js'
import { logEvent } from '../packages/core/auditlog.js'

export function pruneUserTasks(store, buildingId, userId, now = Date.now()) {
  return withTaskMutation(store, buildingId, async () => {
    const key = 'tasks:' + userId
    const original = await store.get(key, [])
    const list = Array.isArray(original) ? original : []
    const kept = retainedTasks(list, now)
    if (kept.length === list.length) return kept
    const removedIds = new Set(list.filter(task => !kept.includes(task)).map(task => task?.id))
    const occupancyKey = 'occupancy:' + (buildingId || 'b1')
    const occupancy = await store.get(occupancyKey, {})
    const next = { ...(occupancy || {}) }
    let changed = false
    for (const [machineId, entry] of Object.entries(next)) {
      if (entry?.userId !== userId) continue
      const removed = list.find(task => task && removedIds.has(task.id) && String(task.machineId) === machineId &&
        (entry.taskId ? entry.taskId === task.id : entry.startAt && entry.startAt === task.startAt))
      if (removed) { delete next[machineId]; changed = true }
    }
    // A retry after a failed write is safe: ownership is checked against the
    // exact task, so an older record can never remove a replacement registration.
    if (changed) await store.put(occupancyKey, next)
    await store.put(key, kept)
    await logEvent(store, { type: 'task', action: '自动清除过期洗衣记录', actorId: userId, detail: { removed: list.length - kept.length, retentionHours: 336 } }).catch(() => {})
    return kept
  })
}
