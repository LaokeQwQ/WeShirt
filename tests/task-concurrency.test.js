import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSync } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { createSocialService } from '../packages/core/social.js'
import { buildEncryptedResponse } from '../packages/core/dingtalk.js'
import { retainedTasks } from '../packages/core/task-retention.js'
import { pruneUserTasks } from '../server/task-retention.js'
import { withTaskMutation } from '../server/task-mutation-lock.js'

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

test('机器看板忽略损坏的单条占用及旧格式任务，继续显示上游状态', async (t) => {
  const { store, call } = await fixture(t)
  await store.put('occupancy:b1', { one: null, two: { userId: 'b' } })
  await store.put('tasks:b', { old: true })
  const response = await call('/api/machines', { method: 'GET', user: null })
  assert.equal(response.status, 200)
  assert.equal(response.data.board.total, 3)
  assert.equal(response.data.board.idle, 3)
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

test('registration succeeds without delete operations and old reminders cannot unlock a new occupier', async (t) => {
  const { store, register, call } = await fixture(t)
  await store.put('occupancy:b1', { one: { userId: 'b', taskId: 'old', endAt: new Date(Date.now() - 2 * 86400000).toISOString() } })
  await store.put('urgecount:b1:one', 3)
  await store.put('urge:b1:one', Date.now())
  const photos = { machineId: 'one', confirmEmpty: true, photoOccupied: 'https://example.test/one.jpg', photoAround: 'https://example.test/two.jpg' }
  assert.equal((await call('/api/urge/reveal', { user: 'c', body: photos })).status, 200, 'legacy session preserves its accrued reminder count')
  const originalDel = store.del
  let urgeDeletes = 0
  store.del = async key => {
    if (key === 'urgecount:b1:one' || key === 'urge:b1:one') { urgeDeletes++; throw new Error('delete unavailable') }
    return originalDel(key)
  }
  const saved = await register('one', { key: 'registration-cooldown-not-required' })
  assert.equal(saved.status, 200)
  assert.equal((await store.get('occupancy:b1')).one.taskId, saved.data.task.id)
  assert.equal((await store.get('tasks:a')).length, 1)
  assert.equal(urgeDeletes, 0)
  const denied = await call('/api/urge/reveal', { user: 'c', body: photos })
  assert.equal(denied.status, 400)
  assert.match(denied.data.error.message, /当前 0 次/)
  const first = await call('/api/urge', { user: 'c', body: { machineId: 'one' } })
  assert.equal(first.status, 200)
  assert.equal(first.data.count, 1)
  const repeated = await call('/api/urge', { user: 'c', body: { machineId: 'one' } })
  assert.equal(repeated.status, 429)
  const state = await store.get('urge-state:b1:one')
  assert.deepEqual(state, { taskId: saved.data.task.id, userId: 'a', count: 1, at: state.at })
  assert.ok(Number.isFinite(state.at))
  assert.equal(await store.get('urgecount:b1:one'), 3, 'preexisting legacy values remain readable as numbers by older binaries')
  await store.put('urge-state:b1:one', { taskId: 'old', userId: 'b', count: 3, at: state.at })
  assert.equal((await call('/api/urge/reveal', { user: 'c', body: photos })).status, 400)
})

test('registration reports a traceable critical occupancy failure without replaying the task write', async (t) => {
  const { store, register } = await fixture(t)
  const originalPut = store.put
  let attemptedWrites = 0
  store.put = async (key, value) => {
    if (key === 'occupancy:b1') {
      attemptedWrites++
      throw new Error('private-synthetic-occupancy-write-failure')
    }
    return originalPut(key, value)
  }
  const result = await register('one', { key: 'registration-partial-result' })
  assert.equal(result.status, 500)
  const eventId = result.data.error.eventId
  assert.match(eventId, /^evt_[a-f0-9]{24}$/)
  assert.equal(attemptedWrites, 1)
  assert.equal((await store.get('tasks:a')).length, 1)
  assert.equal(await store.get('occupancy:b1', null), null)
  const logs = (await store.list('auditlog:')).flatMap(entry => entry.value)
  assert.equal(logs.find(entry => entry.type === 'error' && entry.detail.eventId === eventId)?.detail.registrationStage, 'occupancy_write')
  assert.ok(!JSON.stringify({ result, logs }).includes('private-synthetic-occupancy-write-failure'))
  store.put = originalPut
  const recovered = await register('one', { key: 'registration-partial-result' })
  assert.equal(recovered.status, 200)
  assert.equal((await store.get('tasks:a')).length, 1)
  assert.equal((await store.get('occupancy:b1')).one.taskId, recovered.data.task.id)
  assert.equal((await register('two', { key: 'registration-partial-result' })).status, 409)
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

test('取衣重试保留首次确认时间并修复未清除的占用', async (t) => {
  const { register, store, call } = await fixture(t)
  const saved = await register('one')
  assert.equal(saved.status, 200)
  const id = saved.data.task.id
  const path = `/api/tasks/${id}/take`
  const key = 'retry-same-pickup-key'
  const put = store.put
  let failOccupancy = true
  store.put = async (key, value) => {
    if (key === 'occupancy:b1' && failOccupancy) {
      failOccupancy = false
      throw new Error('temporary occupancy write failure')
    }
    return put(key, value)
  }

  const failed = await call(path, { key })
  assert.equal(failed.status, 500)
  assert.ok(failed.data.error.eventId)
  const [finished] = await store.get('tasks:a')
  assert.equal(finished.done, true)
  assert.ok(finished.takenAt)
  assert.equal((await store.get('occupancy:b1')).one.taskId, id)

  const retried = await call(path, { key })
  assert.equal(retried.status, 200)
  assert.equal(retried.data.task.takenAt, finished.takenAt)
  assert.deepEqual(await store.get('occupancy:b1'), {})

  const next = await register('one')
  assert.equal(next.status, 200)
  const repeated = await call(path, { key: 'another-pickup-key' })
  assert.equal(repeated.status, 200)
  assert.equal(repeated.data.task.takenAt, finished.takenAt)
  assert.equal((await store.get('occupancy:b1')).one.taskId, next.data.task.id)
})

test('delete retries safely after critical occupancy failure and can clear old orphan records', async (t) => {
  const { register, store, call } = await fixture(t)
  const saved = await register('one')
  assert.equal(saved.status, 200)
  const id = saved.data.task.id
  const originalPut = store.put
  let shouldFail = true
  store.put = async (key, value) => {
    if (key === 'occupancy:b1' && shouldFail) { shouldFail = false; throw new Error('temporary failure') }
    return originalPut(key, value)
  }
  const remove = () => call('/api/tasks/' + id, { method: 'DELETE', key: 'retry-safe-delete-fixture', body: {} })
  assert.equal((await remove()).status, 500)
  assert.equal((await store.get('tasks:a'))[0].id, id)
  assert.equal((await remove()).status, 200)
  assert.deepEqual(await store.get('tasks:a'), [])
  assert.deepEqual(await store.get('occupancy:b1'), {})
  await originalPut('occupancy:b1', { one: { userId: 'a', taskId: id }, two: { userId: 'b', taskId: id } })
  assert.equal((await remove()).status, 200)
  assert.deepEqual(await store.get('occupancy:b1'), { two: { userId: 'b', taskId: id } })
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

test('代取完成晚读必须在任务锁内重读，不覆盖新登记或复活刚清理的336小时记录', async (t) => {
  const { store, memory, register, env } = await fixture(t)
  const original = await register('one')
  const expired = { id: 'expired', machineId: 'three', startAt: new Date(Date.now() - 337 * 3600000).toISOString(), endAt: new Date(Date.now() - 336 * 3600000).toISOString() }
  await store.put('tasks:a', [expired, original.data.task])
  await store.put('social:pickup:fixture', { id: 'fixture', ownerId: 'a', friendId: 'b', taskId: original.data.task.id, state: 'accepted' })
  const service = createSocialService({ store, env, notify: async () => ({ ok: true }) })
  const baseGet = store.get
  let entered, release, held = false
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  store.get = async (key, fallback) => {
    if (key === 'tasks:a' && !held) { held = true; const value = structuredClone(await memory.get(key, fallback)); entered(); await gate; return value }
    return baseGet(key, fallback)
  }
  const completing = service.respondPickup('b', 'fixture', 'complete')
  await started
  let saved
  try { await pruneUserTasks(store, 'b1', 'a'); saved = await register('two') }
  finally { release() }
  assert.equal((await completing).changed, true)
  const tasks = await store.get('tasks:a')
  assert.equal(tasks.some(task => task.id === 'expired'), false)
  assert.equal(tasks.find(task => task.id === original.data.task.id).done, true)
  assert.equal(tasks.some(task => task.id === saved.data.task.id), true)
  assert.equal((await store.get('occupancy:b1')).two.taskId, saved.data.task.id)
})

test('代取通知慢时释放任务与社交锁；已过336小时的任务不能再完成', async (t) => {
  const { store, register, env } = await fixture(t)
  const original = await register('one')
  await store.put('social:pickup:fixture', { id: 'fixture', ownerId: 'a', friendId: 'b', taskId: original.data.task.id, state: 'accepted' })
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const service = createSocialService({ store, env, notify: async () => { entered(); await gate; return { ok: true } } })
  const completing = service.respondPickup('b', 'fixture', 'complete')
  await started
  let timeout
  try {
    const result = await Promise.race([register('two'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('slow pickup notification held task lock')), 500) })])
    assert.equal(result.status, 200)
  } finally { clearTimeout(timeout); release() }
  await completing
  const expired = { id: 'expired', machineId: 'three', startAt: new Date(Date.now() - 337 * 3600000).toISOString(), endAt: new Date(Date.now() - 336 * 3600000).toISOString() }
  await store.put('tasks:a', [expired])
  await store.put('social:pickup:expired', { id: 'expired', ownerId: 'a', friendId: 'b', taskId: 'expired', state: 'accepted' })
  await assert.rejects(service.respondPickup('b', 'expired', 'complete'), { code: 'not_found', status: 404 })
  assert.equal((await store.get('tasks:a'))[0].done, undefined)
})

test('验签钉钉已取命令与登记/清理共用任务锁，保留新登记且不改变72小时归档记录', async (t) => {
  const { store, memory, env } = await fixture(t)
  const clock = Date.now(), stamp = hours => new Date(clock - hours * 3600000).toISOString()
  const current = { id: 'current', machineId: 'one', startAt: stamp(2), endAt: stamp(1), done: false }
  const history = { id: 'history', machineId: 'two', startAt: stamp(74), endAt: stamp(73), done: false }
  const expired = { id: 'expired', machineId: 'three', startAt: stamp(337), endAt: stamp(336), done: false }
  const fresh = { id: 'fresh', machineId: 'three', startAt: stamp(0), endAt: new Date(clock + 3600000).toISOString(), done: false }
  await store.put('tasks:a', [expired, history, current])
  await store.put('occupancy:b1', { one: { userId: 'a', taskId: 'current' }, three: { userId: 'a', taskId: 'fresh' } })
  await store.put('userByDing:synthetic-staff', 'a')
  const aesKey = btoa('x'.repeat(32)).replace(/=+$/, ''), token = 'synthetic-callback-token'
  const signed = await buildEncryptedResponse({ plainText: JSON.stringify({ msgtype: 'text', text: { content: '已取' }, senderStaffId: 'synthetic-staff', conversationType: '1' }), aesKey, ownerKey: '', token, timestamp: String(Date.now()), nonce: 'task-lock-regression' })
  const app = createApp({ store, env: { ...env, DINGTALK_AES_KEY: aesKey, DINGTALK_TOKEN: token } })
  let entered, release, userRead, taskReads = 0
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve }), callbackReady = new Promise(resolve => { userRead = resolve })
  const baseGet = store.get
  store.get = async (key, fallback) => {
    if (key === 'tasks:a') taskReads++
    const result = await baseGet(key, fallback)
    if (key === 'user:a') userRead()
    return result
  }
  const writing = withTaskMutation(store, 'b1', async () => {
    const original = await store.get('tasks:a'); entered(); await gate
    await store.put('tasks:a', [...retainedTasks(original), fresh])
  })
  await started
  const callback = app.request('/api/dingtalk/callback?' + new URLSearchParams({ msg_signature: signed.msg_signature, timestamp: signed.timeStamp, nonce: signed.nonce }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ encrypt: signed.encrypt }) })
  try {
    await callbackReady
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(taskReads, 1, 'callback cannot read stale tasks outside the held registration lock')
  } finally { release() }
  await writing
  assert.equal((await callback).status, 200)
  const tasks = await memory.get('tasks:a')
  assert.equal(tasks.some(task => task.id === 'expired'), false)
  assert.equal(tasks.find(task => task.id === 'current').done, true)
  assert.equal(tasks.find(task => task.id === 'history').done, false)
  assert.equal(tasks.find(task => task.id === 'fresh').done, false)
  const occupancy = await memory.get('occupancy:b1')
  assert.equal(occupancy.one, undefined)
  assert.equal(occupancy.three.taskId, 'fresh')
})
