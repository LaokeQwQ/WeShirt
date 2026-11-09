import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSync } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'private-task-details-api-secret-2026'
const ENV = { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'task-details-admin-token', BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
async function fixture(t) {
  const store = createMemoryStore()
  const network = []
  t.mock.method(globalThis, 'fetch', async (...args) => { network.push(args[0]); throw new Error('No external requests allowed') })
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('user:u1', { id: 'u1', nick: '甲', dormBuilding: 'guiyuan', notifyOn: false })
  await store.put('user:u2', { id: 'u2', nick: '乙', dormBuilding: 'guiyuan', notifyOn: false })
  await store.put('messages:b1', [{ id: 'old-message', userId: 'u2', text: '现有公开留言', at: new Date().toISOString(), dormBuilding: 'guiyuan' }])
  await store.put('mapping:b1', { mapping: { '1': 'washer1', D1: 'dryer1' } })
  const synced = await runSync(ENV, store, { raws: [
    { id: 'washer1', name: '桂园一号洗衣机', floorCode: '1', state: 1 },
    { id: 'dryer1', name: '桂园一号烘干机', floorCode: '1', state: 1 },
  ] })
  assert.equal(synced.error, null)
  const app = createApp({ store, env: { ...ENV } })
  const tokens = { u1: await issueToken('u1', SECRET), u2: await issueToken('u2', SECRET) }
  const call = async (path, { user = 'u1', method = 'GET', body } = {}) => {
    const response = await app.fetch(new Request('https://laundry.example' + path, { method,
      headers: { ...(user ? { authorization: 'Bearer ' + tokens[user] } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
    return { status: response.status, data: await response.json() }
  }
  t.after(() => assert.deepEqual(network, [], 'tests never contact upstream or send notifications'))
  return { store, call }
}

test('task details belong to the owner and are publicly shown only on the current machine occupancy', async (t) => {
  const { store, call } = await fixture(t)
  const note = '袖口需要留意，请勿混放'
  const saved = await call('/api/tasks', { method: 'POST', body: { machineId: 'washer1', minutes: 30, note, useDisinfectant: true, selfCleaned: true, userId: 'u2' } })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  assert.equal(saved.data.task.note, note)
  assert.equal(saved.data.task.useDisinfectant, true)
  const own = await call('/api/tasks')
  assert.equal(own.data.tasks[0].note, note)
  assert.equal(own.data.tasks[0].useDisinfectant, true)
  assert.equal((await store.get('tasks:u1'))[0].note, note)
  assert.equal(await store.get('tasks:u2', null), null, 'client userId never changes ownership')
  assert.deepEqual((await call('/api/tasks', { user: 'u2' })).data.tasks, [])
  assert.equal((await call('/api/tasks', { user: null })).status, 401)
  assert.deepEqual((await store.get('messages:b1')).map((m) => m.id), ['old-message'])
  const occupancy = await store.get('occupancy:b1')
  assert.equal(occupancy.washer1.userId, 'u1')
  assert.equal(occupancy.washer1.note, undefined)
  assert.equal(occupancy.washer1.useDisinfectant, undefined)
  assert.equal((await call('/api/messages?dorm=guiyuan', { user: null })).status, 403, '住宿楼频道不向访客公开')
  const ownChannel = await call('/api/messages?dorm=guiyuan')
  assert.equal(ownChannel.status, 200)
  assert.equal(JSON.stringify(ownChannel.data).includes(note), false, '登记详情不复制到留言')
  for (const path of ['/api/machines?dorm=guiyuan', '/api/occupancy']) {
    const publicResponse = await call(path, { user: null })
    assert.equal(publicResponse.status, 200, path)
    assert.equal(JSON.stringify(publicResponse.data).includes(note), path === '/api/occupancy', path)
    if (path !== '/api/occupancy') assert.equal(JSON.stringify(publicResponse.data).includes('useDisinfectant'), false, path)
  }
  const publicCare = (await call('/api/occupancy', { user: null })).data.occupancy.washer1.care
  assert.deepEqual(publicCare, { note, useDisinfectant: true, selfCleaned: true, source: 'user_report' })
  const audit = await store.list('auditlog:')
  const registration = audit.flatMap((entry) => entry.value).find((entry) => entry.action === '登记洗衣')
  assert.ok(registration, 'registration audit exists')
  assert.equal(registration.detail.hasNote, true)
  assert.equal(registration.detail.note, undefined)
  assert.equal(JSON.stringify(audit).includes(note), false, 'audit records metadata without duplicating free text')
  assert.equal((await call('/api/tasks/' + saved.data.task.id + '/take', { user: 'u2', method: 'POST' })).status, 404)
})

test('Unicode note boundary counts codepoints and strips controls while keeping HTML as plain text', async (t) => {
  const { call } = await fixture(t)
  const exact = '🧺'.repeat(200)
  const boundary = await call('/api/tasks', { method: 'POST', body: { machineId: 'washer1', minutes: 30, note: exact, useDisinfectant: false } })
  assert.equal(boundary.status, 200)
  assert.equal(boundary.data.task.note, exact)
  const long = await call('/api/tasks', { method: 'POST', body: { machineId: 'washer1', minutes: 30, note: exact + '衣' } })
  assert.equal(long.status, 400)
  const sanitized = await call('/api/tasks', { method: 'POST', body: { machineId: 'washer1', minutes: 30, note: '  \u0000轻柔\n衣物\u202E <script>alert(1)</script> \u007f  ' } })
  assert.equal(sanitized.status, 200)
  assert.equal(sanitized.data.task.note, '轻柔 衣物  <script>alert(1)</script>')
  assert.equal(/\p{Cc}/u.test(sanitized.data.task.note), false)
  const list = await call('/api/tasks')
  assert.equal(list.data.tasks.find((task) => task.id === sanitized.data.task.id).note, sanitized.data.task.note)
})

test('invalid note or disinfectant fields reject atomically before modifying task/queue/messages/occupancy', async (t) => {
  const { call, store } = await fixture(t)
  await store.put('queue:b1', [{ id: 'q1', userId: 'u1', machineId: 'washer1' }])
  const previous = JSON.stringify({ tasks: await store.get('tasks:u1'), occupancy: await store.get('occupancy:b1'), messages: await store.get('messages:b1'), queue: await store.get('queue:b1') })
  const invalid = [
    ...[null, false, 1, {}, ['文字']].map((note) => ({ note })),
    ...[null, 0, 1, 'true', {}, []].map((useDisinfectant) => ({ useDisinfectant })),
    ...[null, 0, 'true', {}].map((selfCleaned) => ({ selfCleaned })),
  ]
  for (const fields of invalid) {
    const result = await call('/api/tasks', { method: 'POST', body: { machineId: 'washer1', minutes: 30, ...fields } })
    assert.equal(result.status, 400, JSON.stringify(fields))
    assert.equal(JSON.stringify({ tasks: await store.get('tasks:u1'), occupancy: await store.get('occupancy:b1'), messages: await store.get('messages:b1'), queue: await store.get('queue:b1') }), previous)
  }
})

test('legacy and omitted fields return safe defaults; dryer boolean compatibility remains', async (t) => {
  const { call, store } = await fixture(t)
  await store.put('tasks:u1', [{ id: 'legacy', machineId: 'washer1', machineName: '洗衣机', endAt: new Date().toISOString(), done: true },
    { id: 'corrupt-legacy', machineId: 'washer1', note: { private: 'object' }, useDisinfectant: 'true', endAt: new Date().toISOString(), done: true }])
  const old = await call('/api/tasks')
  assert.ok(old.data.tasks.every((task) => task.note === '' && task.useDisinfectant === false))
  const saved = await call('/api/tasks', { method: 'POST', body: { machineId: 'washer1', minutes: 30 } })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.task.note, '')
  assert.equal(saved.data.task.useDisinfectant, false)
  const dryer = await call('/api/tasks', { method: 'POST', body: { machineId: 'dryer1', minutes: 60, note: '烘干注意低温', useDisinfectant: true } })
  assert.equal(dryer.status, 200)
  assert.equal(dryer.data.task.kind, 'dryer')
  assert.equal(dryer.data.task.note, '烘干注意低温')
  assert.equal(dryer.data.task.useDisinfectant, true, 'backend only validates boolean, frontend chooses applicability')
})

test('machine care indicators belong to the current occupancy and clear after pickup', async(t)=>{
  const {call}=await fixture(t)
  const first=await call('/api/tasks',{method:'POST',body:{machineId:'washer1',minutes:30,selfCleaned:true,useDisinfectant:true,note:'先前记录'}})
  const second=await call('/api/tasks',{method:'POST',body:{machineId:'washer1',minutes:42}})
  assert.equal((await call('/api/occupancy',{user:null})).data.occupancy.washer1.care.selfCleaned,false)
  await call('/api/tasks/'+first.data.task.id+'/take',{method:'POST'})
  assert.equal((await call('/api/occupancy',{user:null})).data.occupancy.washer1.care.useDisinfectant,false)
  await call('/api/tasks/'+second.data.task.id+'/take',{method:'POST'})
  assert.equal((await call('/api/occupancy',{user:null})).data.occupancy.washer1,undefined)
})
