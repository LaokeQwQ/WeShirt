import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../packages/core/store.js'
import { evaluateMachineHealth, applyMachineHealth, runOperations, normalizeOperationsConfig, buildQueueSchedule, recordAdminAlert, broadcastWindow } from '../packages/core/operations.js'

const AT = Date.parse('2026-11-10T00:00:00Z') // 北京时间8点
const board = (state, now = AT, extra = {}) => ({ buildingId: 'b1', updatedAt: new Date(now).toISOString(), floors: [{ code: '1', machines: [{ id: '1', name: '桂园1号机', state, rawState: state === 'faulty' ? 3 : 1, ...extra }] }] })
const machine = (b) => b.floors[0].machines[0]

test('故障需两次不同快照且至少30秒，重复读取不累加；恢复同样需要两次', () => {
  let result = evaluateMachineHealth(board('faulty'), {}, AT)
  assert.equal(machine(result.board).state, 'unknown')
  assert.equal(machine(result.board).health.suspectedFault, true)
  const first = result.health
  result = evaluateMachineHealth(board('faulty'), first, AT + 60000)
  assert.equal(machine(result.board).state, 'unknown', '相同快照不能算第二次')
  result = evaluateMachineHealth(board('faulty', AT + 10000), first, AT + 10000)
  assert.equal(machine(result.board).state, 'unknown')
  result = evaluateMachineHealth(board('faulty', AT + 30000), result.health, AT + 30000)
  assert.equal(machine(result.board).state, 'faulty')
  assert.equal(machine(result.board).rawState, 3)
  result = evaluateMachineHealth(board('idle', AT + 60000), result.health, AT + 60000)
  assert.equal(machine(result.board).state, 'faulty')
  assert.equal(machine(result.board).health.recovering, true)
  result = evaluateMachineHealth(board('idle', AT + 90000), result.health, AT + 90000)
  assert.equal(machine(result.board).state, 'idle')
  assert.equal(result.board.faulty, 0)
  assert.equal(result.board.idle, 1)
})

test('未知和过期快照不累积确认，公开投影不改变持久状态', () => {
  assert.equal(machine(applyMachineHealth(board('idle'), {}, AT + 5 * 60000)).state, 'idle', '五分钟同步周期内不应误判过期')
  let result = evaluateMachineHealth(board('faulty'), {}, AT)
  result = evaluateMachineHealth(board('unknown', AT + 30000), result.health, AT + 30000)
  result = evaluateMachineHealth(board('faulty', AT + 60000), result.health, AT + 60000)
  assert.equal(machine(result.board).state, 'unknown')
  result = evaluateMachineHealth(board('faulty', AT + 60000), result.health, AT + 600000)
  assert.equal(result.health.machines['1'].count, 0)
  assert.equal(machine(result.board).health.stale, true)
  const original = structuredClone(result.health)
  applyMachineHealth(board('faulty', AT + 600000), result.health, AT + 600000)
  assert.deepEqual(result.health, original)
})

test('群播报北京时间整点窗口、每小时一次且不因倒计时变化重复发送', async () => {
  const store = createMemoryStore()
  const sent = []
  const broadcast = async (payload) => { sent.push(payload); return { ok: true } }
  const args = { store, env: {}, broadcast }
  await Promise.all([runOperations({ ...args, board: board('occupied', AT, { finishAt: new Date(AT + 30 * 60000).toISOString(), leftMin: 30 }), now: AT }), runOperations({ ...args, board: board('occupied', AT, { leftMin: 29 }), now: AT + 1000 })])
  assert.equal(sent.length, 1)
  assert.match(sent[0].hourKey, /T08$/)
  const nextHour = AT + 3600000
  const unchanged = await runOperations({ ...args, board: board('occupied', nextHour, { leftMin: 10 }), now: nextHour })
  assert.equal(unchanged.broadcast.reason, 'unchanged')
  assert.equal(sent.length, 1)
  const third = nextHour + 3600000
  await runOperations({ ...args, board: board('idle', third), now: third })
  assert.equal(sent.length, 2)
  await runOperations({ ...args, board: board('occupied', third + 5 * 60000), now: third + 5 * 60000 })
  assert.equal(sent.length, 2, '同一小时即使状态变化也只检查/播报一次')
  assert.equal(broadcastWindow(normalizeOperationsConfig({}), AT - 3600000), null)
  assert.equal(broadcastWindow(normalizeOperationsConfig({}), AT + 10 * 60000), null)
  assert.ok(broadcastWindow(normalizeOperationsConfig({}), Date.parse('2026-11-10T14:00:00Z')))
  assert.equal(broadcastWindow(normalizeOperationsConfig({}), Date.parse('2026-11-10T15:00:00Z')), null)
})

