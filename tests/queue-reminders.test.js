import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMemoryStore } from '../packages/core/store.js'
import { processQueueReminders, readQueueNotices, markQueueNoticeRead } from '../packages/core/queue-reminders.js'
import { registerQueueNoticeRoutes } from '../server/queue-reminders.js'

const AT = Date.parse('2026-11-10T00:00:00Z')
function board(state = 'occupied', finish = AT + 2 * 60000) {
  return { buildingId: 'b1', updatedAt: new Date(AT).toISOString(), floors: [{ code: '1', machines: [{ id: 'm1', name: '1号洗衣机', kind: 'washer', state, rawState: state, finishAt: finish ? new Date(finish).toISOString() : null }] }] }
}
async function fixture() {
  const store = createMemoryStore()
  await store.put('user:u1', { id: 'u1', nick: '甲', notifyOn: true })
  await store.put('queue:b1', [{ id: 'q1', userId: 'u1', machineId: 'm1', at: new Date(AT - 1000).toISOString(), durationMin: 30 }])
  return store
}

test('only current queue head receives one lead notice and retries failed DM', async () => {
  const store = await fixture()
  const sent = []
  let result = await processQueueReminders({ store, board: board('occupied', AT + 2 * 60000), env: { BUILDING_ID: 'b1' }, now: AT, notify: async (uid, notice) => { sent.push([uid, notice]); return { ok: false } } })
  assert.equal(result.created, 1)
  assert.equal(result.failed, 1)
  assert.equal((await readQueueNotices(store, 'u1')).length, 1)
  result = await processQueueReminders({ store, board: board('occupied', AT + 2 * 60000), env: { BUILDING_ID: 'b1' }, now: AT + 30000, notify: async () => ({ ok: true }) })
  assert.equal(result.created, 0)
  assert.equal(result.sent, 0, 'backoff prevents immediate retry')
  result = await processQueueReminders({ store, board: board('occupied', AT + 2 * 60000), env: { BUILDING_ID: 'b1' }, now: AT + 60000, notify: async (uid, notice) => { sent.push([uid, notice]); return { ok: true } } })
  assert.equal(result.created, 0)
  assert.equal(result.sent, 1)
  const estimated = board('occupied', AT + 2 * 60000)
  estimated.floors[0].machines[0].estimated = true
  // 新周期先观测为估时，真实结束时间不能在仍运行时当作已结束。
  await store.put('queue-reminder-state:b1', { machines: {} })
  await processQueueReminders({ store, board: estimated, now: AT, notify: async () => ({ ok: true }) })
  result = await processQueueReminders({ store, board: estimated, now: AT + 2 * 60000, notify: async (uid, notice) => { sent.push([uid, notice]); return { ok: true } } })
  assert.equal(result.created, 0)
  assert.equal(result.sent, 0)
  assert.equal(sent.at(-1)[1].phase, 'lead', 'a running machine cannot emit an end notice from its timer')
})

test('confirmed idle end notice is once per machine cycle and a new run gets a new cycle', async () => {
  const store = await fixture()
  const sent = []
  await processQueueReminders({ store, board: board('occupied', AT + 2 * 60000), now: AT, notify: async () => ({ ok: true }) })
  const idle = board('idle', null)
  idle.updatedAt = new Date(AT + 3 * 60000).toISOString()
  let out = await processQueueReminders({ store, board: idle, now: AT + 3 * 60000, notify: async (uid, notice) => { sent.push(notice); return { ok: true } } })
  assert.equal(out.created, 1)
  assert.equal(sent[0].confirmed, true)
  out = await processQueueReminders({ store, board: idle, now: AT + 4 * 60000, notify: async () => ({ ok: true }) })
  assert.equal(out.created, 0)
  const next = board('occupied', AT + 7 * 60000)
  next.updatedAt = new Date(AT + 5 * 60000).toISOString()
  out = await processQueueReminders({ store, board: next, now: AT + 5 * 60000, notify: async () => ({ ok: true }) })
  assert.equal(out.created, 1)
})

