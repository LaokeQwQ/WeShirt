import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSync, detectDryerStuck, runSelfCheck } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'task-regression-secret-32-letters'
const ENV = { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
const DING = { DINGTALK_APP_KEY: 'test-key', DINGTALK_APP_SECRET: 'test-secret', DINGTALK_ROBOT_CODE: 'test-robot', DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=test' }

async function fixture(machine = { id: 'd1', name: '柳园西', state: 'idle' }, mapping = { D1: 'd1' }) {
  const store = createMemoryStore()
  // 本文件验证个人提醒；整点群播报由 operations 测试覆盖，避免断言依赖北京时间。
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('user:u1', { id: 'u1', nick: '测试同学', dingUserId: 'staff1' })
  await store.put('mapping:b1', { mapping })
  await store.put('machines:b1', { board: { total: 1, updatedAt: new Date().toISOString(), floors: [{ code: '4', machines: [machine] }] } })
  await store.put('meta:sync', { lastAttemptAt: Date.now(), lastFetchAt: new Date().toISOString() })
  const app = createApp({ store, env: ENV })
  const token = await issueToken('u1', SECRET)
  const call = async (method, path, body) => {
    const response = await app.fetch(new Request('http://local' + path, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: response.status, data: await response.json() }
  }
  return { store, app, call }
}

test('后台 D1 绑定的无烘干名称机器可登记 10～180 分钟整数，类型从服务端返回', async () => {
  const { call, store } = await fixture()
  for (const minutes of [10, 30, 60, 90, 120, 180]) {
    const result = await call('POST', '/api/tasks', { machineId: 'd1', minutes })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(result.data.task.kind, 'dryer')
    assert.equal(result.data.task.leftMin, minutes)
    assert.equal((await store.get('occupancy:b1')).d1.taskId, result.data.task.id)
  }
  for (const minutes of [0, 9, 181, 10.5]) {
    assert.equal((await call('POST', '/api/tasks', { machineId: 'd1', minutes })).status, 400)
  }
  const board = await call('GET', '/api/machines?building=b1')
  assert.equal(board.data.board.floors[0].machines[0].kind, 'dryer')
  assert.deepEqual(board.data.mapping, { D1: 'd1' })
  const tasks = await call('GET', '/api/tasks')
  assert.ok(tasks.data.tasks.every((task) => task.kind === 'dryer'))
})

test('普通洗衣机仍执行洗衣时长校验，客户端不能伪造 kind', async () => {
  const { call } = await fixture({ id: 'w1', name: '洗衣机', state: 'idle' }, { 1: 'w1' })
  assert.equal((await call('POST', '/api/tasks', { machineId: 'w1', minutes: 60, kind: 'dryer' })).status, 400)
  assert.equal((await call('POST', '/api/tasks', { machineId: 'w1', minutes: 42 })).status, 200)
})

test('没有后台绑定的老烘干机仍按名称兼容', async () => {
  const { call } = await fixture({ id: 'd2', name: '桂园烘干机', state: 'idle' }, {})
  assert.equal((await call('POST', '/api/tasks', { machineId: 'd2', minutes: 120 })).status, 200)
})

test('非法备注在写任务和占用之前拒绝', async () => {
  const { call, store } = await fixture()
  assert.equal((await call('POST', '/api/tasks', { machineId: 'd1', minutes: 60, note: 123 })).status, 400)
  assert.equal(await store.get('tasks:u1'), null)
  assert.equal(await store.get('occupancy:b1'), null)
})

test('外部回写按配置的上游状态码归一化', async () => {
  const store = createMemoryStore()
  const env = { ...ENV, HAIER_STATE_MAP: JSON.stringify({ idle: [10], occupied: [20], faulty: [30] }) }
  await runSync(env, store, { raws: [{ id: 'a', state: 10 }, { id: 'b', state: 20 }, { id: 'c', state: 30 }] })
  const machines = (await store.get('machines:b1')).board.floors[0].machines
  assert.deepEqual(machines.map((machine) => machine.upstreamState), ['idle', 'occupied', 'faulty'])
  assert.equal(machines[2].state,'unknown')
  assert.equal(machines[2].health.suspectedFault,true)
})

test('过期估时不会在下一次同步重启，D机位默认估时60分钟', async () => {
  const store = createMemoryStore()
  await store.put('mapping:b1', { mapping: { D1: 'd1' } })
  const raws = [{ id: 'd1', name: '柳园西', state: 2, floorCode: '4', finishTime: null }]
  await runSync(ENV, store, { raws })
  const estimate = await store.get('est:b1:d1')
  assert.equal(estimate.mins, 60)
  estimate.endAt = Date.now() - 60000
  await store.put('est:b1:d1', estimate)
  await runSync(ENV, store, { raws })
  const machine = (await store.get('machines:b1')).board.floors[0].machines[0]
  assert.equal(new Date(machine.finishAt).getTime(), estimate.endAt)
  assert.ok(machine.leftMin <= 0)
  await runSync(ENV, store, { raws: [{ ...raws[0], state: 1 }] })
  assert.equal(await store.get('est:b1:d1'), null)
})

for (const method of ['take', 'delete']) {
  test(`操作旧任务 ${method} 不会清除同用户的新占用`, async () => {
    const { call, store } = await fixture()
    const oldTask = (await call('POST', '/api/tasks', { machineId: 'd1', minutes: 30 })).data.task
    const newTask = (await call('POST', '/api/tasks', { machineId: 'd1', minutes: 60 })).data.task
    const result = method === 'take'
      ? await call('POST', `/api/tasks/${oldTask.id}/take`)
      : await call('DELETE', `/api/tasks/${oldTask.id}`)
    assert.equal(result.status, 200)
    assert.equal((await store.get('occupancy:b1')).d1.taskId, newTask.id)
  })
}

test('普通同步复用正在进行的任务；多条外部回写依次落盘且均不丢失', async () => {
  const store = createMemoryStore()
  const first = runSync(ENV, store)
  assert.strictEqual(runSync(ENV, store), first)
  await first
  const saved = []
  const put = store.put.bind(store)
  let writing = 0
  let maxWriting = 0
  store.put = async (key, value) => {
    if (key === 'machines:b1') {
      writing++
      maxWriting = Math.max(maxWriting, writing)
      await new Promise((resolve) => setTimeout(resolve, 10))
      saved.push(value.board.floors[0].machines[0].id)
      writing--
    }
    return put(key, value)
  }
  await Promise.all(['a', 'b', 'c'].map((id) => runSync(ENV, store, { raws: [{ id, name: id, state: 1 }] })))
  assert.deepEqual(saved, ['a', 'b', 'c'])
  assert.equal(maxWriting, 1)
})

test('关闭提醒时空闲/到期/催衣/跳闸均不发私信或群消息', async (t) => {
  const { store, call } = await fixture({ id: 'd1', name: '柳园西', state: 'occupied', leftMin: 20 })
  await store.put('user:u2', { id: 'u2', nick: '关闭提醒', dingUserId: 'staff2', notifyOn: false })
  await store.put('occupancy:b1', { d1: { userId: 'u2', taskId: 't2' } })
  await store.put('tasks:u2', [{ id: 't2', machineId: 'd1', endAt: new Date(Date.now() - 120000).toISOString() }])
  await store.put('dryerstuck:b1', { d1: { remain: 20, since: Date.now() - 9 * 60000 } })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url) => { requests.push(String(url)); throw new Error('No network expected') })
  const env = { ...ENV, ...DING }
  await detectDryerStuck(env, store, [{ id: 'd1', name: '柳园西', state: 'occupied', leftMin: 20 }])
  const output = await runSync(env, store, { raws: [{ id: 'd1', name: '柳园西', state: 1 }] })
  assert.equal(output.groupNotices, 0)
  assert.equal(output.idleNotices, 0)
  assert.equal(output.notified, 0)
  assert.equal((await call('POST', '/api/urge', { machineId: 'd1' })).data.dmSent, false)
  assert.equal((await call('POST', '/api/dryer/stuck', { machineId: 'd1' })).data.dmSent, false)
  assert.deepEqual(requests, [])
  const check = await runSelfCheck(ENV, store)
  assert.ok(!check.issues.some((issue) => issue.kind === 'no_group'))
})

test('跳闸私信失败下一轮可重试，成功后才开始30分钟冷却', async (t) => {
  const { store } = await fixture({ id: 'd1', name: '柳园西', state: 'occupied', leftMin: 20 })
  await store.put('occupancy:b1', { d1: { userId: 'u1' } })
  await store.put('dryerstuck:b1', { d1: { remain: 20, since: Date.now() - 10 * 60000, notifiedAt: 0 } })
  const machine = [{ id: 'd1', name: '柳园西', state: 'occupied', leftMin: 20 }]
  const env = { ...ENV, ...DING }
  let deliver = false
  let sends = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/oToMessages/batchSend')) {
      sends++
      return new Response('{}', { status: deliver ? 200 : 503 })
    }
    return new Response(JSON.stringify({ accessToken: 'fake-token', errcode: 0 }))
  })
  assert.equal(await detectDryerStuck(env, store, machine), 0)
  const failed = (await store.get('dryerstuck:b1')).d1
  assert.equal(failed.notifiedAt, 0)
  assert.ok(failed.checkedAt > 0)
  const failedSends = sends
  assert.ok(failedSends > 0)

  deliver = true
  assert.equal(await detectDryerStuck(env, store, machine), 1)
  assert.ok(sends > failedSends)
  const succeeded = (await store.get('dryerstuck:b1')).d1
  assert.ok(succeeded.notifiedAt > 0)
  const deliveredSends = sends
  assert.equal(await detectDryerStuck(env, store, machine), 0)
  assert.equal(sends, deliveredSends)
  assert.equal((await store.get('dryerstuck:b1')).d1.notifiedAt, succeeded.notifiedAt)
})

