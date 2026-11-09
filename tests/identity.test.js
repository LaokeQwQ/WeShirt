// 账号身份：设备密钥续用、钉钉找回、一次性取回码
// 背景：token 只存 localStorage，换设备/清缓存就会生成新匿名用户，
// 用户看到的是「我的资料又变了、还变成未绑定」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { mergeUserActivity, findExistingUser } from '../packages/core/account.js'

const SECRET = 's'.repeat(32)
const DEVICE_A = 'a'.repeat(32)
const DEVICE_B = 'b'.repeat(32)

function makeApp(seed) {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET } })
  const call = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers }
    if (body) h['content-type'] = 'application/json'
    const r = await app.fetch(
      new Request('http://x' + path, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
      })
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
  return { store, call, app, seed }
}

// ---------- /api/auth 设备密钥 ----------
// 注意：身份改为「只能由钉钉登录产生」后，/api/auth 不再新建用户。
// 这里的用例都先手工建立「设备密钥 → 用户」的绑定，模拟登录后的状态。

test('同一设备密钥多次换 token 拿到同一身份', async () => {
  const { call, store } = makeApp()
  await store.put('user:u_dev', { id: 'u_dev', nick: '设备用户', takeCode: '000000' })
  await store.put(`userByDevice:${DEVICE_A}`, 'u_dev')

  const a = await call('POST', '/api/auth', { body: { device: DEVICE_A } })
  const b = await call('POST', '/api/auth', { body: { device: DEVICE_A } })
  assert.equal(a.status, 200)
  assert.equal(a.j.user.id, 'u_dev')
  assert.equal(b.j.user.id, 'u_dev', '同设备应续用同一 user')
  assert.notEqual(a.j.token, b.j.token, 'token 每次重新签发（含 ts）')
})

test('不同设备密钥各自绑定的身份互不影响', async () => {
  const { call, store } = makeApp()
  await store.put('user:u_a', { id: 'u_a', nick: 'A', takeCode: '000000' })
  await store.put('user:u_b', { id: 'u_b', nick: 'B', takeCode: '111111' })
  await store.put(`userByDevice:${DEVICE_A}`, 'u_a')
  await store.put(`userByDevice:${DEVICE_B}`, 'u_b')

  const a = await call('POST', '/api/auth', { body: { device: DEVICE_A } })
  const b = await call('POST', '/api/auth', { body: { device: DEVICE_B } })
  assert.equal(a.j.user.id, 'u_a')
  assert.equal(b.j.user.id, 'u_b')
})

test('不接受 userId 当凭证（防身份冒用）', async () => {
  const { call, store } = makeApp()
  await store.put('user:u_victim', { id: 'u_victim', nick: '受害者', takeCode: '222222' })

  // 攻击者用别人的 user id 当 uuid / device
  const a1 = await call('POST', '/api/auth', { body: { uuid: 'u_victim' } })
  const a2 = await call('POST', '/api/auth', { body: { device: 'u_victim' } })
  for (const r of [a1, a2]) {
    assert.equal(r.status, 401, '必须拒绝，不能签发 token')
    assert.equal(r.j.error.code, 'need_login')
  }
})

test('未绑定设备不再自动开户', async () => {
  const { call, store } = makeApp()
  const r = await call('POST', '/api/auth', { body: { device: DEVICE_B } })
  assert.equal(r.status, 401)
  assert.equal((await store.list('user:')).length, 0, '不能凭空建用户')
})

// ---------- 一次性取回码 ----------

test('取回码只能用一次', async () => {
  const { call, store } = makeApp()
  const uid = 'u_claim'
  await store.put(`user:${uid}`, { id: uid, nick: '取回用户', takeCode: '333333' })
  const code = 'c'.repeat(32)
  await store.put(`claim:${code}`, { userId: uid, expAt: new Date(Date.now() + 3e5).toISOString() })

  const first = await call('POST', '/api/auth/claim', { body: { code } })
  assert.equal(first.status, 200)
  assert.equal(first.j.user.id, uid)

  const second = await call('POST', '/api/auth/claim', { body: { code } })
  assert.equal(second.status, 400, '重放必须失败')
  assert.match(second.j.error.message, /无效|已使用/)
})

test('过期取回码被拒', async () => {
  const { call, store } = makeApp()
  const code = 'd'.repeat(32)
  await store.put(`claim:${code}`, { userId: 'u_claim', expAt: '2020-01-01T00:00:00Z' })
  const r = await call('POST', '/api/auth/claim', { body: { code } })
  assert.equal(r.status, 400)
  assert.match(r.j.error.message, /过期/)
})

test('取回码格式非法直接拒', async () => {
  const { call } = makeApp()
  for (const code of ['', 'short', 'x', 'u_1rvr170b34', 'z'.repeat(200)]) {
    const r = await call('POST', '/api/auth/claim', { body: { code } })
    assert.equal(r.status, 400, code)
  }
})

// ---------- 账号合并 ----------

