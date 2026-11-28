import test from 'node:test'
import assert from 'node:assert/strict'

test('Pages returns the existing public board while retaining unfinished sync in waitUntil', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let syncStarted
  const started = new Promise(resolve => { syncStarted = resolve })
  const rows = new Map([
    ['machines:b1', JSON.stringify({ board: { updatedAt: new Date().toISOString(), floors: [{ code: '1F', machines: [
      { id: 'old-machine', name: '一号机', state: 'idle', dormBuilding: 'guiyuan' },
      { id: 'outside-machine', name: '其他楼栋洗衣机', state: 'idle', dormBuilding: 'liuyuan' },
    ] }] } })],
    ['meta:sync', JSON.stringify({ lastAttemptAt: 0 })],
    ['occupancy:b1', JSON.stringify({ 'outside-machine': { userId: 'outside-owner' } })],
  ])
  let blockedSync = false
  const reads = []
  const kv = {
    async get(key) {
      reads.push(key)
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
    assert.equal(reads.filter(key => key === 'meta:sync').length, 1)
    assert.equal(reads.filter(key => key === 'machines:b1').length, 1)
    assert.equal(reads.includes('tasks:outside-owner'), false)
  } finally {
    clearTimeout(timer)
    clearTimeout(startedTimer)
    release()
    await Promise.allSettled(tasks)
  }
})

test('Pages can report a traced unavailable board while first synchronization is still pending', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const reads = []
  const kv = {
    async get(key) {
      reads.push(key)
      if (key === 'meta:haierAccounts') await blocked
      return null
    },
    async put() {},
    async delete() {},
    async list() { return { keys: [], complete: true } },
  }
  const tasks = []
  const context = {
    env: { LAUNDRY_KV: kv, HAIER_MODE: 'mock', BUILDING_ID: 'b1', SYNC_WAIT_MS: '10' },
    request: new Request('https://site.example/api/machines?dorm=guiyuan'),
    waitUntil(task) { tasks.push(task) },
  }
  const { onRequest } = await import('../functions/api/[[default]].js?initial-no-snapshot')
  try {
    const response = await onRequest(context)
    const { error } = await response.json()
    assert.equal(response.status, 503)
    assert.equal(error.code, 'board_unavailable')
    assert.match(error.eventId, /^evt_[a-f0-9]{24}$/)
    assert.equal(reads.filter(key => key === 'machines:b1').length, 2, 'first read may observe a newly committed snapshot')
    assert.ok(tasks.length > 0)
  } finally {
    release()
    await Promise.allSettled(tasks)
  }
})

test('transient edge board read failure can reuse a same-dorm public catalogue with unverified states', async () => {
  const at = new Date().toISOString()
  let fail = false
  const rows = new Map([
    ['machines:b1', JSON.stringify({ board: { updatedAt: at, floors: [{ code: '1F', machines: [
      { id: 'm', name: '一号机', state: 'idle', dormBuilding: 'guiyuan', privateField: 'fixture-private' },
    ] }] } })],
    ['meta:sync', JSON.stringify({ lastAttemptAt: Date.now() })],
  ])
  const kv = {
    async get(key) { if (fail && key === 'machines:b1') throw Error('binding unavailable'); return rows.get(key) ?? null },
    async put(key, value) { rows.set(key, value) },
    async delete(key) { rows.delete(key) },
    async list() { return { keys: [], complete: true } },
  }
  const { onRequest } = await import('../functions/api/[[default]].js?restricted-board-fallback')
  const read = (dorm, headers) => onRequest({
    env: { LAUNDRY_KV: kv, BUILDING_ID: 'b1', HAIER_MODE: 'mock' },
    request: new Request('https://site.example/api/machines?dorm=' + dorm, { headers }),
    waitUntil() {},
  })
  assert.equal((await read('guiyuan')).status, 200)
  fail = true
  const response = await read('guiyuan')
  const output = await response.json()
  assert.equal(response.status, 200)
  assert.equal(output.board.floors[0].machines[0].state, 'unknown')
  assert.equal(output.board.idle, 0)
  assert.equal(output.freshness.stale, true)
  assert.match(output.freshness.eventId, /^evt_/)
  assert.doesNotMatch(JSON.stringify(output), /fixture-private/)
  assert.equal((await read('liuyuan')).status, 503)
  assert.equal((await read('guiyuan', { authorization: 'Bearer test' })).status, 503)
})