test('跳闸私信抛出网络异常不写送达冷却，下轮仍尝试', async (t) => {
  const { store } = await fixture()
  await store.put('occupancy:b1', { d1: { userId: 'u1' } })
  await store.put('dryerstuck:b1', { d1: { remain: 20, since: Date.now() - 10 * 60000 } })
  const machines = [{ id: 'd1', name: '柳园西', state: 'occupied', leftMin: 20 }]
  let sends = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/oToMessages/batchSend')) { sends++; throw new Error('offline') }
    return new Response(JSON.stringify({ accessToken: 'fake-token', errcode: 0 }))
  })
  assert.equal(await detectDryerStuck({ ...ENV, ...DING }, store, machines), 0)
  assert.equal((await store.get('dryerstuck:b1')).d1.notifiedAt, 0)
  assert.equal(await detectDryerStuck({ ...ENV, ...DING }, store, machines), 0)
  assert.equal(sends, 2)
})

test('跳闸无收件人或关闭提醒只记录检查时间，不发送或假记送达', async (t) => {
  const { store } = await fixture()
  const machines = [{ id: 'd1', name: '柳园西', state: 'occupied', leftMin: 20 }]
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('没有收件人时不能发请求') })
  for (const holder of [null, { userId: 'u1' }]) {
    await store.put('occupancy:b1', holder ? { d1: holder } : {})
    await store.put('user:u1', { id: 'u1', dingUserId: 'staff1', notifyOn: false })
    await store.put('dryerstuck:b1', { d1: { remain: 20, since: Date.now() - 10 * 60000 } })
    assert.equal(await detectDryerStuck({ ...ENV, ...DING }, store, machines), 0)
    assert.equal(await detectDryerStuck({ ...ENV, ...DING }, store, machines), 0)
    const record = (await store.get('dryerstuck:b1')).d1
    assert.equal(record.notifiedAt, 0)
    assert.ok(record.checkedAt > 0)
  }
})

