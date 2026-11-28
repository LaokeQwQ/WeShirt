import test from 'node:test'
import assert from 'node:assert/strict'
import { createPagesHandler } from '../functions/api/[[default]].js'

const storageEnv = {
  SITE_STORE_URL: 'https://storage.example/api/site-store',
  SITE_STORE_SECRET: 'site-store-test-secret-at-least-32-characters',
  HAIER_MODE: 'mock', BUILDING_ID: 'b1',
}

function createBridge(rows, beforeGet = async () => {}) {
  return createPagesHandler({ fetch: async (url, options) => {
    assert.equal(String(url), storageEnv.SITE_STORE_URL)
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + storageEnv.SITE_STORE_SECRET)
    const { op, key, value, prefix } = JSON.parse(options.body)
    let result
    if (op === 'get') {
      await beforeGet(key)
      result = rows.has(key) ? { found: true, value: rows.get(key) } : { found: false }
    } else if (op === 'put') {
      rows.set(key, value)
      result = true
    } else if (op === 'delete') {
      result = rows.delete(key)
    } else if (op === 'list') {
      result = { rows: [...rows].filter(([name]) => name.startsWith(prefix)).map(([key, value]) => ({ key, value })), next: null }
    } else {
      assert.fail('Unexpected bridge operation')
    }
    return Response.json({ protocolVersion: 1, ok: true, result })
  } })
}

test('Pages returns the existing public board while retaining unfinished sync in waitUntil', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let syncStarted
  const started = new Promise(resolve => { syncStarted = resolve })
  const rows = new Map([
    ['machines:b1', { board: { updatedAt: new Date().toISOString(), floors: [{ code: '1F', machines: [
      { id: 'old-machine', name: '一号机', state: 'idle', dormBuilding: 'guiyuan' },
      { id: 'outside-machine', name: '其他楼栋洗衣机', state: 'idle', dormBuilding: 'liuyuan' },
    ] }] } }],
    ['meta:sync', { lastAttemptAt: 0 }],
    ['occupancy:b1', { 'outside-machine': { userId: 'outside-owner' } }],
  ])
  let blockedSync = false
  const reads = []
  const onRequest = createBridge(rows, async key => {
    reads.push(key)
    if (key === 'meta:haierAccounts') { blockedSync = true; syncStarted(); await blocked }
  })
  const tasks = []
  const context = {
    env: { ...storageEnv, AUTH_SECRET: 'edge-task-fixture-secret-long-enough' },
    request: new Request('https://site.example/api/machines?dorm=guiyuan'),
    waitUntil(task) { assert.equal(this, context); tasks.push(task) },
  }
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
  const onRequest = createBridge(new Map(), async key => {
    reads.push(key)
    if (key === 'meta:haierAccounts') await blocked
  })
  const tasks = []
  const context = {
    env: { ...storageEnv, SYNC_WAIT_MS: '10' },
    request: new Request('https://site.example/api/machines?dorm=guiyuan'),
    waitUntil(task) { tasks.push(task) },
  }
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

test('transient CloudBase board read failure can reuse a same-dorm public catalogue with unverified states', async () => {
  const at = new Date().toISOString()
  let fail = false
  const rows = new Map([
    ['machines:b1', { board: { updatedAt: at, floors: [{ code: '1F', machines: [
      { id: 'm', name: '一号机', state: 'idle', dormBuilding: 'guiyuan', privateField: 'fixture-private' },
    ] }] } }],
    ['meta:sync', { lastAttemptAt: Date.now() }],
  ])
  const onRequest = createBridge(rows, async key => { if (fail && key === 'machines:b1') throw Error('bridge unavailable') })
  const read = (dorm, headers) => onRequest({
    env: storageEnv,
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

test('Pages rejects missing CloudBase configuration without using a KV binding', async () => {
  let touched = false
  const unsupportedStore = {
    async get() { touched = true }, async put() { touched = true }, async delete() { touched = true },
  }
  const onRequest = createPagesHandler({ fetch: async () => { touched = true } })
  const response = await onRequest({ env: { LAUNDRY_KV: unsupportedStore }, request: new Request('https://site.example/api/health') })
  assert.equal(response.status, 503)
  const { error } = await response.json()
  assert.equal(error.code, 'site_store_unavailable')
  assert.equal(error.eventId, response.headers.get('x-event-id'))
  assert.equal(touched, false)
})

test('Pages freezes all API routes without contacting storage', async () => {
  let contacted = false
  const onRequest = createPagesHandler({ fetch: async () => { contacted = true } })
  const env = { ...storageEnv, SITE_STORE_MIGRATION_MODE: 'freeze' }
  for (const [path, method] of [['/api/health', 'GET'], ['/api/machines', 'GET'], ['/api/cron/ingest', 'POST'], ['/api/tasks', 'DELETE']]) {
    const response = await onRequest({ env, request: new Request('https://site.example' + path, { method }) })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('retry-after'), '15')
    const { error } = await response.json()
    assert.equal(error.code, 'site_store_migrating')
    assert.equal(error.eventId, response.headers.get('x-event-id'))
  }
  assert.equal(contacted, false)
})

test('storage probe reads from CloudBase across independent Pages runtimes', async () => {
  const rows = new Map()
  const env = { ...storageEnv, ADMIN_TOKEN: 'admin-test-token-at-least-32-characters' }
  const request = () => ({ env, request: new Request('https://site.example/api/debug/storage', { headers: { 'X-Admin-Token': env.ADMIN_TOKEN } }) })
  const first = await createBridge(rows)(request())
  assert.equal(first.status, 200)
  assert.equal((await first.json()).persistent, false)
  const second = await createBridge(rows)(request())
  const diagnostic = await second.json()
  assert.equal(second.status, 200)
  assert.equal(diagnostic.store.kind, 'cloudbase-postgres')
  assert.equal(diagnostic.persistent, true)
  assert.equal(diagnostic.hits, 2)
})
