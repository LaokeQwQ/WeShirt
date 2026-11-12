import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRegisteredAvailability } from '../packages/core/availability.js'
import { runOperations } from '../packages/core/operations.js'
import { createMemoryStore } from '../packages/core/store.js'
import { diffEvents } from '../packages/core/machines.js'

const NOW = Date.parse('2026-11-10T00:00:00Z')
const START = new Date(NOW - 60000).toISOString()
const END = new Date(NOW + 25 * 60000).toISOString()
const machine = (overrides = {}) => ({ id: 'm1', name: '测试洗衣机', state: 'idle', rawState: 1, finishAt: null, leftMin: null, ...overrides })
const board = (m = machine(), now = NOW) => ({ updatedAt: new Date(now).toISOString(), floors: [{ code: '1', machines: [m] }] })
const task = (overrides = {}) => ({ id: 't1', machineId: 'm1', startAt: START, endAt: END, done: false, ...overrides })
const entry = (overrides = {}) => ({ userId: 'u1', taskId: 't1', startAt: START, endAt: END, ...overrides })
function project({ m = machine(), t = task(), o = entry(), owner = 'u1', now = NOW } = {}) {
  return applyRegisteredAvailability(board(m), { occupancy: { m1: o }, tasksByUser: new Map([[owner, [t]]]), now })
}
const first = (value) => value.floors[0].machines[0]

test('active exact registration projects occupied with explicitly estimated user source and no private data', () => {
  const original = board()
  const occupancy = { m1: entry() }
  const tasks = new Map([['u1', [task({ note: '私密自由文本', userId: 'u1', useDisinfectant: true })]]])
  const before = JSON.stringify({ original, occupancy, tasks: [...tasks] })
  const result = applyRegisteredAvailability(original, { occupancy, tasksByUser: tasks, now: NOW })
  assert.deepEqual(first(result), { ...machine(), state: 'occupied', upstreamState: 'idle', finishAt: END, leftMin: 25,
    estimated: true, availabilitySource: 'user_report', registrationPending: true, availabilityLabel: '用户已登记，等待设备状态更新' })
  assert.equal(result.idle, 0)
  assert.equal(result.occupied, 1)
  assert.equal(result.total, 1)
  assert.equal(JSON.stringify({ original, occupancy, tasks: [...tasks] }), before)
  for (const privateValue of ['u1', 't1', '私密自由文本', 'useDisinfectant']) assert.equal(JSON.stringify(result).includes(privateValue), false)
})

test('inactive, missing, expired, overly long, mismatched task and owner never create public occupancy', () => {
  const cases = [
    { t: task({ done: true }) }, { t: task({ takenAt: START }) }, { t: task({ endAt: new Date(NOW).toISOString() }) },
    { t: task({ endAt: 'invalid' }) }, { t: task({ endAt: new Date(NOW + 4 * 3600000 + 1).toISOString() }) },
    { t: task({ id: 'other' }) }, { t: task({ machineId: 'other' }) }, { t: task({ userId: 'other' }) },
    { t: task({ ownerId: 'other' }) }, { owner: 'other' }, { o: entry({ userId: 'other' }) }, { o: null }, { t: null }, { now: NaN },
  ]
  for (const fixture of cases) {
    const result = project(fixture)
    assert.equal(first(result).state, 'idle', JSON.stringify(fixture))
    assert.equal(first(result).registrationPending, undefined)
  }
  const limit = project({ t: task({ endAt: new Date(NOW + 4 * 3600000).toISOString() }) })
  assert.equal(first(limit).state, 'occupied', 'four-hour bound is inclusive')
})

test('legacy records require the exact original start; taskId presence never falls back to another task', () => {
  assert.equal(first(project({ o: entry({ taskId: undefined }) })).state, 'occupied')
  assert.equal(first(project({ o: entry({ taskId: undefined, startAt: undefined }) })).state, 'idle')
  assert.equal(first(project({ o: entry({ taskId: undefined, startAt: 'different' }) })).state, 'idle')
  assert.equal(first(project({ o: entry({ taskId: 'absent' }) })).state, 'idle')
})

