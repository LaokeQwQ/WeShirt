import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../packages/core/store.js'
import { processQueueReminders, readQueueNotices } from '../packages/core/queue-reminders.js'
import { processFavoriteReminders } from '../packages/core/favorites.js'

const AT = Date.parse('2026-11-10T00:00:00Z')
const MINUTE = 60000
const iso = (ms) => new Date(ms).toISOString()
function board(now, { state = 'idle', finishAt = null, report = false, estimated = false } = {}) {
  return { buildingId: 'b1', updatedAt: iso(now), floors: [{ code: '1', machines: [{ id: 'm1', name: '测试洗衣机',
    dormBuilding: 'guiyuan', kind: 'washer', state: report ? 'occupied' : state, upstreamState: state,
    rawState: state === 'idle' ? 1 : state === 'occupied' ? 2 : state, finishAt: finishAt == null ? null : iso(finishAt),
    estimated: report || estimated,
    ...(report ? { availabilitySource: 'user_report', registrationPending: true } : {}),
  }] }] }
}
async function fixture() {
  const store = createMemoryStore()
  await store.put('user:u1', { id: 'u1', nick: '排队用户', notifyOn: true, dormBuilding: 'guiyuan' })
  await store.put('queue:b1', [{ id: 'q1', userId: 'u1', machineId: 'm1', at: iso(AT - MINUTE) }])
  const sent = []
  const run = (snapshot, now) => processQueueReminders({ store, board: snapshot, now, notify: async (uid, notice) => { sent.push(notice); return { ok: true } } })
  return { store, sent, run }
}

test('future registration plus raw idle never becomes a hardware end; its lead clearly identifies registration time', async () => {
  const { store, run, sent } = await fixture()
  const end = AT + 20 * MINUTE
  assert.equal((await run(board(AT, { report: true, finishAt: end }), AT)).created, 0)
  assert.equal((await run(board(AT + MINUTE, { report: true, finishAt: end }), AT + MINUTE)).created, 0)
  await run(board(AT + 17 * MINUTE, { report: true, finishAt: end }), AT + 17 * MINUTE)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].phase, 'lead')
  assert.equal(sent[0].availabilitySource, 'user_report')
  assert.match(sent[0].text, /登记计时约 3 分钟/)
  assert.match(sent[0].markdown, /登记计时约 3 分钟/)
  assert.equal(sent[0].confirmed, false)
  assert.doesNotMatch(sent[0].text, /机器已结束|已结束洗衣/)
  assert.equal((await readQueueNotices(store, 'u1'))[0].availabilitySource, 'user_report')
})

test('at registration deadline, removed projection yields only an estimated timer notice; repeated idle is deduplicated', async () => {
  const { run, sent } = await fixture()
  const end = AT + 2 * MINUTE
  await run(board(AT, { report: true, finishAt: end }), AT)
  // The availability helper removes registrationPending at the exact task deadline.
  await run(board(end), end)
  await run(board(end + MINUTE), end + MINUTE)
  const notices = sent.filter((notice) => notice.phase === 'end')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].title, '登记计时已到')
  assert.equal(notices[0].confirmed, false)
  assert.equal(notices[0].estimated, true)
  assert.match(notices[0].text, /用户登记计时已到/)
  assert.doesNotMatch(notices[0].text, /已结束洗衣|机器已结束/)
})

test('a preceding hardware cycle cannot complete early when a future local registration keeps the machine occupied', async () => {
  const { run, sent } = await fixture()
  await run(board(AT, { state: 'occupied', finishAt: AT + 2 * MINUTE }), AT)
  await run(board(AT + MINUTE, { report: true, finishAt: AT + 20 * MINUTE }), AT + MINUTE)
  await run(board(AT + 3 * MINUTE, { report: true, finishAt: AT + 20 * MINUTE }), AT + 3 * MINUTE)
  assert.equal(sent.filter((notice) => notice.phase === 'end').length, 0)
})

test('actual occupied updates replace registration deadline; expiry of the old user time never finishes the hardware cycle', async () => {
  const { run, sent } = await fixture()
  await run(board(AT, { report: true, finishAt: AT + 2 * MINUTE }), AT)
  await run(board(AT + MINUTE, { state: 'occupied', finishAt: AT + 20 * MINUTE }), AT + MINUTE)
  await run(board(AT + 3 * MINUTE, { state: 'occupied', finishAt: AT + 20 * MINUTE }), AT + 3 * MINUTE)
  assert.equal(sent.filter((notice) => notice.phase === 'end').length, 0)
  await run(board(AT + 20 * MINUTE, { state: 'occupied', finishAt: AT + 20 * MINUTE }), AT + 20 * MINUTE)
  assert.equal(sent.filter((notice) => notice.phase === 'end').length, 0, 'actual occupied does not confirm completion at any timer deadline')
  await run(board(AT + 21 * MINUTE), AT + 21 * MINUTE)
  await run(board(AT + 22 * MINUTE), AT + 22 * MINUTE)
  const end = sent.filter((notice) => notice.phase === 'end')
  assert.equal(end.length, 1)
  assert.equal(end[0].confirmed, true)
  assert.equal(end[0].availabilitySource, 'upstream')
})

test('hardware running without a new end time discards the old registration timer and confirms only a subsequent idle', async () => {
  const { run, sent } = await fixture()
  await run(board(AT, { report: true, finishAt: AT + 2 * MINUTE }), AT)
  await run(board(AT + MINUTE, { state: 'occupied' }), AT + MINUTE)
  await run(board(AT + 3 * MINUTE, { state: 'occupied' }), AT + 3 * MINUTE)
  assert.equal(sent.filter((notice) => notice.phase === 'end').length, 0)
  await run(board(AT + 4 * MINUTE), AT + 4 * MINUTE)
  await run(board(AT + 5 * MINUTE), AT + 5 * MINUTE)
  assert.equal(sent.filter((notice) => notice.phase === 'end').length, 1)
  assert.equal(sent.at(-1).confirmed, true)
})

test('waiters arriving after a registration timer has ended do not inherit its old end notice', async () => {
  const { store, run, sent } = await fixture()
  await run(board(AT, { report: true, finishAt: AT + 2 * MINUTE }), AT)
  await store.put('queue:b1', [{ id: 'new', userId: 'u1', machineId: 'm1', at: iso(AT + 3 * MINUTE) }])
  await run(board(AT + 4 * MINUTE), AT + 4 * MINUTE)
  assert.equal(sent.filter((notice) => notice.phase === 'end').length, 0)
})

test('favorite reminders do not announce a registered projected occupied machine as idle', async () => {
  const { store } = await fixture()
  await store.put('favorite-reminder-users', ['u1'])
  await store.put('laundry-preferences:u1', { favorites: ['m1'], enabled: true, timeWindows: [{ start: '07:00', end: '09:00', days: [1, 2, 3, 4, 5, 6, 7] }] })
  let calls = 0
  const notify = async () => { calls++; return { ok: true } }
  const projected = board(AT, { report: true, finishAt: AT + 20 * MINUTE })
  assert.equal((await processFavoriteReminders({ store, board: projected, now: AT, notify })).sent, 0)
  assert.equal(calls, 0)
  assert.equal((await processFavoriteReminders({ store, board: board(AT), now: AT, notify })).sent, 1, 'same preference works for an actually available machine')
})
