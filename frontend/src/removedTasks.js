const REMEMBER_MS = 10 * 60_000
const MAX_REMOVED = 150
const removed = new Map()

function key(owner, id) { return JSON.stringify([owner, id]) }

function expire(at) {
  for (const [id, until] of removed) if (until <= at) removed.delete(id)
}

export function rememberRemovedTask(owner, id, at = Date.now()) {
  if (!owner || !id) return
  expire(at)
  removed.set(key(owner, id), at + REMEMBER_MS)
  if (removed.size > MAX_REMOVED) removed.delete(removed.keys().next().value)
}

export function removeDeletedTasks(owner, tasks, at = Date.now()) {
  expire(at)
  return tasks.filter(task => !removed.has(key(owner, task?.id)))
}
