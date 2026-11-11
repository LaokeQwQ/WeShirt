import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_ARCHIVE_MS, TASK_RETENTION_MS, taskLifecycle, splitTaskHistory } from '../packages/core/task-retention.js'
import { pruneUserTasks } from '../server/task-retention.js'
import { withTaskMutation } from '../server/task-mutation-lock.js'
import { createMemoryStore } from '../packages/core/store.js'
import { createApp, runSync } from '../server/app.js'
import { issueToken } from '../packages/core/auth.js'

const env = { AUTH_SECRET: 'retention_fixture_'.repeat(3), BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
const HOUR = 3600000
const task = (id, age, clock) => ({ id, machineId: id, startAt: new Date(clock - age).toISOString(), endAt: new Date(clock - age + HOUR).toISOString(), done: false })

test('records archive at exactly 72 hours and disappear at exactly 336 hours, including legacy startAt records', () => {
  const clock = Date.parse('2026-01-20T12:00:00Z')
  assert.equal(taskLifecycle(task('recent', TASK_ARCHIVE_MS - 1, clock), clock).archived, false)
  assert.equal(taskLifecycle(task('history', TASK_ARCHIVE_MS, clock), clock).archived, true)
  assert.equal(taskLifecycle(task('kept', TASK_RETENTION_MS - 1, clock), clock).expired, false)
  assert.equal(taskLifecycle(task('expired', TASK_RETENTION_MS, clock), clock).expired, true)
  const split = splitTaskHistory([task('expired', TASK_RETENTION_MS, clock), task('old', 100 * HOUR, clock), task('new', HOUR, clock), task('older', 200 * HOUR, clock)], clock)
  assert.deepEqual(split.activeTasks.map(t => t.id), ['new'])
  assert.deepEqual(split.history.map(t => t.id), ['old', 'older'])
  assert.equal(taskLifecycle({ createdAt: new Date(clock).toISOString(), startAt: new Date(clock - TASK_RETENTION_MS).toISOString() }, clock).expired, false)
  assert.equal(taskLifecycle({ startAt: 'invalid' }, clock).expired, false, 'invalid legacy dates cannot silently delete user data')
})

test('authenticated tasks API partitions history and really deletes expired records without removing replacement occupancy', async () => {
  const store = createMemoryStore(), clock = Date.now()
  await store.put('user:member', { id: 'member', nick: '测试用户' })
  const rows = [task('new', HOUR, clock), task('history', 73 * HOUR, clock), task('old', 337 * HOUR, clock), task('replaced', 337 * HOUR, clock)]
  await store.put('tasks:member', rows)
  await store.put('occupancy:b1', { old: { userId: 'member', taskId: 'old' }, replaced: { userId: 'member', taskId: 'replacement' }, other: { userId: 'other', taskId: 'old' } })
  await store.put('machines:b1', { board: { total: 0, updatedAt: new Date().toISOString(), floors: [] } })
  await store.put('meta:sync', { lastAttemptAt: Date.now() })
  const app = createApp({ store, env }), token = await issueToken('member', env.AUTH_SECRET)
  const response = await app.request('/api/tasks', { headers: { authorization: 'Bearer ' + token } })
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.deepEqual(data.activeTasks.map(t => t.id), ['new'])
  assert.deepEqual(data.history.map(t => t.id), ['history'])
  assert.equal(data.tasks.length, 2)
  assert.equal(data.history[0].archived, true)
  assert.equal(data.history[0].expiresAt, new Date(clock - 73 * HOUR + TASK_RETENTION_MS).toISOString())
  assert.equal((await store.get('tasks:member')).length, 2)
  const occupancy = await store.get('occupancy:b1')
  assert.equal(occupancy.old, undefined)
  assert.equal(occupancy.replaced.taskId, 'replacement')
  assert.equal(occupancy.other.userId, 'other')
  assert.match(response.headers.get('cache-control'), /no-store/)
})

test('retention cleanup shares the registration lock and cannot overwrite a concurrently saved new task', async () => {
  const store = createMemoryStore(), clock = Date.now()
  await store.put('tasks:member', [task('expired', 337 * HOUR, clock)])
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const write = withTaskMutation(store, 'b1', async () => {
    const rows = await store.get('tasks:member'); entered(); await gate
    await store.put('tasks:member', [...rows, task('fresh', 0, clock)])
  })
  await started
  const prune = pruneUserTasks(store, 'b1', 'member', clock)
  release(); await Promise.all([write, prune])
  assert.deepEqual((await store.get('tasks:member')).map(t => t.id), ['fresh'])
})

test('scheduled sync clears expired history even when the owner has disabled notifications', async () => {
  const store = createMemoryStore(), clock = Date.now()
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('user:member', { id: 'member', notifyOn: false })
  await store.put('tasks:member', [task('expired', 337 * HOUR, clock), task('history', 74 * HOUR, clock)])
  const result = await runSync(env, store, { raws: [{ id: 'm1', state: 1 }] })
  assert.equal(result.error, null)
  assert.deepEqual((await store.get('tasks:member')).map(t => t.id), ['history'])
})