test('registration never overrides a confirmed platform finish and startup protection expires after two minutes',()=>{
 const complete=first(project({t:task({platformSeenRunning:true})}))
 assert.equal(complete.state,'idle');assert.equal(complete.platformCompletionConfirmed,true)
 const expired=first(project({t:task({startAt:new Date(NOW-3*60000).toISOString()})}))
 assert.equal(expired.state,'idle');assert.equal(expired.registrationPending,undefined)
})

test('actual occupied, abnormal, fault, unknown and stale projections always preserve hardware/health state', () => {
  const end = new Date(NOW + 10 * 60000).toISOString()
  for (const state of ['occupied', 'abnormal', 'faulty', 'unknown']) {
    const input = machine({ state, upstreamState: state, finishAt: end, estimated: false })
    assert.deepEqual(first(project({ m: input })), input)
  }
  for (const health of [{ stale: true }, { confirmedFault: true }, { suspectedFault: true }]) {
    assert.equal(first(project({ m: machine({ health }) })).state, 'idle')
    assert.equal(first(project({ m: machine({ health }) })).registrationPending, undefined)
  }
  assert.equal(first(project({ m: machine({ upstreamState: 'occupied' }) })).registrationPending, undefined)
})

test('repeated projection is stable and ending/taking a registration removes its stale estimated timer', () => {
  const once = project()
  const args = { occupancy: { m1: entry() }, tasksByUser: new Map([['u1', [task()]]]), now: NOW }
  assert.deepEqual(applyRegisteredAvailability(once, args), once)
  for (const changedTask of [task({ done: true }), task({ takenAt: START }), task({ endAt: START })]) {
    const result = applyRegisteredAvailability(once, { ...args, tasksByUser: new Map([['u1', [changedTask]]]) })
    assert.equal(first(result).state, 'idle')
    assert.equal(first(result).finishAt, null)
    assert.equal(first(result).registrationPending, undefined)
  }
  const stale = structuredClone(once)
  first(stale).state = 'unknown'
  first(stale).health = { stale: true }
  const result = applyRegisteredAvailability(stale, args)
  assert.equal(first(result).state, 'unknown')
  assert.equal(first(result).finishAt, null)
  const hardware = structuredClone(once)
  Object.assign(first(hardware), { upstreamState: 'occupied', finishAt: new Date(NOW + 3 * 60000).toISOString(), estimated: false })
  const running = applyRegisteredAvailability(hardware, args)
  assert.equal(first(running).state, 'occupied')
  assert.equal(first(running).finishAt, first(hardware).finishAt, 'real hardware time replaces the old registration estimate')
  assert.equal(first(running).estimated, false)
  assert.equal(first(running).registrationPending, undefined)
})

test('runOperations uses existing task reads before event/group projection; pending registration does not become available early', async (t) => {
  let networkCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('No external requests') })
  const store = createMemoryStore()
  await store.put('occupancy:b1', { m1: entry() })
  await store.put('tasks:u1', [task()])
  const publicBroadcasts = []
  const broadcast = async (value) => { publicBroadcasts.push(value); return { ok: true } }
  const previous = [machine({ state: 'occupied', upstreamState: 'occupied', rawState: 2, finishAt: END })]
  const result = await runOperations({ store, board: board(), now: NOW, env: { BUILDING_ID: 'b1' }, broadcast })
  assert.equal(first(result.board).state, 'occupied')
  assert.equal(first(result.board).availabilitySource, 'user_report')
  assert.deepEqual(diffEvents(previous, result.board.floors[0].machines), [], 'no false finished event while registration is active')
  assert.equal(publicBroadcasts.length, 1)
  assert.equal(publicBroadcasts[0].board.idle, 0)
  assert.equal(first(publicBroadcasts[0].board).registrationPending, true)
  await runOperations({ store, board: board(machine(), NOW + 60000), now: NOW + 60000, env: { BUILDING_ID: 'b1' }, broadcast })
  assert.equal(publicBroadcasts.length, 1, 'unchanged occupied status does not trigger a second availability broadcast')
  const done = await runOperations({ store, board: board(machine(), NOW + 26 * 60000), now: NOW + 26 * 60000, env: { BUILDING_ID: 'b1' }, broadcast })
  assert.equal(first(done.board).state, 'idle')
  assert.equal(diffEvents(result.board.floors[0].machines, done.board.floors[0].machines)[0].type, 'becameIdle')
  assert.equal(networkCalls, 0)
})