test('mergeUserActivity 搬留言/任务/排队/占用', async () => {
  const store = createMemoryStore()
  await store.put('messages:b1', [
    { id: 'm1', userId: 'u_from', nick: '新临时名', text: 'a', at: '2026-10-24T10:00:00Z' },
    { id: 'm2', userId: 'u_other', nick: '别人', text: 'b', at: '2026-10-24T11:00:00Z' },
  ])
  await store.put('tasks:u_from', [{ id: 't1', machineId: '1', endAt: '2026-10-24T12:00:00Z' }])
  await store.put('tasks:u_to', [{ id: 't2', machineId: '2', endAt: '2026-10-24T13:00:00Z' }])
  await store.put('queue:b1', [
    { userId: 'u_from', machineId: '3' },
    { userId: 'u_other', machineId: '4' },
  ])
  await store.put('occupancy:b1', {
    5: { userId: 'u_from', nick: '新临时名', endAt: '2026-10-24T14:00:00Z' },
    6: { userId: 'u_other', nick: '别人' },
  })

  const r = await mergeUserActivity(store, 'u_from', 'u_to', { buildingId: 'b1', nick: '旧昵称' })
  assert.equal(r.messages, 1)
  assert.equal(r.tasks, 1)
  assert.equal(r.queue, 1)
  assert.equal(r.occupancy, 1)

  const msgs = await store.get('messages:b1', [])
  assert.equal(msgs.find((m) => m.id === 'm1').userId, 'u_to')
  assert.equal(msgs.find((m) => m.id === 'm1').nick, '旧昵称', '留言昵称也要跟着换')
  assert.equal(msgs.find((m) => m.id === 'm2').userId, 'u_other', '别人的不能动')

  const tasks = await store.get('tasks:u_to', [])
  assert.deepEqual(tasks.map((t) => t.id).sort(), ['t1', 't2'])
  assert.equal(await store.get('tasks:u_from', null), null, '旧任务要清掉')

  const q = await store.get('queue:b1', [])
  assert.equal(q.filter((x) => x.userId === 'u_to').length, 1)

  const occ = await store.get('occupancy:b1', {})
  assert.equal(occ['5'].userId, 'u_to')
  assert.equal(occ['6'].userId, 'u_other')
})

test('mergeUserActivity 同一台机器排队不重复', async () => {
  const store = createMemoryStore()
  await store.put('queue:b1', [
    { userId: 'u_to', machineId: '9' },
    { userId: 'u_from', machineId: '9' },
  ])
  const r = await mergeUserActivity(store, 'u_from', 'u_to', { buildingId: 'b1' })
  assert.equal(r.queue, 0, '同一台机器的重复排队应被丢弃')
  const q = await store.get('queue:b1', [])
  assert.equal(q.length, 1)
})

test('mergeUserActivity 同 id 时是空操作', async () => {
  const store = createMemoryStore()
  const r = await mergeUserActivity(store, 'u_same', 'u_same', {})
  assert.deepEqual(r, { messages: 0, tasks: 0, queue: 0, occupancy: 0 })
})

test('findExistingUser 按 钉钉 → unionId → 手机号 依次匹配', async () => {
  const store = createMemoryStore()
  await store.put('user:u_ding', { id: 'u_ding', nick: '钉钉用户', dingUserId: 'staff_1' })
  await store.put('userByDing:staff_1', 'u_ding')
  await store.put('user:u_union', { id: 'u_union', nick: 'union 用户', dingUnionId: 'un_1' })
  await store.put('userByUnionId:un_1', 'u_union')
  await store.put('user:u_phone', { id: 'u_phone', nick: '手机用户', mobile: '13800001111' })

  const byDing = await findExistingUser(store, { dingUserId: 'staff_1' })
  assert.equal(byDing.user.id, 'u_ding')
  assert.equal(byDing.via, 'ding')

  const byUnion = await findExistingUser(store, { unionId: 'un_1' })
  assert.equal(byUnion.user.id, 'u_union')
  assert.equal(byUnion.via, 'unionid')

  const byPhone = await findExistingUser(store, { mobile: '13800001111' })
  assert.equal(byPhone.user.id, 'u_phone')
  assert.equal(byPhone.via, 'mobile')
})

test('findExistingUser 索引缺失时兜底扫表（防老账号被当成新用户）', async () => {
  const store = createMemoryStore()
  // 有 dingUserId 字段，但故意不写 userByDing 索引（历史数据常见）
  await store.put('user:u_legacy', { id: 'u_legacy', nick: '老用户', dingUserId: 'staff_legacy' })

  const r = await findExistingUser(store, { dingUserId: 'staff_legacy' })
  assert.equal(r.user.id, 'u_legacy', '必须靠扫表找回来，否则老用户会被重建')
  assert.equal(r.via, 'ding_scan')
})

test('findExistingUser 排除自己，找不到返回 null', async () => {
  const store = createMemoryStore()
  await store.put('user:u_self', { id: 'u_self', dingUserId: 'staff_self' })
  await store.put('userByDing:staff_self', 'u_self')

  const self = await findExistingUser(store, { dingUserId: 'staff_self', excludeId: 'u_self' })
  assert.equal(self.user, null, '不能把自己当成「要找回的老账号」')

  const none = await findExistingUser(store, { dingUserId: 'staff_none' })
  assert.equal(none.user, null)
  assert.equal(none.via, '')
})
