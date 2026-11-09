// Black-box integration: real createApp/runSync + bearer JWTs, mock upstream and no real network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSync } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'blackbox-reminder-integration-secret-2026'
const ENV = { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'integration-admin-token', BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
const allDays = [1, 2, 3, 4, 5, 6, 7]
const beijingHour = new Date(Date.now() + 8 * 3600000).getUTCHours()
const clockHour = (offset) => String((beijingHour + offset + 24) % 24).padStart(2, '0') + ':00'
const timeWindow = { start: clockHour(-1), end: clockHour(2), days: allDays }
function rawMachines({ idle = false, custom = false } = {}) {
  return [
    { id: 'g1', name: custom ? '新园一号洗衣机' : '桂园一号洗衣机', floorCode: '1', state: idle ? 1 : 2, finishAt: idle ? null : new Date(Date.now() + 120000).toISOString() },
    { id: 'g2', name: custom ? '新园二号洗衣机' : '桂园二号洗衣机', floorCode: '1', state: 1, finishAt: null },
    { id: 'l1', name: '柳园一号洗衣机', floorCode: '1', state: 1, finishAt: null },
  ]
}
async function fixture(t, { custom = false } = {}) {
  const store = createMemoryStore()
  const requests = []
  t.mock.method(globalThis, 'fetch', async (...args) => { requests.push(args[0]); throw new Error('Real network forbidden in this integration test') })
  await store.put('operations:config', { broadcast: { enabled: false, startHour: 8, endHour: 22, hours: [] } })
  await store.put('user:u1', { id: 'u1', nick: '甲', dingUserId: null, dormBuilding: custom ? 'newyard' : 'guiyuan', notifyOn: true })
  await store.put('user:u2', { id: 'u2', nick: '乙', dingUserId: null, dormBuilding: 'liuyuan', notifyOn: true })
  await store.put('user:owner', { id: 'owner', nick: '在用者', dormBuilding: custom ? 'newyard' : 'guiyuan', notifyOn: false })
  await store.put('tasks:owner', [{ id: 'owner_task', machineId: 'g1', machineName: '洗衣机', startAt: new Date(Date.now() - 20 * 60000).toISOString(), endAt: new Date(Date.now() + 120000).toISOString(), done: false }])
  await store.put('queue:b1', [
    { id: 'q1', userId: 'u1', machineId: 'g1', nick: '甲', durationMin: 30, at: new Date(Date.now() - 10000).toISOString() },
    { id: 'q2', userId: 'u2', machineId: 'g1', nick: '乙', durationMin: 30, at: new Date(Date.now() - 9000).toISOString() },
  ])
  if (custom) await store.put('meta:site', { buildings: [{ code: 'newyard', name: '新园' }, { code: 'liuyuan', name: '柳园' }] })
  const first = await runSync(ENV, store, { raws: rawMachines({ custom }) })
  assert.equal(first.error, null, JSON.stringify(first))
  const app = createApp({ store, env: { ...ENV } })
  const tokens = { u1: await issueToken('u1', SECRET), u2: await issueToken('u2', SECRET) }
  const call = async (path, { user = 'u1', method = 'GET', body } = {}) => {
    const res = await app.fetch(new Request('https://laundry.example' + path, { method,
      headers: { ...(user ? { authorization: 'Bearer ' + (tokens[user] || 'invalid') } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) }))
    return { status: res.status, data: await res.json(), cache: res.headers.get('cache-control') }
  }
  t.after(() => assert.deepEqual(requests, [], 'integration must not issue any external request'))
  return { store, app, call, first }
}

test('real runSync creates queue page notices, dedupes, targets only queue head and enforces ownership', async (t) => {
  const { store, call, first } = await fixture(t)
  assert.equal(first.queueReminders.created, 1)
  assert.equal(first.queueReminders.sent, 0)
  assert.equal((await call('/api/queue/notices', { user: null })).status, 401)
  assert.equal((await call('/api/queue/notices', { user: 'invalid' })).status, 401)
  let own = await call('/api/queue/notices')
  assert.equal(own.status, 200)
  assert.match(own.cache, /no-store/)
  assert.equal(own.data.unread, 1)
  assert.equal(own.data.notices[0].phase, 'lead')
  assert.equal(own.data.notices[0].active, true)
  assert.equal(own.data.notices[0].userId, undefined)
  assert.equal((await call('/api/queue/notices', { user: 'u2' })).data.notices.length, 0)
  const second = await runSync(ENV, store, { raws: rawMachines() })
  assert.equal(second.error, null)
  assert.equal(second.queueReminders.created, 0)
  const end = await runSync(ENV, store, { raws: rawMachines({ idle: true }) })
  assert.equal(end.error, null)
  assert.equal(end.queueReminders.created, 1)
  own = await call('/api/queue/notices')
  assert.equal(own.data.notices.length, 2)
  assert.equal(own.data.notices[0].phase, 'end')
  assert.equal(own.data.notices[0].confirmed, true)
  assert.equal((await store.get('queue:b1')).length, 2, 'notice must not advance the queue')
  const id = own.data.notices[0].id
  assert.equal((await call('/api/queue/notices/' + id + '/read', { user: 'u2', method: 'POST' })).status, 404)
  assert.equal((await call('/api/queue/notices/' + id + '/read', { method: 'POST' })).status, 200)
  assert.equal((await call('/api/queue/notices')).data.unread, 0, 'lead notice is obsolete after the machine ends')
  assert.equal((await call('/api/queue?machineId=g1', { method: 'DELETE' })).status, 200)
  own = await call('/api/queue/notices')
  assert.equal(own.data.unread, 0)
  assert.equal(own.data.notices.every((notice) => !notice.active), true)
})

test('favorite routes use bearer identity, enforce dorm scope and runSync invokes the maintained index', async (t) => {
  const { store, call } = await fixture(t)
  assert.equal((await call('/api/user/favorites', { user: null })).status, 401)
  const initial = await call('/api/user/favorites')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.data.machines.map((m) => m.id).sort(), ['g1', 'g2'])
  assert.equal((await call('/api/user/favorites/toggle', { method: 'POST', body: { machineId: 'l1' } })).status, 400)
  assert.equal((await call('/api/user/favorites/toggle', { method: 'POST', body: { machineId: 'g2' } })).status, 200)
  const enabled = await call('/api/user/laundry-preferences', { method: 'PATCH', body: { enabled: true, timeWindows: [timeWindow] } })
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data))
  assert.deepEqual(await store.get('favorite-reminder-users'), ['u1'])
  assert.deepEqual((await call('/api/user/favorites', { user: 'u2' })).data.preferences.favorites, [])
  const synced = await runSync(ENV, store, { raws: rawMachines() })
  assert.equal(synced.error, null)
  assert.equal(synced.favoriteReminders.scanned, 1)
  assert.equal(synced.favoriteReminders.sent, 0, 'unconfigured DingTalk may not be reported as delivered')
  assert.ok(await store.get('favorite-reminders:u1'), 'favorite processor must run, not just register routes')
  const switchDorm = await call('/api/user/profile', { method: 'POST', body: { dormBuilding: 'liuyuan' } })
  assert.equal(switchDorm.status, 200, JSON.stringify(switchDorm.data))
  const switched = await call('/api/user/favorites')
  assert.deepEqual(switched.data.machines.map((m) => m.id), ['l1'])
  assert.deepEqual(switched.data.preferences.favorites, [])
  assert.equal((await call('/api/user/favorites/toggle', { method: 'POST', body: { machineId: 'g2' } })).status, 400)
  assert.equal((await call('/api/user/favorites/toggle', { method: 'POST', body: { machineId: 'l1' } })).status, 200)
  assert.deepEqual((await store.get('laundry-preferences:u1')).favorites, ['l1'])
  assert.equal(await store.get('laundry-preferences:u2', null), null)
})

test('dynamic site catalog is read from persistent config by routes and reminder processor without env catalog', async (t) => {
  const { store, call } = await fixture(t, { custom: true })
  const favorite = await call('/api/user/favorites')
  assert.equal(favorite.status, 200, JSON.stringify(favorite.data))
  assert.deepEqual(favorite.data.machines.map((m) => m.id).sort(), ['g1', 'g2'])
  assert.equal((await call('/api/user/laundry-preferences', { method: 'PATCH', body: { favorites: ['g2'], enabled: true, timeWindows: [timeWindow] } })).status, 200)
  const output = await runSync({ ...ENV }, store, { raws: rawMachines({ custom: true }) })
  assert.equal(output.error, null)
  assert.equal(output.favoriteReminders.scanned, 1)
  assert.ok((await store.get('favorite-reminders:u1'))?.retryAfter > Date.now(), 'dynamic-dorm favorite reached notify callback even with missing DingTalk')
  const projected = await call('/api/machines?dorm=newyard')
  assert.equal(projected.status, 200)
  assert.equal(projected.data.board.total, 2)
})
