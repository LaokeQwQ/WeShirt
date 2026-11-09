import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createMemoryStore } from '../packages/core/store.js'
import { defaultLaundryPreferences, laundryPreferencesKey, validateLaundryPreferences, scopedFavoriteMachines, favoriteReminderWindows, processFavoriteReminders, syncFavoriteReminderIndex, FAVORITE_REMINDER_INDEX } from '../packages/core/favorites.js'
import { registerFavoriteRoutes } from '../server/favorites.js'

const now = Date.parse('2026-11-09T10:00:00Z') // Monday 18:00 in Shanghai.
const window = { start: '18:00', end: '22:00', days: [1] }
const boardAt = (at) => ({ buildingId: 'b1', updatedAt: new Date(at).toISOString(), floors: [{ code: '1F', machines: [{ id: 'raw-device-sensitive-1', name: '一号洗衣机', dormBuilding: 'guiyuan', state: 'idle' }, { id: 'other-dorm-machine', name: '柳园二号', state: 'idle' }, { id: '1F-D1', name: '1F-D1', kind: 'dryer', state: 'idle' }] }] })
async function fixture() {
  const store = createMemoryStore()
  await store.put('user:u_a', { id: 'u_a', dormBuilding: 'guiyuan', notifyOn: true })
  await store.put('user:u_b', { id: 'u_b', dormBuilding: 'liuyuan', notifyOn: true })
  const app = new Hono()
  registerFavoriteRoutes(app, { store, env: {}, authenticate: async (c) => c.req.header('x-user'), getBoard: async () => boardAt(now) })
  const req = async (path, body, method = body === undefined ? 'GET' : 'POST', user = 'u_a') => {
    const response = await app.request(path, { method, headers: { ...(user ? { 'x-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  return { store, req }
}
async function subscribed(store, patch = {}) {
  const preferences = { favorites: ['raw-device-sensitive-1'], enabled: true, timeWindows: [window], ...patch }
  await store.put(laundryPreferencesKey('u_a'), preferences)
  await syncFavoriteReminderIndex(store, 'u_a', true)
  return preferences
}

test('preferences default disabled; authentication and bound-dorm favorites enforced without crossing users', async () => {
  const { req, store } = await fixture()
  assert.deepEqual((await req('/api/user/laundry-preferences')).data.preferences, defaultLaundryPreferences())
  assert.equal((await req('/api/user/favorites', undefined, 'GET', null)).status, 401)
  assert.equal((await req('/api/user/favorites/toggle', { machineId: 'other-dorm-machine' })).status, 400)
  assert.equal((await req('/api/user/favorites/toggle', { machineId: 'raw-device-sensitive-1' })).status, 200)
  assert.deepEqual((await req('/api/user/favorites')).data.preferences.favorites, ['raw-device-sensitive-1'])
  assert.deepEqual((await req('/api/user/favorites', undefined, 'GET', 'u_b')).data.preferences.favorites, [])
  assert.equal(await store.get(laundryPreferencesKey('u_b'), null), null)
  assert.equal((await req('/api/user/laundry-preferences', { enabled: true, timeWindows: [window] }, 'PATCH')).status, 200)
  assert.deepEqual(await store.get(FAVORITE_REMINDER_INDEX), ['u_a'])
  assert.equal((await req('/api/user/laundry-preferences', { enabled: false }, 'PATCH')).status, 200)
  assert.deepEqual(await store.get(FAVORITE_REMINDER_INDEX), [])
})

test('validation is atomic; rejects foreign IDs, unknown fields, malformed time/day, too many favorites/windows', async () => {
  const { req, store } = await fixture()
  await req('/api/user/laundry-preferences', { favorites: ['raw-device-sensitive-1'], enabled: true, timeWindows: [window] }, 'PATCH')
  const previous = JSON.stringify(await store.get(laundryPreferencesKey('u_a')))
  for (const patch of [{ favorites: ['other-dorm-machine'] }, { userId: 'u_b' }, { enabled: 'true' }, { favorites: Array(21).fill('raw-device-sensitive-1') }, { timeWindows: Array(4).fill(window) }, { timeWindows: [{ ...window, start: '25:00' }] }, { timeWindows: [{ ...window, end: '18:00' }] }, { timeWindows: [{ ...window, days: [0] }] }, { timeWindows: [{ ...window, days: [] }] }]) {
    assert.equal((await req('/api/user/laundry-preferences', patch, 'PATCH')).status, 400)
    assert.equal(JSON.stringify(await store.get(laundryPreferencesKey('u_a'))), previous)
  }
})

test('simultaneous toggles serialize per-user and removing last favorite disables/removes subscriber', async () => {
  const { req, store } = await fixture()
  await Promise.all([req('/api/user/favorites/toggle', { machineId: 'raw-device-sensitive-1' }), req('/api/user/favorites/toggle', { machineId: 'raw-device-sensitive-1' })])
  assert.deepEqual((await req('/api/user/favorites')).data.preferences.favorites, [])
  await req('/api/user/laundry-preferences', { favorites: ['raw-device-sensitive-1'], enabled: true, timeWindows: [window] }, 'PATCH')
  const removed = await req('/api/user/favorites/toggle', { machineId: 'raw-device-sensitive-1' })
  assert.equal(removed.data.preferences.enabled, false)
  assert.deepEqual(await store.get(FAVORITE_REMINDER_INDEX), [])
})

test('cross-midnight window keeps starting weekday/date, exact end excluded and Sunday wraps to Monday', () => {
  const windows = [{ start: '23:00', end: '02:00', days: [7] }]
  const late = favoriteReminderWindows(windows, Date.parse('2026-11-08T15:30:00Z'))
  const midnight = favoriteReminderWindows(windows, Date.parse('2026-11-08T16:30:00Z'))
  assert.equal(late[0].key, midnight[0].key)
  assert.equal(midnight[0].day, '2026-11-08')
  assert.equal(midnight[0].startAt, Date.parse('2026-11-08T15:00:00Z'))
  assert.equal(favoriteReminderWindows(windows, Date.parse('2026-11-08T18:00:00Z')).length, 0)
  assert.equal(favoriteReminderWindows(windows, Date.parse('2026-11-09T15:30:00Z')).length, 0)
})

test('reminder queries only maintained subscriber index, scopes idle machines and never puts raw device IDs in text', async () => {
  const { store } = await fixture()
  await subscribed(store, { favorites: ['raw-device-sensitive-1', '1F-D1', 'other-dorm-machine'] })
  store.list = async () => { throw new Error('must never scan users') }
  const notices = []
  const result = await processFavoriteReminders({ store, board: boardAt(now), env: { PUBLIC_ORIGIN: 'https://example.com' }, now, notify: async (uid, notice) => { notices.push({ uid, notice }); return { ok: true } } })
  assert.equal(result.scanned, 1)
  assert.equal(result.sent, 1)
  assert.equal(notices[0].uid, 'u_a')
  assert.ok(notices[0].notice.text.includes('一号洗衣机'))
  assert.equal(notices[0].notice.text.includes('raw-device-sensitive-1'), false)
  assert.equal(notices[0].notice.text.includes('other-dorm-machine'), false)
  assert.equal(notices[0].notice.text.includes('1F-D1'), false)
  assert.equal(notices[0].notice.url, 'https://example.com/#/list')
})

test('successful reminders occur at most every 30min and three per occurrence, without sync resets', async () => {
  const { store } = await fixture()
  await subscribed(store)
  let sends = 0
  const check = (at) => processFavoriteReminders({ store, board: boardAt(at), now: at, notify: async () => { sends++; return { ok: true } } })
  await check(now)
  await check(now + 5 * 60000)
  await check(now + 29 * 60000)
  await check(now + 30 * 60000)
  await check(now + 60 * 60000)
  await check(now + 90 * 60000)
  assert.equal(sends, 3)
  const state = await store.get('favorite-reminders:u_a')
  assert.equal(Object.values(state.windows)[0].count, 3)
})

test('failed notify and thrown errors do not consume success quota; retry cools down 5min', async () => {
  const { store } = await fixture()
  await subscribed(store)
  let attempts = 0
  const check = (at) => processFavoriteReminders({ store, board: boardAt(at), now: at, notify: async () => { attempts++; if (attempts === 1) throw new Error('mock failure'); if (attempts === 2) return { ok: false }; return { ok: true } } })
  await check(now)
  await check(now + 4 * 60000)
  assert.equal(attempts, 1)
  await check(now + 5 * 60000)
  assert.equal(Object.keys((await store.get('favorite-reminders:u_a')).windows).length, 0)
  await check(now + 10 * 60000)
  assert.equal(attempts, 3)
  assert.equal(Object.values((await store.get('favorite-reminders:u_a')).windows)[0].count, 1)
})

test('stale/future snapshots, notify disabled, outside window and non-idle machines never remind', async () => {
  const { store } = await fixture()
  await subscribed(store)
  let sends = 0
  const notify = async () => { sends++; return { ok: true } }
  await processFavoriteReminders({ store, board: boardAt(now - 8 * 60000), now, notify })
  await processFavoriteReminders({ store, board: boardAt(now + 60000), now, notify })
  await store.put('user:u_a', { id: 'u_a', dormBuilding: 'guiyuan', notifyOn: false })
  await processFavoriteReminders({ store, board: boardAt(now), now, notify })
  await store.put('user:u_a', { id: 'u_a', dormBuilding: 'guiyuan', notifyOn: true })
  const running = boardAt(now); running.floors[0].machines[0].state = 'occupied'
  await processFavoriteReminders({ store, board: running, now, notify })
  await processFavoriteReminders({ store, board: boardAt(now - 60000), now: now - 60000, notify })
  assert.equal(sends, 0)
})

test('own registration since window start permanently stops this occurrence, canceled or foreign tasks do not', async () => {
  const { store } = await fixture()
  await subscribed(store)
  let sends = 0
  const notify = async () => { sends++; return { ok: true } }
  await store.put('tasks:u_b', [{ startAt: new Date(now).toISOString() }])
  await store.put('tasks:u_a', [{ startAt: new Date(now).toISOString(), cancelledAt: new Date(now).toISOString() }])
  await processFavoriteReminders({ store, board: boardAt(now), now, notify })
  assert.equal(sends, 1)
  await store.put('tasks:u_a', [{ startAt: new Date(now + 60000).toISOString(), external: true, done: true }])
  await processFavoriteReminders({ store, board: boardAt(now + 30 * 60000), now: now + 30 * 60000, notify })
  await store.put('tasks:u_a', [])
  await processFavoriteReminders({ store, board: boardAt(now + 60 * 60000), now: now + 60 * 60000, notify })
  assert.equal(sends, 1)
  assert.equal(Object.values((await store.get('favorite-reminders:u_a')).windows)[0].stopped, true)
})

test('cross-midnight occurrence retains quota and next starting date receives a new quota', async () => {
  const { store } = await fixture()
  await subscribed(store, { timeWindows: [{ start: '23:00', end: '02:00', days: [1, 2] }] })
  let sends = 0
  const check = (at) => processFavoriteReminders({ store, board: boardAt(at), now: at, notify: async () => { sends++; return { ok: true } } })
  const monday23 = Date.parse('2026-11-09T15:00:00Z')
  await check(monday23); await check(monday23 + 30 * 60000); await check(monday23 + 60 * 60000); await check(monday23 + 90 * 60000)
  assert.equal(sends, 3)
  await check(monday23 + 24 * 3600000)
  assert.equal(sends, 4)
})

test('a registration stops reminders while machine is busy, even if task is later removed', async () => {
  const { store } = await fixture()
  await subscribed(store)
  await store.put('tasks:u_a', [{ startAt: new Date(now).toISOString(), external: true }])
  const busy = boardAt(now); busy.floors[0].machines[0].state = 'occupied'
  let sends = 0
  const notify = async () => { sends++; return { ok: true } }
  await processFavoriteReminders({ store, board: busy, now, notify })
  await store.put('tasks:u_a', [])
  await processFavoriteReminders({ store, board: boardAt(now + 30 * 60000), now: now + 30 * 60000, notify })
  assert.equal(sends, 0)
  assert.equal(Object.values((await store.get('favorite-reminders:u_a')).windows)[0].stopped, true)
})

test('disabled users are removed from index; overlapping windows cannot multiply notification frequency', async () => {
  const { store } = await fixture()
  await subscribed(store, { timeWindows: [window, { start: '18:00', end: '21:00', days: [1] }] })
  let sends = 0
  await Promise.all(Array.from({ length: 4 }, () => processFavoriteReminders({ store, board: boardAt(now), now, notify: async () => { sends++; return { ok: true } } })))
  assert.equal(sends, 1)
  await store.put(laundryPreferencesKey('u_a'), { favorites: [], enabled: false, timeWindows: [] })
  await processFavoriteReminders({ store, board: boardAt(now), now, notify: async () => ({ ok: true }) })
  assert.deepEqual(await store.get(FAVORITE_REMINDER_INDEX), [])
})

test('custom building catalog is honored and component script/template compile', async () => {
  const { req, store } = await fixture()
  await store.put('meta:site', { buildings: [{ code: 'custom', name: '自定义宿舍' }] })
  await store.put('user:u_a', { id: 'u_a', dormBuilding: 'custom' })
  assert.equal((await req('/api/user/laundry-preferences')).status, 200)
  const file = 'frontend/src/components/FavoriteSettings.vue'
  const { descriptor, errors } = parse(await readFile(new URL('../' + file, import.meta.url), 'utf8'), { filename: file })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: file })
  assert.deepEqual(compileTemplate({ id: file, source: descriptor.template.content, filename: file, compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
})

test('favorite display uses trusted slot labels ahead of ambiguous upstream names', () => {
  const board = { floors: [{ code: '1F', machines: [{ id: 'alias', name: '柳园西', kind: 'washer', state: 'idle' }] }] }
  const machines = scopedFavoriteMachines({ board, mapping: { D1: 'alias' } }, { dormBuilding: 'guiyuan' })
  assert.equal(machines[0].name, '1号烘干机')
  assert.equal(machines[0].kind, 'dryer')
  const raw = scopedFavoriteMachines({ floors: [{ code: '1F', machines: [{ id: 'private-device-id', name: '洗衣机 private-device-id', dormBuilding: 'guiyuan' }, { id: 'raw2', name: '1234567890123456', dormBuilding: 'guiyuan' }] }] }, { dormBuilding: 'guiyuan' })
  assert.equal(raw[0].name.includes('private-device-id'), false)
  assert.equal(raw[1].name, '洗衣机')
})