test('cancelled head does not get reminder and notification routes are user scoped', async () => {
  const store = await fixture()
  await store.put('queue:b1', [{ id: 'q1', userId: 'u1', machineId: 'm1', cancelledAt: new Date(AT - 1).toISOString() }])
  const out = await processQueueReminders({ store, board: board(), now: AT, notify: async () => { throw new Error('must not notify') } })
  assert.deepEqual(out, { created: 0, sent: 0, failed: 0, stale: false })
  const app = new Hono()
  registerQueueNoticeRoutes(app, { store, authenticate: (c) => c.req.header('x-user'), now: () => AT })
  await store.put('queue-notices:u1', [{ id: 'qn_1', phase: 'lead', machineId: 'm1', machineName: '1号洗衣机', title: '提醒', text: '内容', at: new Date(AT).toISOString(), reservationId: 'q1', buildingId: 'b1', dm: {} }])
  assert.equal((await app.request('http://local/api/queue/notices')).status, 401)
  const response = await app.request('http://local/api/queue/notices', { headers: { 'x-user': 'u1' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).notices.length, 1)
  assert.equal((await app.request('http://local/api/queue/notices/qn_1/read', { method: 'POST', headers: { 'x-user': 'u2' } })).status, 404)
  assert.equal((await app.request('http://local/api/queue/notices/qn_1/read', { method: 'POST', headers: { 'x-user': 'u1' } })).status, 200)
})

test('stale snapshots, unknown states, and notifyOff users produce no reminder', async () => {
  const store = await fixture()
  const stale = board()
  stale.updatedAt = new Date(AT - 8 * 60000).toISOString()
  assert.equal((await processQueueReminders({ store, board: stale, now: AT, notify: async () => ({ ok: true }) })).stale, true)
  await store.put('user:u1', { id: 'u1', notifyOn: false })
  const unknown = board('unknown', AT + 60000)
  assert.equal((await processQueueReminders({ store, board: unknown, now: AT, notify: async () => ({ ok: true }) })).created, 0)
  assert.equal((await processQueueReminders({ store, board: board(), now: AT, notify: async () => ({ ok: true }) })).created, 0)
})

test('two waiters: no queue shifting and only first active reservation gets lead and end', async () => {
  const store = await fixture()
  await store.put('user:u2', { id: 'u2' })
  const q = await store.get('queue:b1')
  q.unshift({ id: 'old', userId: 'u2', machineId: 'm1', status: 'cancelled' })
  q.push({ id: 'q2', userId: 'u2', machineId: 'm1', at: new Date(AT - 1000).toISOString() })
  await store.put('queue:b1', q)
  const recipients = []
  const notify = async (uid) => { recipients.push(uid); return { ok: true } }
  await processQueueReminders({ store, board: board(), now: AT, notify })
  await processQueueReminders({ store, board: { ...board('idle', null), updatedAt: new Date(AT + 2 * 60000).toISOString() }, now: AT + 2 * 60000, notify })
  assert.deepEqual(recipients, ['u1', 'u1'])
  assert.equal((await store.get('queue:b1')).length, 3)
  assert.equal((await readQueueNotices(store, 'u2')).length, 0)
})

test('latest finish time supersedes an old estimate without announcing completion while running', async () => {
  const store = await fixture()
  const first = board('occupied', AT + 2 * 60000)
  first.floors[0].machines[0].estimated = true
  const sent = []
  const notify = async (uid, notice) => { sent.push(notice); return { ok: true } }
  await processQueueReminders({ store, board: first, now: AT, notify })
  const original = (await store.get('queue-reminder-state:b1')).machines.m1
  const shifted = board('occupied', AT + 3 * 60000)
  shifted.updatedAt = new Date(AT + 60000).toISOString()
  shifted.floors[0].machines[0].estimated = true
  await processQueueReminders({ store, board: shifted, now: AT + 60000, notify })
  const later = (await store.get('queue-reminder-state:b1')).machines.m1
  assert.equal(later.id, original.id)
  assert.equal(later.finishAt, AT + 3 * 60000)
  assert.equal(sent.length, 1)
  await processQueueReminders({ store, board: shifted, now: AT + 2 * 60000, notify })
  assert.equal(sent.length, 1)
  const idle = { ...board('idle', null), updatedAt: new Date(AT + 3 * 60000).toISOString() }
  await processQueueReminders({ store, board: idle, now: AT + 3 * 60000, notify })
  assert.equal(sent.length, 2, 'the actual idle snapshot, rather than the estimate, unlocks completion')
  assert.equal(sent[1].confirmed,true)
})

test('real finish updates do not reset phase, and actual deadline alone does not assert idle', async () => {
  const store = await fixture()
  const notify = async () => ({ ok: true })
  await processQueueReminders({ store, board: board(), now: AT, notify })
  const moved = board('occupied', AT + 4 * 60000)
  moved.updatedAt = new Date(AT + 60000).toISOString()
  assert.equal((await processQueueReminders({ store, board: moved, now: AT + 60000, notify })).created, 0)
  moved.updatedAt = new Date(AT + 4 * 60000).toISOString()
  assert.equal((await processQueueReminders({ store, board: moved, now: AT + 4 * 60000, notify })).created, 0)
  const fakeIdle = board('idle', null)
  fakeIdle.updatedAt = new Date(AT + 5 * 60000).toISOString()
  fakeIdle.floors[0].machines[0].rawState = 2
  assert.equal((await processQueueReminders({ store, board: fakeIdle, now: AT + 5 * 60000, notify })).created, 0, 'display idle cannot override raw running')
  fakeIdle.floors[0].machines[0].rawState = 1
  assert.equal((await processQueueReminders({ store, board: fakeIdle, now: AT + 5 * 60000, notify })).created, 1)
})

test('DM retries end independently, backs off and stops after four attempts', async () => {
  const store = await fixture()
  let attempts = 0
  const notify = async () => { attempts++; return { ok: false } }
  await processQueueReminders({ store, board: board(), now: AT, notify: async () => ({ ok: true }) })
  for (const minute of [2, 2.5, 3, 4, 5, 8, 20]) {
    const fresh = board('idle', null)
    fresh.updatedAt = new Date(AT + minute * 60000).toISOString()
    await processQueueReminders({ store, board: fresh, now: AT + minute * 60000, notify })
  }
  assert.equal(attempts, 4)
  const notices = await readQueueNotices(store, 'u1')
  const end = notices.find((entry) => entry.phase === 'end')
  assert.equal(end.delivery.pending, false)
  assert.equal(end.delivery.sent, false)
  assert.equal(notices.find((entry) => entry.phase === 'lead').delivery.sent, true)
})

test('queue cancellation before delivery suppresses retry and unread active notice', async () => {
  const store = await fixture()
  await processQueueReminders({ store, board: board(), now: AT, notify: async () => ({ ok: false }) })
  await store.put('queue:b1', [])
  let called = false
  await processQueueReminders({ store, board: board(), now: AT + 60000, notify: async () => { called = true; return { ok: true } } })
  assert.equal(called, false)
  const history = await readQueueNotices(store, 'u1')
  assert.equal(history.length, 1)
  assert.equal(history[0].active, false)
  assert.equal(history[0].delivery.pending, false)
})

test('unread outbox retained at 30, own read idempotent, private fields omitted', async () => {
  const store = await fixture()
  const notices = Array.from({ length: 35 }, (_, i) => ({ id: 'qn_' + i, phase: 'lead', userId: 'secret', cycleId: 'secret', reservationId: 'q1', buildingId: 'b1', machineId: 'm1', at: new Date(AT + i).toISOString(), text: 'content', dm: { lastError: 'secret' } }))
  await store.put('queue-notices:u1', notices)
  let list = await readQueueNotices(store, 'u1')
  assert.equal(list.length, 30)
  assert.equal(list[0].id, 'qn_34')
  assert.equal(list[0].userId, undefined)
  assert.equal(list[0].cycleId, undefined)
  assert.equal(list[0].dm, undefined)
  assert.equal(await markQueueNoticeRead(store, 'u2', 'qn_34', AT), false)
  assert.equal(await markQueueNoticeRead(store, 'u1', 'qn_34', AT), true)
  assert.equal(await markQueueNoticeRead(store, 'u1', 'qn_34', AT + 1000), true)
  list = await readQueueNotices(store, 'u1')
  assert.equal(list[0].readAt, new Date(AT).toISOString())
})

test('parallel processing deduplicates same phase and does not list all users', async () => {
  const store = await fixture()
  store.list = () => { throw new Error('must not scan users') }
  let sent = 0
  const args = { store, board: board(), now: AT, notify: async () => { sent++; return { ok: true } } }
  const output = await Promise.all([processQueueReminders(args), processQueueReminders(args)])
  assert.equal(output.reduce((sum, item) => sum + item.created, 0), 1)
  assert.equal(sent, 1)
  assert.equal((await readQueueNotices(store, 'u1')).length, 1)
})

test('dryer labels and all sensitive promises remain factual', async () => {
  const store = await fixture()
  const drying = board()
  Object.assign(drying.floors[0].machines[0], { kind: 'dryer', displayName: '桂园 D1 烘干机', estimated: true })
  await processQueueReminders({ store, board: drying, now: AT, notify: async () => ({ ok: true }) })
  drying.updatedAt = new Date(AT + 2 * 60000).toISOString()
  await processQueueReminders({ store, board: drying, now: AT + 2 * 60000, notify: async () => ({ ok: true }) })
  const notices = await readQueueNotices(store, 'u1')
  assert.match(notices[0].text, /桂园 D1 烘干机/)
  assert.match(notices[0].text, /现场确认/)
  assert.doesNotMatch(notices[0].text, /机器已空|可以直接使用|已结束洗衣/)
})

test('failed lead follows latest finish time and never retries outside the three-minute window', async () => {
  const store = await fixture()
  await processQueueReminders({ store, board: board(), now: AT, notify: async () => ({ ok: false }) })
  let attempts = 0
  const moved = board('occupied', AT + 12 * 60000)
  moved.updatedAt = new Date(AT + 60000).toISOString()
  await processQueueReminders({ store, board: moved, now: AT + 60000, notify: async () => { attempts++; return { ok: true } } })
  assert.equal(attempts, 0)
  assert.equal((await readQueueNotices(store, 'u1'))[0].active, false)
  moved.updatedAt = new Date(AT + 9 * 60000).toISOString()
  let sent
  await processQueueReminders({ store, board: moved, now: AT + 9 * 60000, notify: async (uid, notice) => { sent = notice; return { ok: true } } })
  assert.match(sent.text, /预计 3 分钟后结束/)
  assert.equal((await readQueueNotices(store, 'u1')).length, 1)
  assert.equal((await readQueueNotices(store, 'u1'))[0].active, true)
})

test('queue notification text never repeats upstream device IDs even when used as machine names', async () => {
  const store = await fixture()
  const snapshot = board()
  snapshot.floors[0].machines[0].name = 'm1'
  await processQueueReminders({ store, board: snapshot, now: AT, notify: async () => ({ ok: true }) })
  let notices = await readQueueNotices(store, 'u1')
  assert.equal(notices[0].machineName, '洗衣机')
  assert.doesNotMatch(notices[0].text, /m1/)
  await store.put('queue-reminder-state:b1', { machines: {} })
  snapshot.floors[0].machines[0].name = '桂园m1烘干机'
  snapshot.floors[0].machines[0].kind = 'dryer'
  await processQueueReminders({ store, board: snapshot, now: AT, notify: async () => ({ ok: true }) })
  notices = await readQueueNotices(store, 'u1')
  assert.equal(notices[0].machineName, '桂园烘干机')
  assert.doesNotMatch(notices[0].text, /m1/)
})
