import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { createMobilePush } from '../packages/core/mobile-push.js'

const SECRET = 'registration-performance-fixture-secret'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function promptly(promise, message) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 700) })]) }
  finally { clearTimeout(timer) }
}
function atomicFixture() {
  const rows = new Map()
  return { consistency: 'linearizable', durable: true,
    async get(key) { const row = rows.get(key); return row?.expiresAt > Date.now() ? structuredClone({ version: row.version, value: row.value }) : null },
    async compareAndSet(key, version, value, { expiresAt }) {
      const row = rows.get(key), current = row?.expiresAt > Date.now() ? row : null
      if ((current?.version ?? null) !== version) return false
      rows.set(key, { version: crypto.randomUUID(), value: structuredClone(value), expiresAt }); return true
    },
  }
}
async function fixture(t, { native = false } = {}) {
  const memory = createMemoryStore()
  const store = {
    async get(key, fallback = null) { return structuredClone(await memory.get(key, fallback)) },
    async put(key, value) { return memory.put(key, structuredClone(value)) },
    del: memory.del,
    async list(prefix) { return structuredClone(await memory.list(prefix)) },
  }
  const env = { AUTH_SECRET: SECRET, BUILDING_ID: 'b1', HAIER_MODE: 'mock', ...(native ? { MOBILE_PUSH_ENABLED: 'true' } : {}) }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request') })
  const tokens = {}
  for (const user of ['a', 'b']) {
    await store.put('user:' + user, { id: user, nick: user, dormBuilding: 'guiyuan', notifyOn: native && user === 'a' })
    tokens[user] = await issueToken(user, SECRET)
  }
  await store.put('meta:sync', { lastAttemptAt: Date.now() })
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('machines:b1', { board: { buildingId: 'b1', updatedAt: new Date().toISOString(), floors: [{ code: '1', machines: ['one', 'two'].map(id => ({ id, name: id, kind: 'washer', state: 'idle', dormBuilding: 'guiyuan' })) }] } })
  const deliveryStarted = deferred(), delivery = deferred(), atomicStore = native ? atomicFixture() : undefined
  const transports = { fcm: async () => { deliveryStarted.resolve(); await delivery.promise; return { ok: true } } }
  if (native) {
    const push = createMobilePush({ store, env, atomicStore, transports })
    await push.register('a', 'registration_installation')
    await atomicStore.compareAndSet('mobile:installation:registration_installation', null, { userId: 'a', installationId: 'registration_installation', provider: 'fcm', token: 'fictional-device-token', notificationsEnabled: true }, { expiresAt: Date.now() + 86400000 })
  }
  const app = createApp({ store, env, mobile: native ? { atomicStore, pushTransports: transports } : {} })
  const call = (path, { user = 'a', body, context } = {}) => app.fetch(new Request('https://example.invalid' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + tokens[user], ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), undefined, context)
  const register = (machineId, options = {}) => call('/api/tasks', { ...options, body: { machineId, minutes: 30 } })
  return { store, memory, register, call, delivery, deliveryStarted }
}

test('a slow registration machine lookup does not hold the task mutation lock', async t => {
  const { store, register } = await fixture(t), entered = deferred(), gate = deferred()
  const get = store.get
  let blocked = false
  store.get = async (key, fallback) => {
    if (key === 'machines:b1' && !blocked) { blocked = true; entered.resolve(); await gate.promise }
    return get(key, fallback)
  }
  const first = register('one')
  try {
    await promptly(entered.promise, 'registration never reached the machine lookup')
    assert.equal((await promptly(register('two', { user: 'b' }), 'unrelated registration waited for read-only lookup')).status, 200)
  } finally { gate.resolve(); await first }
  assert.equal((await first).status, 200)
  assert.deepEqual(Object.keys(await store.get('occupancy:b1')).sort(), ['one', 'two'])
})

test('slow native notification delivery cannot serialize unrelated registrations on Node', async t => {
  const { store, register, delivery, deliveryStarted } = await fixture(t, { native: true })
  const first = register('one')
  try {
    await promptly(deliveryStarted.promise, 'registration notification never started')
    assert.equal((await promptly(register('two', { user: 'b' }), 'provider delivery held the task mutation lock')).status, 200)
    assert.equal((await store.get('tasks:a')).length, 1)
  } finally { delivery.resolve(); await first }
  assert.equal((await first).status, 200)
  assert.deepEqual(Object.keys(await store.get('occupancy:b1')).sort(), ['one', 'two'])
})

test('Pages returns persisted registration and retains slow notification delivery in waitUntil', async t => {
  const { store, register, delivery, deliveryStarted } = await fixture(t, { native: true })
  const jobs = [], context = { waitUntil(job) { jobs.push(job) } }
  try {
    const response = await promptly(register('one', { context }), 'registration waited for notification transport')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal((await store.get('occupancy:b1')).one.taskId, body.task.id)
    assert.equal((await store.get('tasks:a'))[0].id, body.task.id)
    await promptly(deliveryStarted.promise, 'background registration notification never started')
    assert.ok(jobs.length > 0)
  } finally { delivery.resolve(); await Promise.allSettled(jobs) }
})

test('post-registration task reload returns its saved task while stale Node synchronization is blocked', async t => {
  const { store, register, call } = await fixture(t)
  const saved = await (await register('one')).json()
  await store.put('meta:sync', { lastAttemptAt: 0 })
  const entered = deferred(), gate = deferred(), get = store.get
  store.get = async (key, fallback) => {
    if (key === 'meta:haierAccounts') { entered.resolve(); await gate.promise }
    return get(key, fallback)
  }
  try {
    const response = await promptly(call('/api/tasks'), 'task reload waited for upstream synchronization')
    assert.equal(response.status, 200)
    assert.equal((await response.json()).tasks[0].id, saved.task.id)
    await promptly(entered.promise, 'stale synchronization was not started in the background')
  } finally { gate.resolve() }
})
