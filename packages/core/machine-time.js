import { upstreamQueryFailure } from './upstream-query.js'

const MINUTE = 60000
const stamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN
const valid = value => Number.isFinite(value) && value > 0

/** Platform time wins over registration time. Calibration always uses the raw
 * platform deadline; projecting the same machine twice cannot add it twice. */
export function resolveMachineTime(machine = {}, { task, now = Date.now(), snapshotAt, timeOffsetMinutes } = {}) {
  now = stamp(now)
  const observedAt = stamp(snapshotAt ?? machine.timeObservedAt ?? machine.updatedAt)
  const stale = machine.health?.stale === true || machine.timeStale === true || upstreamQueryFailure(machine) !== null
    || Number.isFinite(observedAt) && (now - observedAt > 7 * MINUTE || observedAt > now + 30000)
  const offsetInput = timeOffsetMinutes ?? machine.timeOffsetMinutes ?? 0
  const offset = Number.isFinite(Number(offsetInput)) ? Math.min(180,Math.max(-180,Number(offsetInput))) : 0
  const reported = machine.availabilitySource === 'user_report' || machine.timeSource === 'user_report'
  let platform = stamp(machine.platformFinishAt ?? (!reported && machine.estimated !== true ? machine.finishAt : null))
  const remaining = Number(machine.platformRemainingMinutes)
  if (!valid(platform) && machine.platformRemainingMinutes != null && Number.isFinite(remaining) && remaining >= 0 && remaining <= 24 * 60 && valid(observedAt)) platform = observedAt + remaining * MINUTE
  const fallback = stamp(task?.endAt ?? (reported || machine.estimated === true ? machine.finishAt : null))
  const source = !stale && valid(platform) ? 'upstream' : valid(fallback) ? 'user_report' : 'none'
  const rawDeadline = source === 'upstream' ? platform : source === 'user_report' ? fallback : null
  let deadlineMs = rawDeadline === null ? null : rawDeadline + (source === 'upstream' ? offset * MINUTE : 0)
  const rawState = machine.upstreamState || (['idle','occupied','abnormal','faulty','unknown'].includes(machine.rawState) ? machine.rawState
    : ({1:'idle',2:'occupied',3:'faulty'})[machine.rawState]) || machine.state
  const confirmedFinished = !stale && rawState === 'idle' && !machine.registrationPending && (!reported || machine.platformCompletionConfirmed)
    && (!task || machine.platformCompletionConfirmed || task.platformSeenRunning || task.mode === 'machine')
  if (confirmedFinished && (deadlineMs !== null || task || machine.platformCompletionConfirmed)) deadlineMs = Math.min(now,valid(observedAt) ? observedAt : now)
  return { deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
    remainingMinutes: deadlineMs === null || !Number.isFinite(now) ? null : Math.max(0,Math.ceil((deadlineMs-now)/MINUTE)),
    source, stale, confirmedFinished, platformFinishAt:valid(platform) ? new Date(platform).toISOString() : null,
    timeOffsetMinutes:offset, observedAt:valid(observedAt) ? new Date(observedAt).toISOString() : null }
}

export function projectMachineTime(machine = {}, options = {}) {
  const result = resolveMachineTime(machine,options)
  return {...machine,platformFinishAt:result.platformFinishAt,finishAt:result.deadline,leftMin:result.remainingMinutes,
    timeSource:result.source,timeStale:result.stale,timeOffsetMinutes:result.timeOffsetMinutes,
    ...(result.observedAt ? {timeObservedAt:result.observedAt} : {})}
}
