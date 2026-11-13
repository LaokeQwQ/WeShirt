import test from 'node:test'
import assert from 'node:assert/strict'

test('Pages returns the existing public board while retaining unfinished sync in waitUntil', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let syncStarted
  const started = new Promise(resolve => { syncStarted = resolve })
  const rows = new Map([
    ['machines:b1', JSON.stringify({ board: { updatedAt: new Date().toISOString(), floors: [{ code: '1F', machines: [{ id: 'old-machine', name: '一号机', state: 'idle', dormBuilding: 'guiyuan' }] }] } })],
    ['meta:sync', JSON.stringify({ lastAttemptAt: 0 })],
  ])
  let blockedSync = false
  const kv = {
    async get(key) {
      if (key === 'meta:haierAccounts') { blockedSync = true; syncStarted(); await blocked }
      return rows.get(key) ?? null
    },
    async put(key, value) { rows.set(key, value) },
    async delete(key) { rows.delete(key) },
    async list({ prefix = '' } = {}) { return { keys: [...rows.keys()].filter(key => key.startsWith(prefix)), complete: true } },
  }
  const tasks = []
  const context = {
    env: { LAUNDRY_KV: kv, HAIER_MODE: 'mock', BUILDING_ID: 'b1', AUTH_SECRET: 'edge-task-fixture-secret-long-enough' },
    request: new Request('https://site.example/api/machines?dorm=guiyuan'),
    waitUntil(task) { assert.equal(this, context); tasks.push(task) },
  }
  const { onRequest } = await import('../functions/api/[[default]].js?task-lifetime')
  let timer, startedTimer
  try {
    const response = await Promise.race([
      onRequest(context),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Public board waited for background synchronization')), 1500) }),
    ])
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const data = await response.json()
    assert.equal(data.board.floors[0].machines[0].id, 'old-machine')
    await Promise.race([started, new Promise((_, reject) => { startedTimer = setTimeout(() => reject(Error('Background sync never started')), 1500) })])
    assert.equal(blockedSync, true)
    assert.ok(tasks.length > 0, 'The real sync promise must belong to the platform lifetime')
  } finally {
    clearTimeout(timer)
    clearTimeout(startedTimer)
    release()
    await Promise.allSettled(tasks)
  }
})
