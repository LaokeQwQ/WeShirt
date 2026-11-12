import { projectMachineTime } from './machine-time.js'
import { upstreamQueryFailure } from './upstream-query.js'
import { readMachineDocument, updateMachineDocument } from './machine-documents.js'
import { projectMachinePlacement } from './machine-labels.js'

const MINUTE = 60000
const date = value => Date.parse(value || '')
const running = machine => ['occupied', 'busy', 'abnormal'].includes(machine?.upstreamState || machine?.state)
const idle = machine => (machine?.upstreamState || machine?.state) === 'idle'
const bounded = value => Math.max(-120, Math.min(120, Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0))
export const calibrationKey = bid => `machineTimeCalibration:${bid}`
export const readCalibrationSettings=(store,bid)=>readMachineDocument({store,key:calibrationKey(bid),fallback:{machines:{}}})
export const updateCalibrationSettings=(store,bid,mutate)=>updateMachineDocument({store,key:calibrationKey(bid),fallback:{machines:{}}},mutate)
export function publicCalibration(value = {}) {
  const offsetMinutes = bounded(value.offsetMinutes)
  const learnedOffsetMinutes = bounded(value.learnedOffsetMinutes)
  return { offsetMinutes, autoEnabled: value.autoEnabled === true, learnedOffsetMinutes,
    effectiveOffsetMinutes: bounded(offsetMinutes + (value.autoEnabled === true ? learnedOffsetMinutes : 0)),
    sampleCount: Array.isArray(value.samples) ? value.samples.length : 0, lastCalibratedAt: value.lastCalibratedAt || null }
}

export function projectCalibratedBoard(board, settings = {}, { now = Date.now(), tasksByMachine = new Map(), mapping = board?.slotMapping || {} } = {}) {
  if (!board) return board
  board = projectMachinePlacement(board, mapping)
  return { ...board, floors: (board.floors || []).map(floor => ({ ...floor, machines: (floor.machines || []).map(machine => {
    const calibration = publicCalibration(settings.machines?.[machine.id])
    return { ...projectMachineTime(machine, { now, snapshotAt: board.updatedAt, task: tasksByMachine.get(String(machine.id)), timeOffsetMinutes: calibration.effectiveOffsetMinutes }), calibration }
  }) })) }
}

// Learning uses raw platform deadlines, never the already corrected display value.
// Only uninterrupted cycles observed from idle through running to two fresh idle
// snapshots qualify. Missing observations and query failures invalidate a cycle.
export function observeCalibration(value = {}, machine, { now, snapshotAt, previousMachine, previousSnapshotAt } = {}) {
  const next = { ...value, ...(value.cycle ? { cycle: { ...value.cycle } } : {}) }, observed = date(snapshotAt), before = date(previousSnapshotAt)
  if(Number.isFinite(observed)&&Number.isFinite(next.lastObservation)&&observed<=next.lastObservation)return next
  const healthy = Number.isFinite(observed) && observed <= now + 30000 && now - observed < 3 * MINUTE
    && upstreamQueryFailure(machine) === null && !['faulty', 'offline', 'unknown'].includes(machine?.upstreamState || machine?.state)
  if (!next.autoEnabled || !healthy) { delete next.cycle; next.lastObservation = observed; return next }
  const continuous = Number.isFinite(before) && observed > before && observed - before <= 3 * MINUTE
    && (!Number.isFinite(next.lastObservation) || next.lastObservation === before)
  if (!continuous) delete next.cycle
  const rawEnd = date(machine.platformFinishAt ?? (machine.estimated !== true ? machine.finishAt : null))
  if (running(machine)) {
    if (!next.cycle && continuous && idle(previousMachine) && upstreamQueryFailure(previousMachine) === null && rawEnd > observed && rawEnd - observed <= 4 * 3600000) {
      next.cycle = { startAt: observed, predictedDurationMs: rawEnd - observed, predictedEndAt: rawEnd }
    } else if (next.cycle) {
      // A changed program / extended dryer cycle is not a clock error. Missing
      // raw deadlines also break the evidence needed for automatic learning.
      if (!Number.isFinite(rawEnd) || Math.abs(rawEnd - next.cycle.predictedEndAt) > 2 * MINUTE) delete next.cycle
      // Running after a brief idle invalidates the completion candidate.
      else delete next.cycle.idleAt
    }
  } else if (idle(machine) && next.cycle) {
    if (!next.cycle.idleAt) next.cycle = { ...next.cycle, idleAt: observed }
    else if (continuous && idle(previousMachine) && observed > next.cycle.idleAt) {
      const cycle = next.cycle
      const actualDurationMs = cycle.idleAt - cycle.startAt
      const deviation = Math.round((actualDurationMs - cycle.predictedDurationMs) / MINUTE)
      if (actualDurationMs >= 2 * MINUTE && actualDurationMs <= 4 * 3600000 && Math.abs(deviation) <= 120) {
        const samples = [...(Array.isArray(next.samples) ? next.samples : []), { minutes: deviation, at: new Date(cycle.idleAt).toISOString() }].slice(-7)
        const ordered = samples.map(sample => sample.minutes).sort((a, b) => a - b)
        const median = ordered[Math.floor(ordered.length / 2)]
        // Cap a single cycle's influence; repeat observations settle the value.
        const old = bounded(next.learnedOffsetMinutes)
        next.learnedOffsetMinutes = bounded(old + Math.max(-2, Math.min(2, median - old)))
        next.samples = samples
        next.lastCalibratedAt = new Date(observed).toISOString()
      }
      delete next.cycle
    }
  } else delete next.cycle
  next.lastObservation = observed
  return next
}

export async function calibrateMachineBoard({ store, buildingId, board, previousBoard, now = Date.now() }) {
  const result=await updateCalibrationSettings(store,buildingId,async settings=>{
    const machines = { ...(settings.machines || {}) }
    const previous = new Map((previousBoard?.floors || []).flatMap(floor => floor.machines || []).map(machine => [String(machine.id), machine]))
    const current = (board?.floors || []).flatMap(floor => floor.machines || [])
    const observedIds = new Set(current.map(machine => String(machine.id)))
    const observed=date(board?.updatedAt)
    for (const [id, value] of Object.entries(machines)) if (value?.cycle && !observedIds.has(String(id)) && (!Number.isFinite(value.lastObservation)||observed>value.lastObservation)) {
      machines[id] = { ...value,lastObservation:observed }; delete machines[id].cycle
    }
    for (const machine of current) {
      const value = machines[machine.id]
      if (value?.autoEnabled) machines[machine.id] = observeCalibration(value, machine, { now, snapshotAt: board.updatedAt, previousMachine: previous.get(String(machine.id)), previousSnapshotAt: previousBoard?.updatedAt })
    }
    const next = { ...settings, machines }
    return {document:next}
  })
  return projectCalibratedBoard(board,result.document,{now})
}

export async function invalidateMachineCalibration({ store, buildingId, now=Date.now() }) {
  return updateCalibrationSettings(store,buildingId,async settings=>{
    if (!settings?.machines) return {document:settings}
    let changed = false
    const machines = Object.fromEntries(Object.entries(settings.machines).map(([id, value]) => {
      if(Number.isFinite(value.lastObservation)&&value.lastObservation>=now)return [id,value]
      const next = { ...value, lastObservation:now }
      if(value.lastObservation!==now)changed=true
      if (next.cycle) { delete next.cycle; changed = true }
      return [id, next]
    }))
    return {document:changed?{...settings,machines}:settings}
  })
}
