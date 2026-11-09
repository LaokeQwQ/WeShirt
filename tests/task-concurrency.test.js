import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSync } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'task-concurrency-jwt-test-secret'
async function fixture(t) {
  const memory = createMemoryStore()
  const store = {
    async get(key, fallback = null) { const value = structuredClone(await memory.get(key, fallback)); if (/^(tasks:|occupancy:|queue:)/.test(key)) await new Promise((resolve) => setTimeout(resolve, 1)); return value },
    async put(key, value) { return memory.put(key, structuredClone(value)) },
    del: memory.del,
    async list(prefix) { return structuredClone(await memory.list(prefix)) },
  }
  const env = { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'concurrency-admin-test', BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external requests allowed') })
  const tokens = {}
  for (const id of ['a', 'b', 'c']) { await store.put('user:' + id, { id, nick: id, dormBuilding: 'guiyuan', notifyOn: false }); tokens[id] = await issueToken(id, SECRET) }
  await store.put('meta:sync', { lastAttemptAt: Date.now() })
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('machines:b1', { board: { buildingId: 'b1', updatedAt: new Date().toISOString(), floors: [{ code: '1', machines: ['one', 'two', 'three'].map((id) => ({ id, name: '桂园-' + id, kind: 'washer', state: 'idle', dormBuilding: 'guiyuan' })) }] } })
  const app = createApp({ store, env })
  const call = async (path, { user = 'a', method = 'POST', body, key } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (user) headers.authorization = 'Bearer ' + tokens[user]
    if (key) headers['Idempotency-Key'] = key
    const response = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const register = (machineId, options) => call('/api/tasks', { body: { machineId, minutes: 30 }, ...options })
  return { store, memory, env, call, register }
}

test('并发不同用户不同机器保留所有任务和occupancy，同用户不同机器也不丢任务', async (t) => {
  const { store, register } = await fixture(t)
  const first = await Promise.all([register('one', { user: 'a' }), register('two', { user: 'b' })])
  assert.deepEqual(first.map((result) => result.status), [200, 200])
  assert.deepEqual(Object.keys(await store.get('occupancy:b1')).sort(), ['one', 'two'])
  const own = await Promise.all([register('one', { user: 'a' }), register('three', { user: 'a' })])
  assert.deepEqual(own.map((result) => result.status), [200, 200])
  assert.equal((await store.get('tasks:a')).length, 3)
  assert.equal((await store.get('tasks:b')).length, 1)
  assert.equal(Object.keys(await store.get('occupancy:b1')).length, 3)
})

test('不同人争抢同台机器稳定一个成功一个409，失败不创建孤立任务', async (t) => {
  const { register, store } = await fixture(t)
  const results = await Promise.all([register('one', { user: 'a' }), register('one', { user: 'b' })])
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  const conflict = results.find((result) => result.status === 409)
  assert.equal(conflict.data.error.code, 'machine_occupied')
  assert.equal(conflict.data.error.status, 409)
  assert.ok(conflict.data.error.eventId)
  const tasks = [...await store.get('tasks:a', []), ...await store.get('tasks:b', [])]
  assert.equal(tasks.length, 1)
  assert.equal((await store.get('occupancy:b1')).one.taskId, tasks[0].id)
})

test('并发重复Idempotency-Key只写一个任务，缓存重试也不重复登记', async (t) => {
  const { register, store } = await fixture(t)
  const results = await Promise.all(Array.from({ length: 5 }, () => register('one', { key: 'same-registration-key' })))
  assert.equal(results.every((result) => result.status === 200), true)
  assert.equal(new Set(results.map((result) => result.data.task.id)).size, 1)
  assert.equal((await store.get('tasks:a')).length, 1)
  assert.equal((await register('one', { key: 'same-registration-key' })).data.task.id, results[0].data.task.id)
  assert.equal((await store.get('tasks:a')).length, 1)
})

test('取旧任务与新增登记并发时，旧take不能清掉新任务占用；队列与登记共享顺序', async (t) => {
  const { register, store, call } = await fixture(t)
  const old = await register('one')
  const results = await Promise.all([call('/api/tasks/' + old.data.task.id + '/take'), register('one'), call('/api/queue', { user: 'b', body: { machineId: 'two' } })])
  assert.equal(results.every((result) => result.status === 200), true)
  assert.equal((await store.get('tasks:a')).length, 2)
  assert.equal((await store.get('tasks:a')).find((task) => task.id === old.data.task.id).done, true)
  assert.equal((await store.get('occupancy:b1')).one.taskId, results[1].data.task.id)
  assert.equal((await store.get('queue:b1'))[0].userId, 'b')
})

test('occupancy读到旧过期快照后，新登记不能被清理逻辑覆盖删除', async (t) => {
  const { store, memory, call, register } = await fixture(t)
  await store.put('occupancy:b1', { one: { userId: 'a', taskId: 'expired', startAt: new Date(Date.now() - 3 * 86400000).toISOString(), endAt: new Date(Date.now() - 2 * 86400000).toISOString() } })
  const baseGet = store.get
  let entered, release, held = false
  const started = new Promise((resolve) => { entered = resolve })
  const delayed = new Promise((resolve) => { release = resolve })
  store.get = async (key, fallback) => {
    if (key === 'occupancy:b1' && !held) { held = true; const value = structuredClone(await memory.get(key, fallback)); entered(); await delayed; return value }
    return baseGet(key, fallback)
  }
  const cleanup = call('/api/occupancy', { method: 'GET', user: null })
  await started
  const saved = await register('one')
  release()
  assert.equal((await cleanup).status, 200)
  assert.equal((await store.get('occupancy:b1')).one.taskId, saved.data.task.id)
})

test('runSync慢通知不挡任务写入，最终短锁合并不覆盖新任务或复活已删除任务', async (t) => {
  const { store, call, register, env } = await fixture(t)
  const old = await register('one')
  const tasks = await store.get('tasks:a')
  tasks[0].endAt = new Date(Date.now() + 60000).toISOString()
  await store.put('tasks:a', tasks)
  await store.put('user:a', { id: 'a', nick: '本人', dormBuilding: 'guiyuan', notifyOn: true, notifyLeadMin: 3, dingUserId: 'synthetic-ding-user' })
  let enter, release
  const started = new Promise((resolve) => { enter = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = new URL(url)
    if (target.hostname === 'api.dingtalk.com' && target.pathname === '/v1.0/oauth2/accessToken') return new Response(JSON.stringify({ accessToken: 'synthetic-token', expireIn: 7200 }))
    assert.equal(target.hostname, 'api.dingtalk.com')
    assert.equal(target.pathname, '/v1.0/robot/oToMessages/batchSend')
    enter(); await wait
    return new Response('{}')
  })
  const job = runSync({ ...env, DINGTALK_APP_KEY: 'synthetic-app', DINGTALK_APP_SECRET: 'synthetic-secret', DINGTALK_ROBOT_CODE: 'synthetic-robot' }, store, { raws: [{ id: 'one', name: '桂园-one', state: 2, floorCode: '1' }, { id: 'two', name: '桂园-two', state: 1, floorCode: '1' }] })
  await started
  let timeout
  try {
    const writes = await Promise.race([
      Promise.all([register('two'), call('/api/tasks/' + old.data.task.id, { method: 'DELETE' })]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('task writes blocked by sync network delivery')), 500) }),
    ])
    clearTimeout(timeout)
    assert.equal(writes.every((result) => result.status === 200), true)
  } finally { clearTimeout(timeout); release() }
  assert.equal((await job).error, null)
  const latest = await store.get('tasks:a')
  assert.equal(latest.length, 1)
  assert.equal(latest[0].machineId, 'two')
  assert.equal(latest.some((task) => task.id === old.data.task.id), false)
})