test('同步的空闲事件和同一任务到期只发送一次私信；有群配置也不播报', async (t) => {
  const { store } = await fixture({ id: 'd1', name: '柳园西', state: 'occupied', leftMin: 1 })
  await store.put('occupancy:b1', { d1: { userId: 'u1', taskId: 't1' } })
  await store.put('tasks:u1', [{ id: 't1', machineId: 'd1', machineName: '柳园西', endAt: new Date(Date.now() - 60000).toISOString() }])
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url))
    return new Response(JSON.stringify({ accessToken: 'fake-token', access_token: 'fake-token', errcode: 0 }), { headers: { 'content-type': 'application/json' } })
  })
  const env = { ...ENV, ...DING }
  const raws = [{ id: 'd1', name: '柳园西', state: 1 }]
  const output = await runSync(env, store, { raws })
  assert.equal(output.idleNotices, 0)
  assert.equal(output.notified, 1)
  await runSync(env, store, { raws })
  assert.equal(requests.filter((url) => url.includes('/oToMessages/batchSend')).length, 1)
  assert.equal(requests.filter((url) => url.includes('/groupMessages/') || url.includes('/robot/send?')).length, 0)
})

test('未签名回调不能伪造用户认领或确认已取', async () => {
  const { store, call } = await fixture()
  await store.put('userByDing:staff1', 'u1')
  await store.put('tasks:u1', [{ id: 'old', machineId: 'd1', endAt: new Date(Date.now() - 60000).toISOString(), done: false }])
  for (const content of ['认领 D1', '已取']) {
    await call('POST', '/api/dingtalk/callback', { msgtype: 'text', text: { content }, senderStaffId: 'staff1', conversationType: '2' })
    assert.equal((await store.get('tasks:u1')).length, 1)
    assert.equal((await store.get('tasks:u1'))[0].done, false)
    assert.equal((await store.get('ding:lastCallback')).bindRejected, 'plain_callback_unsigned')
  }
})

