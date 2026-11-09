// 群里「回复认领」：和网页点登记同样的效果
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { parseCommand, buildEncryptedResponse } from '../packages/core/dingtalk.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'test-admin-token'
const STAFF = 'staff-001'
const AES_KEY = btoa('a'.repeat(32)).replace(/=+$/, '')

function board() {
  return {
    board: {
      buildingId: 'b1',
      buildingName: '桂园',
      updatedAt: new Date().toISOString(),
      total: 3,
      floors: [
        {
          code: '1F',
          machines: [
            { id: 'm7', name: '桂园1楼7号机', floorCode: '1', state: 'occupied', finishAt: new Date(Date.now() + 20 * 60000).toISOString(), leftMin: 20 },
            { id: 'm8', name: '桂园1楼8号机', floorCode: '1', state: 'idle', finishAt: null, leftMin: null },
            { id: 'm9', name: '桂园1楼7号烘干机', floorCode: '1', state: 'occupied', finishAt: new Date(Date.now() + 15 * 60000).toISOString(), leftMin: 15 },
          ],
        },
      ],
    },
    rawUpdatedAt: new Date().toISOString(),
  }
}

// 后台机位绑定：1→m7（洗衣机），2→m8（空闲），D1→m9（烘干机）
const MAPPING = { mapping: { 1: 'm7', 2: 'm8', D1: 'm9' }, updatedAt: new Date().toISOString() }

async function makeApp(seed) {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: {
      ADMIN_TOKEN: ADMIN,
      BUILDING_ID: 'b1',
      AUTH_SECRET: SECRET,
      HAIER_MODE: 'mock',
      DINGTALK_TOKEN: 'tok',
      DINGTALK_AES_KEY: AES_KEY,
    },
  })
  const call = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers }
    if (path === '/api/dingtalk/callback') {
      const signed = await buildEncryptedResponse({
        plainText: JSON.stringify(body),
        aesKey: AES_KEY,
        ownerKey: '',
        token: 'tok',
        timestamp: String(Date.now()),
        nonce: 'claim-regression',
      })
      body = { encrypt: signed.encrypt }
      path += '?' + new URLSearchParams({
        msg_signature: signed.msg_signature,
        timestamp: signed.timeStamp,
        nonce: signed.nonce,
      })
    }
    if (body) h['content-type'] = 'application/json'
    const r = await app.fetch(
      new Request('http://x' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })
    )
    const text = await r.text()
    let j = null
    try {
      j = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, j, text }
  }
  if (seed) await seed(store)
  return { store, call }
}

function plainMsg(content, extra = {}) {
  return {
    msgtype: 'text',
    text: { content },
    senderStaffId: STAFF,
    senderNick: '测试同学',
    conversationType: '2',
    conversationId: 'cidTEST==',
    ...extra,
  }
}

test('指令解析：认领机位号（含 D1）与「已取」', () => {
  assert.deepEqual(parseCommand('认领 3'), { cmd: 'claim', arg: '3' })
  assert.deepEqual(parseCommand('认领'), { cmd: 'claim', arg: null })
  assert.deepEqual(parseCommand('认领D1'), { cmd: 'claim', arg: 'D1' })
  assert.deepEqual(parseCommand('claim 12'), { cmd: 'claim', arg: '12' })
  assert.deepEqual(parseCommand('已取'), { cmd: 'taken', arg: null })
  assert.deepEqual(parseCommand('取走了'), { cmd: 'taken', arg: null })
})

