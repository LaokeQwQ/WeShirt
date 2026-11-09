import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../packages/core/store.js'
import { runOperations } from '../packages/core/operations.js'
import { processQueueReminders } from '../packages/core/queue-reminders.js'

const AT = Date.parse('2026-11-10T00:01:00Z')
const catalog = [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园', enabled: false }]
const iso = (at) => new Date(at).toISOString()
const device = (id, dormBuilding, state = 'occupied') => ({ id, name: '设备', dormBuilding, state, rawState: state === 'occupied' ? 2 : 1, finishAt: state === 'occupied' ? iso(AT + 2 * 60000) : null })
const board = (list, at = AT) => ({ buildingId: 'b1', updatedAt: iso(at), floors: [{ code: '1F', machines: list }] })
async function queueFixture(list) {
  const store = createMemoryStore()
  await store.put('user:reader', { id: 'reader', notifyOn: true })
  await store.put('queue:b1', list.map((machine) => ({ id: 'q_' + machine.id, machineId: machine.id, userId: 'reader', at: iso(AT - 1000) })))
  return store
}

test('hourly hash and counts omit disabled devices while diagnostic board remains complete', async () => {
  const store = createMemoryStore(), sent = []
  const enabled = device('enabled', 'guiyuan', 'idle'), disabled = device('disabled', 'liuyuan', 'idle')
  const args = { store, env: { SITE_BUILDINGS: catalog }, broadcast: async (payload) => { sent.push(payload.board); return { ok: true } } }
  const first = await runOperations({ ...args, board: board([enabled, disabled]), now: AT })
  assert.equal(first.board.total, 2)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].total, 1)
  assert.equal(sent[0].idle, 1)
  assert.deepEqual(sent[0].floors[0].machines.map((machine) => machine.id), ['enabled'])
  assert.deepEqual(JSON.parse((await store.get('operations:broadcast:b1')).successHash).map(([id]) => id), ['enabled'])
  const next = AT + 3600000
  const unchanged = await runOperations({ ...args, board: board([enabled, { ...disabled, state: 'occupied', rawState: 2 }], next), now: next })
  assert.equal(unchanged.broadcast.reason, 'unchanged')
  assert.equal(sent.length, 1, 'disabled-only changes do not trigger an hourly summary')
})

test('only-disabled snapshots never emit an empty public broadcast', async () => {
  const store = createMemoryStore()
  const result = await runOperations({ store, env: { SITE_BUILDINGS: catalog }, board: board([device('disabled', 'liuyuan')]), now: AT,
    broadcast: async () => { assert.fail('disabled-only snapshot must not be sent') } })
  assert.equal(result.broadcast.reason, 'unchanged')
  assert.equal(result.board.total, 1)
})

test('broadcast rechecks a building disabled after the attempt was reserved', async () => {
  const store = createMemoryStore(), put = store.put
  let disabledDuringAttempt = false
  store.put = async (key, value) => {
    await put(key, value)
    if (key === 'operations:broadcast:b1' && value.attemptAt && !disabledDuringAttempt) {
      disabledDuringAttempt = true
      await put('meta:site', { buildings: catalog.map((building) => ({ ...building, enabled: false })) })
    }
  }
  const result = await runOperations({ store, env: { SITE_BUILDINGS: catalog }, board: board([device('enabled', 'guiyuan')]), now: AT,
    broadcast: async () => { assert.fail('latest disabled state must win over the earlier snapshot') } })
  assert.equal(disabledDuringAttempt, true)
  assert.equal(result.broadcast.reason, 'unchanged')
})

test('direct queue processing filters explicit and name-classified disabled buildings without hiding unknown devices', async () => {
  const list = [device('explicit', 'liuyuan'), { ...device('named'), name: '柳园洗衣机' }, device('unknown'), device('enabled', 'guiyuan')]
  const store = await queueFixture(list), sent = []
  const result = await processQueueReminders({ store, env: { SITE_BUILDINGS: catalog }, board: board(list), now: AT,
    notify: async (_, notice) => { sent.push(notice.machineId); return { ok: true } } })
  assert.equal(result.created, 2)
  assert.deepEqual(sent.sort(), ['enabled', 'unknown'])
})

test('physical mapping identifies a disabled building before old alias names; missing catalog preserves default compatibility', async () => {
  const machine = { ...device('alias'), name: '柳园别名设备' }, store = await queueFixture([machine])
  const snapshot = { ...board([machine]), slotMapping: { D1: machine.id } }
  assert.equal((await processQueueReminders({ store, env: { SITE_BUILDINGS: [{ code: 'guiyuan', name: '桂园', enabled: false }, { code: 'liuyuan', name: '柳园' }] }, board: snapshot, now: AT,
    notify: async () => { assert.fail('physical building is disabled') } })).created, 0)
  assert.equal((await processQueueReminders({ store, board: snapshot, now: AT, notify: async () => ({ ok: true }) })).sent, 1)
})

test('queue delivery rechecks site configuration after notices were created, leaving a retry possible after re-enable', async () => {
  const machine = device('enabled', 'guiyuan'), store = await queueFixture([machine]), put = store.put
  let changed = false
  store.put = async (key, value) => {
    await put(key, value)
    if (key === 'queue-reminder-state:b1' && !changed) {
      changed = true
      await put('meta:site', { buildings: catalog.map((building) => ({ ...building, enabled: false })) })
    }
  }
  const args = { store, env: { SITE_BUILDINGS: catalog }, board: board([machine]), now: AT }
  const stopped = await processQueueReminders({ ...args, notify: async () => { assert.fail('disabled before dispatch') } })
  assert.equal(stopped.created, 1)
  assert.equal(stopped.sent, 0)
  assert.equal((await store.get('queue-notices:reader'))[0].dm.attempts, 0)
  await put('meta:site', { buildings: catalog })
  assert.equal((await processQueueReminders({ ...args, notify: async () => ({ ok: true }) })).sent, 1)
})

test('queue reminders do not create notices for disabled or blocked users', async () => {
  for (const field of ['disabled', 'blocked']) {
    const machine = device('enabled', 'guiyuan'), store = await queueFixture([machine])
    await store.put('user:reader', { id: 'reader', notifyOn: true, [field]: true })
    const result = await processQueueReminders({ store, board: board([machine]), now: AT,
      notify: async () => { assert.fail('suspended users must not be notified') } })
    assert.equal(result.created, 0)
  }
})
