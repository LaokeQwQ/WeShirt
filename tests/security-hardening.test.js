// 上线前安全加固：密钥缺失必须 fail-closed、取回码下线、留言限流、机器校验
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'a'.repeat(16)

async function makeApp(env = {}, seed) {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: ADMIN, BUILDING_ID: 'b1', AUTH_SECRET: SECRET, ...env },
  })
  const call = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers }
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
  return { store, call, A: { 'x-admin-token': ADMIN } }
}

async function seedUser(store) {
  await store.put('user:u_1', { id: 'u_1', nick: '测试同学', avatar: 'av1', takeCode: '123456' })
  await store.put('takeCode:123456', 'u_1')
}

// ---------- 密钥缺失必须拒绝，不能退化成内置默认值 ----------

test('没有 AUTH_SECRET 时，任何 Bearer 都不认', async () => {
  const { call } = await makeApp({ AUTH_SECRET: '' }, seedUser)
  const tok = await issueToken('u_1', SECRET)
  const r = await call('GET', '/api/auth/me', { headers: { authorization: 'Bearer ' + tok } })
  assert.equal(r.status, 401)
})

test('没有 AUTH_SECRET 时 claim 返回 503，而不是用默认密钥签一个 token', async () => {
  const { call } = await makeApp({ AUTH_SECRET: '' }, seedUser)
  const r = await call('POST', '/api/auth/claim', { body: { code: 'x'.repeat(40) } })
  assert.ok([400, 503].includes(r.status), `got ${r.status}`)
  assert.ok(!r.j?.token, '绝不能发出 token')
})

test('AUTH_SECRET 太短也当没配', async () => {
  const { call } = await makeApp({ AUTH_SECRET: 'short' }, seedUser)
  const tok = await issueToken('u_1', 'short')
  const r = await call('GET', '/api/auth/me', { headers: { authorization: 'Bearer ' + tok } })
  assert.equal(r.status, 401)
})

test('没有 ADMIN_TOKEN 时管理接口全拒（不会退化成 admin123）', async () => {
  const { call } = await makeApp({ ADMIN_TOKEN: '' })
  for (const p of ['/api/admin/users', '/api/admin/status', '/api/admin/audit-logs']) {
    const r = await call('GET', p, { headers: { 'x-admin-token': 'admin123' } })
    assert.ok([401, 403].includes(r.status), `${p} 不该接受默认口令，实际 ${r.status}`)
    assert.ok(!r.j?.counts && !r.j?.items && !r.j?.events, `${p} 不该返回数据`)
  }
})

test('口令太短也不认', async () => {
  const { call } = await makeApp({ ADMIN_TOKEN: '123' })
  const r = await call('GET', '/api/admin/users', { headers: { 'x-admin-token': '123' } })
  assert.equal(r.status, 401)
})

// ---------- 取回码登录下线 ----------

test('/api/auth/takecode 已下线（410），不换 token', async () => {
  const { call } = await makeApp({}, seedUser)
  const r = await call('POST', '/api/auth/takecode', { body: { code: '123456' } })
  assert.equal(r.status, 410)
  assert.ok(!r.j?.token)
})

// ---------- 留言：长度与频控 ----------

test('留言超长被明确拒绝且不写入', async () => {
  const { store, call } = await makeApp({}, seedUser)
  const tok = await issueToken('u_1', SECRET)
  const response = await call('POST', '/api/messages', {
    body: { text: '字'.repeat(500), channel: 'public' },
    headers: { authorization: 'Bearer ' + tok },
  })
  const list = await store.get('messages:b1', [])
  assert.equal(response.status, 400)
  assert.equal(list.length, 0)
})

test('留言 5 秒内只能发一条（防刷屏挤掉别人的）', async () => {
  const { call } = await makeApp({}, seedUser)
  const tok = await issueToken('u_1', SECRET)
  const h = { authorization: 'Bearer ' + tok }
  const a = await call('POST', '/api/messages', { body: { text: '第一条', channel: 'public' }, headers: h })
  assert.equal(a.status, 200)
  const b = await call('POST', '/api/messages', { body: { text: '第二条', channel: 'public' }, headers: h })
  assert.equal(b.status, 429)
})

test('留言列表不暴露 userId', async () => {
  const { call } = await makeApp({}, async (s) => {
    await seedUser(s)
    await s.put('messages:b1', [
      { id: 'm1', userId: 'u_1', nick: 'x', avatar: 'av1', text: 'hi', channel: 'public', at: '2026-10-26T00:00:00Z' },
    ])
  })
  const r = await call('GET', '/api/messages')
  assert.equal(r.status, 200)
  assert.equal(r.j.messages[0].userId, undefined)
  assert.equal(r.j.messages[0].text, 'hi')
})

// ---------- 登记：机器必须存在 ----------

test('登记不存在的机器被拒（不再写幽灵占用）', async () => {
  const { store, call } = await makeApp({}, async (s) => {
    await seedUser(s)
    await s.put('machines:b1', {
      board: { floors: [{ code: '1', machines: [{ id: 'm1', name: '1号机', floorCode: '1', state: 'idle' }] }] },
    })
  })
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/tasks', {
    body: { machineId: 'not_exist', minutes: 30 },
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 404)
  const occ = await store.get('occupancy:b1', {})
  assert.equal(Object.keys(occ).length, 0, '不该留下幽灵占用')
})

test('看板为空时不拦登记（首次启动/上游挂了别把人挡在门外）', async () => {
  const { call } = await makeApp({}, seedUser)
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/tasks', {
    body: { machineId: 'm1', minutes: 30 },
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 200)
})

// ---------- 排队 mine ----------

test('带 token 拉排队列表时能认出哪条是我的', async () => {
  const { call } = await makeApp({}, async (s) => {
    await seedUser(s)
    await s.put('machines:b1',{board:{floors:[{code:'1',machines:[{id:'m1',name:'桂园测试机',state:'idle'}]}]}})
    await s.put('queue:b1', [
      { id: 'q1', userId: 'u_1', machineId: 'm1', nick: '我', avatar: 'av1', at: 'x' },
      { id: 'q2', userId: 'u_2', machineId: 'm1', nick: '别人', avatar: 'av1', at: 'x' },
    ])
  })
  const tok = await issueToken('u_1', SECRET)
  const r = await call('GET', '/api/queue?building=b1', { headers: { authorization: 'Bearer ' + tok } })
  assert.equal(r.status, 200)
  const mine = r.j.queue.filter((q) => q.mine)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].id, 'q1')
})

test('匿名拉排队列表也能读，只是 mine 全 false', async () => {
  const { call } = await makeApp({}, async (s) => {
    await s.put('machines:b1',{board:{floors:[{code:'1',machines:[{id:'m1',name:'桂园测试机',state:'idle'}]}]}})
    await s.put('queue:b1', [{ id: 'q1', userId: 'u_1', machineId: 'm1', nick: 'x', avatar: 'av1', at: 'x' }])
  })
  const r = await call('GET', '/api/queue?building=b1')
  assert.equal(r.status, 200)
  assert.equal(r.j.queue[0].mine, false)
})
