import test from 'node:test'
import assert from 'node:assert/strict'
import { projectMachinePlacement } from '../packages/core/machine-labels.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createApp, runSync } from '../server/app.js'

test('bound physical dryer moves to its first-floor room without dropping a machine or altering upstream data', () => {
  const board = { total: 3, slotMapping: { '1': 'washer', D1: 'dryer' }, floors: [
    { code: '1', machines: [{ id: 'washer', floorCode: '1' }] },
    { code: '4', machines: [{ id: 'dryer', floorCode: '4' }, { id: 'unbound', floorCode: '4' }] },
  ] }
  const result = projectMachinePlacement(board)
  assert.equal(result.total, 3)
  assert.deepEqual(result.floors.map(f => [f.code, f.machines.map(m => m.id)]), [['1', ['washer', 'dryer']], ['4', ['unbound']]])
  const dryer = result.floors[0].machines[1]
  assert.equal(dryer.floorCode, '1')
  assert.equal(dryer.originalFloorCode, '4')
  assert.deepEqual(projectMachinePlacement(result), result)
  assert.equal(board.floors[1].machines[0].floorCode, '4')
})

test('unambiguous valid room slots determine placement and empty incorrect floors disappear', () => {
  const board = { floors: [{ code: '4', machines: [{ id: 'dryer', floorCode: '4' }] }] }
  assert.deepEqual(projectMachinePlacement(board, { D1: 'dryer' }).floors.map(f => f.code), ['1'])
  assert.equal(projectMachinePlacement(board, { invalid: 'dryer' }).floors[0].code, '4')
  assert.equal(projectMachinePlacement(board, { D1: 'dryer', D2: 'dryer' }).floors[0].code, '4')
})

test('public and administrator views use the same confirmed room location for cached wrong upstream floors', async t => {
  const now = Date.parse('2030-01-01T00:00:00Z')
  t.mock.timers.enable({ apis: ['Date'], now })
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No external requests in this fixture') })
  const store = createMemoryStore()
  const env = { BUILDING_ID: 'b1', HAIER_MODE: 'mock', ADMIN_TOKEN: 'placement-fixture-admin', AUTH_SECRET: 'placement-fixture-long-secret' }
  await store.put('meta:sync', { lastAttemptAt: now, lastFetchAt: new Date(now).toISOString() })
  await store.put('mapping:b1', { mapping: { D1: 'dryer' } })
  await store.put('machines:b1', { board: { updatedAt: new Date(now).toISOString(), total: 1, floors: [
    { code: '4', machines: [{ id: 'dryer', name: '上游机器名', floorCode: '4', kind: 'dryer', state: 'idle' }] },
  ] } })
  const app = createApp({ store, env })
  const publicResponse = await app.request('/api/machines?dorm=guiyuan')
  const adminResponse = await app.request('/api/admin/machines?dorm=guiyuan', { headers: { 'x-admin-token': env.ADMIN_TOKEN } })
  assert.equal(publicResponse.status, 200)
  assert.equal(adminResponse.status, 200)
  const publicBoard = (await publicResponse.json()).board
  const admin = (await adminResponse.json()).rows
  assert.deepEqual(publicBoard.floors.map(f => f.code), ['1'])
  assert.equal(publicBoard.floors[0].machines[0].slot, 'D1')
  assert.equal(admin[0].floor, '1')
  assert.equal(admin[0].displayName, publicBoard.floors[0].machines[0].displayName)
  assert.equal(publicBoard.total, 1)
})

test('each new platform sync keeps a bound dryer on the confirmed floor even when upstream repeats its mistaken floor', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No external requests in this fixture') })
  const store = createMemoryStore(), env = { BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('mapping:b1', { mapping: { D1: 'dryer' } })
  for (let i = 0; i < 2; i++) {
    const result = await runSync(env, store, { raws: [{ id: 'dryer', name: '桂园烘干机', floorCode: '4', state: 1, categoryCode: '02' }] })
    assert.equal(result.error, null)
    const board = (await store.get('machines:b1')).board
    assert.deepEqual(board.floors.map(f => f.code), ['1'])
    assert.equal(board.floors[0].machines[0].originalFloorCode, '4')
    assert.equal(board.total, 1)
  }
})