test('验签成功的「已取」把待取任务标成已取', async () => {
  const { store, call } = await makeApp(async (s) => {
    await s.put('machines:b1', board())
    await s.put('mapping:b1', MAPPING)
    await s.put('user:u_1', { id: 'u_1', nick: '测试同学', dingUserId: STAFF })
    await s.put(`userByDing:${STAFF}`, 'u_1')
    await s.put('tasks:u_1', [
      {
        id: 't1',
        userId: 'u_1',
        machineId: 'm7',
        machineName: '桂园1楼7号机',
        startAt: new Date(Date.now() - 40 * 60000).toISOString(),
        endAt: new Date(Date.now() - 10 * 60000).toISOString(),
        done: false,
      },
    ])
    await s.put('occupancy:b1', { m7: { userId: 'u_1', nick: '测试同学' } })
  })
  const r = await call('POST', '/api/dingtalk/callback', { body: plainMsg('已取') })
  assert.equal(r.status, 200, r.text)

  const tasks = await store.get('tasks:u_1', [])
  assert.equal(tasks[0].done, true, '应该标成已取')
  assert.ok(tasks[0].takenAt, '要记时间')
  const occ = await store.get('occupancy:b1', {})
  assert.equal(occ.m7, undefined, '占用要清掉')
})

test('验签成功的「认领 1」按机位建任务', async () => {
  const { store, call } = await makeApp(async (s) => {
    await s.put('machines:b1', board())
    await s.put('mapping:b1', MAPPING)
    await s.put('user:u_1', { id: 'u_1', nick: '测试同学', dingUserId: STAFF, notifyOn: true })
    await s.put(`userByDing:${STAFF}`, 'u_1')
  })
  const r = await call('POST', '/api/dingtalk/callback', { body: plainMsg('认领 1') })
  assert.equal(r.status, 200, r.text)

  const tasks = await store.get('tasks:u_1', [])
  assert.equal(tasks.length, 1, '应该建出一条任务')
  assert.equal(tasks[0].machineId, 'm7')
  assert.ok(new Date(tasks[0].endAt).getTime() > Date.now())

  const occ = await store.get('occupancy:b1', {})
  assert.equal(occ.m7.userId, 'u_1', '占用表要记上')
})

test('烘干机也能认领（D1 机位）', async () => {
  const { store, call } = await makeApp(async (s) => {
    await s.put('machines:b1', board())
    await s.put('mapping:b1', MAPPING)
    await s.put('user:u_1', { id: 'u_1', nick: '测试同学', dingUserId: STAFF })
    await s.put(`userByDing:${STAFF}`, 'u_1')
  })
  await call('POST', '/api/dingtalk/callback', { body: plainMsg('认领 D1') })
  const tasks = await store.get('tasks:u_1', [])
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].machineId, 'm9', 'D1 应该绑到烘干机')
})

test('空闲机位不能认领', async () => {
  const { store, call } = await makeApp(async (s) => {
    await s.put('machines:b1', board())
    await s.put('mapping:b1', MAPPING)
    await s.put('user:u_1', { id: 'u_1', nick: '测试同学', dingUserId: STAFF })
    await s.put(`userByDing:${STAFF}`, 'u_1')
  })
  await call('POST', '/api/dingtalk/callback', { body: plainMsg('认领 2') })
  const tasks = await store.get('tasks:u_1', [])
  assert.equal(tasks.length || 0, 0, '空闲机器不该建任务')
})

test('没绑定的机位不认机器名（去掉按机号自动录）', async () => {
  const { store, call } = await makeApp(async (s) => {
    await s.put('machines:b1', board())
    await s.put('mapping:b1', { mapping: { 1: 'm7' } }) // 只绑了 1 号位
    await s.put('user:u_1', { id: 'u_1', nick: '测试同学', dingUserId: STAFF })
    await s.put(`userByDing:${STAFF}`, 'u_1')
  })
  // 机器名里有 7，但 7 不是机位号，不该被认领
  await call('POST', '/api/dingtalk/callback', { body: plainMsg('认领 7') })
  const tasks = await store.get('tasks:u_1', [])
  assert.equal(tasks.length || 0, 0)
})

test('没绑定的钉钉用户会被引导先登录', async () => {
  const { store, call } = await makeApp(async (s) => {
    await s.put('machines:b1', board())
  })
  await call('POST', '/api/dingtalk/callback', { body: plainMsg('认领 7') })
  const entry = await store.get('ding:lastReply', null)
  // 没有用户就不该写任务（这里只验证没有幽灵数据）
  assert.equal(entry, null)
})
