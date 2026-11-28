const MINUTE = 60000

// Only a newer device observation may correct the countdown of the current
// registration. Ownership and completion still come from the private task API.
export function newerRunningMachine(task, machine, board, now) {
  if (task.currentTask !== true || task.done || task.archived || task.completionConfirmed === true ||
      task.takeState === 'taken' || String(task.machineId) !== String(machine?.id)) return null
  if (!['occupied', 'abnormal'].includes(machine.state) || machine.registrationPending || machine.timeStale ||
      machine.health?.stale || board?.freshness?.stale || board?.freshness?.syncFailed) return null
  const observed = Date.parse(machine.timeObservedAt || board?.updatedAt || '')
  const previous = Date.parse(task.timingObservedAt || '')
  const registered = Date.parse(task.createdAt || task.startAt || '')
  if (!Number.isFinite(observed) || !Number.isFinite(previous) || observed <= previous ||
      (Number.isFinite(registered) && observed < registered) || now - observed > 3 * MINUTE || observed > now + 30000) return null
  const end = machine.timeSource === 'upstream' ? Date.parse(machine.finishAt || '') : NaN
  return { end, timeOffsetMinutes: machine.timeOffsetMinutes }
}

export function taskTimingConflict(task, running) {
  if (!running) return false
  if (task.takeState === 'pending') return true
  if (!Number.isFinite(running.end)) return task.timingSource === 'upstream'
  const end = Date.parse(task.endAt || '')
  return task.timingSource !== 'upstream' || !Number.isFinite(end) || Math.abs(running.end - end) >= MINUTE
}
