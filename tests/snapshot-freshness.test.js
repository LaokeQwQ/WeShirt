import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSync } from '../server/app.js'
import { createMemoryStore, createEdgeKVStore } from '../packages/core/store.js'
import { runOperations } from '../packages/core/operations.js'

const env = { AUTH_SECRET: 'snapshot-freshness-test-secret-at-least-32', BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
const raw = [{ id: 'm1', name: '测试洗衣机', state: 1 }]

test('a slow group delivery cannot hold back committing the final health and registration projection', async () => {
  const store = createMemoryStore(), now = Date.parse('2026-01-01T01:00:00Z')
  const board = { buildingId: 'b1', updatedAt: new Date(now).toISOString(), floors: [{ code: '1', machines: [{ id: 'm1', name: '测试机器', state: 'idle', dormBuilding: 'test' }] }] }
  await store.put('occupancy:b1', { m1: { userId: 'member', taskId: 'one' } })
  await store.put('tasks:member', [{ id: 'one', machineId: 'm1', endAt: new Date(now + 600000).toISOString() }])
  let release, entered
  const slow = new Promise(resolve => { release = resolve }), sending = new Promise(resolve => { entered = resolve })
  const pending = runOperations({ store, board, now, env: { SITE_BUILDINGS: [{ code: 'test', name: '测试楼' }] },
    beforeNotify: snapshot => store.put('machines:b1', { board: snapshot }),
    broadcastTargets: async () => [{ key: 'test', dormBuilding: 'test', via: 'conversation', conversationId: 'fixture-conversation' }],
    broadcast: async () => { entered(); await slow; return { ok: true } },
  })
  await sending
  assert.equal((await store.get('machines:b1')).board.floors[0].machines[0].state, 'occupied', 'the full projected board is visible before delivery finishes')
  release(); await pending
})

test('failed housekeeping or reminder enumeration does not discard a successfully captured board or mark upstream capture failed', async () => {
  for (const stage of ['assistant_cleanup', 'reminders']) {
    const store = createMemoryStore(), get = store.get.bind(store), list = store.list.bind(store)
    store.get = (key, fallback) => key === 'assistant:lastPrune' && stage === 'assistant_cleanup' ? Promise.reject(new Error('private provider error')) : get(key, fallback)
    store.list = prefix => prefix === 'tasks:' && stage === 'reminders' ? Promise.reject(new Error('private provider error')) : list(prefix)
    await store.put('operations:config', { broadcast: { enabled: false } })
    const result = await runSync(env, store, { raws: raw })
    assert.equal(result.error, null)
    assert.equal(result.fetched, 1)
    assert.equal(result.maintenance.stage, stage)
    assert.equal(JSON.stringify(result).includes('private provider'), false)
    assert.equal((await store.get('machines:b1')).board.total, 1)
    assert.equal((await store.get('meta:sync')).failCount, 0)
  }
})

test('a real snapshot pipeline failure preserves the previous timestamp and provides a safe stage and traceable event', async () => {
  const store = createMemoryStore(), get = store.get.bind(store)
  const lastFetchAt = '2026-01-01T00:00:00Z'
  await store.put('meta:sync', { lastFetchAt, failCount: 0 })
  store.get = (key, fallback) => key === 'mapping:b1' ? Promise.reject(new Error('private provider configuration')) : get(key, fallback)
  const result = await runSync(env, store, { raws: raw })
  assert.equal(result.errorStage, 'mapping')
  assert.match(result.eventId, /^evt_[a-f0-9]{24}$/)
  assert.equal(JSON.stringify(result).includes('private provider'), false)
  const sync = await get('meta:sync')
  assert.equal(sync.lastFetchAt, lastFetchAt)
  assert.equal(sync.lastErrorEventId, result.eventId)
  assert.equal(sync.failCount, 1)
})

test('public board has server freshness and prevents browser/CDN stale caching while static files retain separate caching', async () => {
  const store = createMemoryStore()
  await store.put('machines:b1', { board: { total: 0, updatedAt: new Date(Date.now() - 240000).toISOString(), floors: [] } })
  await store.put('meta:sync', { failCount: 2, lastAttemptAt: Date.now(), cooldownUntil: Date.now() + 60000, lastErrorStage: 'upstream_fetch', lastErrorEventId: 'evt_123456789012345678901234' })
  const response = await createApp({ store, env }).request('/api/machines')
  const data = await response.json()
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(data.freshness.stale, true)
  assert.equal(data.freshness.syncFailed, true)
  assert.ok(data.freshness.ageSeconds >= 240)
  assert.equal(data.freshness.errorStage, 'upstream_fetch')
  assert.equal(data.freshness.eventId, 'evt_123456789012345678901234')
})

test('a second warm edge reader immediately observes task, queue and occupancy writes from another runtime', async () => {
  const values = new Map()
  const binding = { get: async key => values.get(key) ?? null, put: async (key, value) => { values.set(key, value) } }
  const writer = createEdgeKVStore(binding), reader = createEdgeKVStore(binding)
  for (const key of ['tasks:member', 'occupancy:b1', 'queue:b1', 'faults:b1']) {
    await writer.put(key, { revision: 1 }); await reader.get(key)
    await writer.put(key, { revision: 2 })
    assert.deepEqual(await reader.get(key), { revision: 2 })
  }
})