test('主动催衣只私信占用者，不群发或群@', async (t) => {
  const { store } = await fixture()
  await store.put('user:u2', { id: 'u2', nick: '占用者', dingUserId: 'staff2' })
  await store.put('occupancy:b1', { d1: { userId: 'u2' } })
  const app = createApp({ store, env: { ...ENV, ...DING } })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url))
    return new Response(JSON.stringify({ accessToken: 'fake-token', errcode: 0 }))
  })
  const response = await app.fetch(new Request('http://local/api/urge', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + await issueToken('u1', SECRET), 'content-type': 'application/json' },
    body: JSON.stringify({ machineId: 'd1' }),
  }))
  const result = await response.json()
  assert.equal(result.dmSent, true)
  assert.equal(result.groupSent, false)
  assert.match(result.hint, /私信/)
  assert.equal(requests.filter((url) => url.includes('/oToMessages/batchSend')).length, 1)
  assert.equal(requests.filter((url) => url.includes('/groupMessages/') || url.includes('/robot/send?')).length, 0)
})

test('队列按每台机器的先来先到返回 1、2、3 位', async () => {
  const { store, call } = await fixture()
  await store.put('queue:b1', [
    { id: 'q1', machineId: 'd1', userId: 'a' },
    { id: 'q2', machineId: 'other', userId: 'b' },
    { id: 'q3', machineId: 'd1', userId: 'c' },
    { id: 'q4', machineId: 'd1', userId: 'u1' },
  ])
  const queue = (await call('GET', '/api/queue')).data.queue
  assert.deepEqual(queue.map((entry) => entry.position), [1, 1, 2, 3])
  assert.equal(queue[3].mine, true)
})

test('留言仅查询当前作者，不扫描整个用户库', async () => {
  const { store, call } = await fixture()
  await store.put('messages:b1', [{ id: 'm1', userId: 'u1', nick: '旧昵称', text: 'hi' }])
  const list = store.list.bind(store)
  store.list = async (prefix) => { assert.notEqual(prefix, 'user:'); return list(prefix) }
  const result = await call('GET', '/api/messages')
  assert.equal(result.status, 200)
  assert.equal(result.data.messages[0].nick, '测**')
})
