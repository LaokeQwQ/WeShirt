import { upstreamQueryFailure } from './upstream-query.js'
import { mobileDigest } from './mobile-auth.js'

const running = machine => ['busy', 'occupied', 'abnormal'].includes(machine?.upstreamState || machine?.state)
const observed = value => typeof value === 'string' ? Date.parse(value) : NaN
export async function takeMachineCycleEvidence(machine) {
  const { cycleOrder, platformStartedAt } = machine
  delete machine.cycleOrder
  delete machine.platformStartedAt
  return {
    ...(cycleOrder ? { platformCycleKey: await mobileDigest(String(machine.id) + ':' + cycleOrder) } : {}),
    ...(platformStartedAt ? { platformStartedAt } : {}),
  }
}
export function taskMatchesOccupancy(task, occupancy, userId) {
  if (!occupancy || occupancy.userId !== userId) return false
  if (occupancy.taskId) return occupancy.taskId === task.id
  return Boolean(occupancy.startAt && occupancy.startAt === task.startAt)
}

/** A later deadline can be a heat/dryer extension. Only an idle edge or a
 * different provider cycle identifier/start timestamp proves another run. */
export function observeLaundryCycle(task, machine, prior, snapshotAt, previousSnapshotAt) {
  if (!machine || task.platformCompletedAt || upstreamQueryFailure(machine) !== null || machine.health?.stale) return null
  const at = observed(snapshotAt)
  const before = observed(previousSnapshotAt)
  const started = observed(task.startAt || task.createdAt)
  if (!Number.isFinite(at) || Number.isFinite(started) && started > at) return null
  const priorRunning = running(prior) && prior.availabilitySource !== 'user_report' && upstreamQueryFailure(prior) === null
  const wasRunning = task.platformSeenRunning || (priorRunning && (!Number.isFinite(started) || Number.isFinite(before) && started <= before))
  const isRunning = running(machine) && machine.availabilitySource !== 'user_report'
  const idChanged = machine.platformCycleKey && (task.platformCycleKey
    ? task.platformCycleKey !== machine.platformCycleKey
    : priorRunning && prior.platformCycleKey && prior.platformCycleKey !== machine.platformCycleKey)
  const startChanged = priorRunning && Number.isFinite(observed(prior.platformStartedAt))
    && observed(machine.platformStartedAt) > observed(prior.platformStartedAt)
  const idle = (machine.upstreamState || machine.state) === 'idle' && machine.state === 'idle'
  if (wasRunning && (idle || isRunning && (idChanged || startChanged))) {
    return { platformSeenRunning: true, platformCompletedAt: snapshotAt }
  }
  if (!isRunning) return null
  // A known live cycle predating this registration may still be selected by
  // the user. Bind it on the first observation, never infer from its duration.
  const key = machine.platformCycleKey
  return !task.platformSeenRunning || key && !task.platformCycleKey
    ? { platformSeenRunning: true, ...(key ? { platformCycleKey: key } : {}) } : null
}