test('群发送失败允许窗口内冷却后重试，成功hash只在实际送达时更新', async () => {
  const store = createMemoryStore()
  let calls = 0
  const broadcast = async () => { calls++; return { ok: calls > 1, error: 'network failed' } }
  const args = { store, env: {}, broadcast }
  const first = await runOperations({ ...args, board: board('idle'), now: AT })
  assert.equal(first.broadcast.reason, 'failed')
  assert.equal((await store.get('operations:broadcast:b1')).successHash, undefined)
  await runOperations({ ...args, board: board('idle', AT + 1000), now: AT + 1000 })
  assert.equal(calls, 1)
  await runOperations({ ...args, board: board('idle', AT + 60000), now: AT + 60000 })
  assert.equal(calls, 2)
  assert.ok((await store.get('operations:broadcast:b1')).successHash)
  assert.equal((await store.get('operations:alerts')).length, 1)
})

test('未取仅为任务过期5分钟后的派生状态，不把衣物占用当设备故障', async () => {
  const store = createMemoryStore()
  await store.put('occupancy:b1', { '1': { userId: 'a', taskId: 't' } })
  await store.put('tasks:a', [{ id: 't', machineId: '1', endAt: new Date(AT - 6 * 60000).toISOString() }])
  let r = await runOperations({ store, board: board('idle'), now: AT })
  assert.equal(machine(r.board).suspectedUncollected, true)
  assert.equal(machine(r.board).state, 'idle')
  r = await runOperations({ store, board: board('occupied'), now: AT })
  assert.equal(machine(r.board).suspectedUncollected, false)
  await store.put('tasks:a', [{ id: 't', machineId: '1', endAt: new Date(AT - 6 * 60000).toISOString(), takenAt: new Date(AT).toISOString() }])
  r = await runOperations({ store, board: board('idle'), now: AT })
  assert.equal(machine(r.board).suspectedUncollected, false)
})

test('预约开始时间以实际finishAt加前序时长累计，无结束时间采取保守估计', () => {
  const list = [{ userId: 'a', machineId: 'dry', durationMin: 60 }, { userId: 'b', machineId: 'dry', durationMin: 90 }]
  const end = new Date(AT + 40 * 60000).toISOString()
  let schedule = buildQueueSchedule(list, [{ id: 'dry', kind: 'dryer', state: 'occupied', finishAt: end }], AT)
  assert.equal(schedule[0].startAt, end)
  assert.equal(schedule[1].startAt, new Date(AT + 100 * 60000).toISOString())
  schedule = buildQueueSchedule(list, [{ id: 'dry', kind: 'dryer', state: 'occupied' }], AT)
  assert.equal(schedule[0].waitMin, 60)
  assert.equal(schedule[0].uncertain, true)
  schedule = buildQueueSchedule(list.slice(1), [{ id: 'dry', kind: 'dryer', state: 'occupied', finishAt: end }], AT)
  assert.equal(schedule[0].position, 1)
  assert.equal(schedule[0].startAt, end)
})

test('管理员告警持久去重、上限100，通知失败明确记录且不刷屏', async () => {
  const store = createMemoryStore()
  let notices = 0
  const notify = async () => { notices++; throw new Error('dm unavailable') }
  const first = await recordAdminAlert(store, { key: 'same', title: '故障' }, { now: AT, notify })
  const second = await recordAdminAlert(store, { key: 'same', title: '故障' }, { now: AT + 1000, notify })
  assert.equal(first.id, second.id)
  assert.equal(second.count, 2)
  assert.equal(notices, 1)
  assert.equal(second.channels.dm.ok, false)
  assert.equal(second.channels.dm.error, 'dm unavailable')
  for (let i = 0; i < 101; i++) await recordAdminAlert(store, { key: 'unique-' + i }, { now: AT + i })
  assert.equal((await store.get('operations:alerts')).length, 100)
})
