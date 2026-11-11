export const TASK_ARCHIVE_MS = 72 * 60 * 60 * 1000
export const TASK_RETENTION_MS = 336 * 60 * 60 * 1000

// Older records used startAt as their registration timestamp.
export function taskRegisteredAt(task) {
  for (const value of [task?.createdAt, task?.startAt, task?.endAt, task?.takenAt]) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN
    if (Number.isFinite(time)) return time
  }
  return null
}

export function taskLifecycle(task, now = Date.now()) {
  const created = taskRegisteredAt(task)
  const archivedAt = created === null ? null : new Date(created + TASK_ARCHIVE_MS).toISOString()
  const expiresAt = created === null ? null : new Date(created + TASK_RETENTION_MS).toISOString()
  return {
    createdAt: created === null ? null : new Date(created).toISOString(),
    archived: created !== null && now - created >= TASK_ARCHIVE_MS,
    archivedAt, expiresAt,
    expired: created !== null && now - created >= TASK_RETENTION_MS,
  }
}

export function retainedTasks(tasks, now = Date.now()) {
  return (Array.isArray(tasks) ? tasks : []).filter(task => task && !taskLifecycle(task, now).expired)
}

export function splitTaskHistory(tasks, now = Date.now()) {
  const activeTasks = [], history = []
  for (const task of retainedTasks(tasks, now)) {
    const lifecycle = taskLifecycle(task, now)
    const item = { ...task, ...lifecycle }
    ;(lifecycle.archived ? history : activeTasks).push(item)
  }
  const newestFirst = (a, b) => (taskRegisteredAt(b) || 0) - (taskRegisteredAt(a) || 0)
  return { activeTasks: activeTasks.sort(newestFirst), history: history.sort(newestFirst) }
}
