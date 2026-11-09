// 管理后台功能测试（node:test）
// 覆盖：用户管理 / 留言板管理 / 机器状态 / 上报审计
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'

const ADMIN = 'test-admin'

async function makeApp(seed) {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: ADMIN, BUILDING_ID: 'b1', AUTH_SECRET: 's'.repeat(32) },
  })
  if (seed) await seed(store)
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
  return { store, call, A: { 'x-admin-token': ADMIN } }
}

async function seedBasic(store) {
  await store.put('user:u_a', {
    id: 'u_a',
    nick: '小明',
    avatar: 'av1',
    createdAt: '2026-10-01T00:00:00Z',
    dingUserId: 'staff_a',
    dingNick: '曹祺琦',
    mobile: '13812345678',
  })
  await store.put('user:u_b', { id: 'u_b', nick: '小红', avatar: 'av2', createdAt: '2026-10-02T00:00:00Z' })
  await store.put('userByDing:staff_a', 'u_a')
  await store.put('messages:b1', [
    { id: 'm_1', userId: 'u_a', nick: '小明', text: '第一条', at: '2026-10-24T10:00:00Z' },
    { id: 'm_2', userId: 'u_b', nick: '小红', text: '第二条', at: '2026-10-24T11:00:00Z' },
  ])
  await store.put('occupancy:b1', {
    1: { userId: 'u_a', nick: '小明', endAt: new Date(Date.now() + 600000).toISOString() },
  })
  await store.put('queue:b1', [
    { userId: 'u_b', machineId: '1' },
    { userId: 'u_b', machineId: '2' },
  ])
  await store.put('machines:b1', {
    at: '2026-10-24T12:00:00Z',
    board: {
      floors: [
        {
          code: '1F',
          machines: [
            // 归一化后的真实形态：{ id, name, floorCode, state, finishAt, leftMin }
            // 没有 kind 字段，烘干机靠名字里的「烘干」识别
            {
              id: '1',
              name: '桂园1楼1号机',
              floorCode: '1',
              state: 'occupied',
              finishAt: new Date(Date.now() + 20 * 60000).toISOString(),
              leftMin: 20,
            },
            {
              id: 'D1',
              name: '桂园1楼7号烘干机',
              floorCode: '1',
              state: 'occupied',
              finishAt: new Date(Date.now() + 30 * 60000).toISOString(),
              leftMin: 30,
            },
          ],
        },
      ],
    },
  })
  await store.put('urgeaudit:b1:1:1-a1', {
    auditId: 'a1',
    at: '2026-10-24T12:30:00Z',
    machineId: '1',
    requesterId: 'u_b',
    occupierId: 'u_a',
  })
  await store.put('urgephoto:a1:occ', 'data:image/jpeg;base64,AAAA')
}

test('用户列表：返回全部、按时间倒序、手机号脱敏', async () => {
  const { call, A } = await makeApp(seedBasic)
  const r = await call('GET', '/api/admin/users', { headers: A })
  assert.equal(r.status, 200)
  assert.equal(r.j.total, 2)
  // 后创建的 u_b 排前面
  assert.equal(r.j.items[0].id, 'u_b')
  const a = r.j.items.find((x) => x.id === 'u_a')
  assert.equal(a.mobile, '138****5678')
  assert.equal(a.dingNick, '曹祺琦')
  // 明文手机号不能出现在响应里
  assert.ok(!r.text.includes('13812345678'))
})

test('用户搜索：按昵称 / 钉钉昵称 / 账号 ID 命中', async () => {
  const { call, A } = await makeApp(seedBasic)
  for (const q of ['曹祺琦', '小明', 'u_a']) {
    const r = await call('GET', '/api/admin/users?q=' + encodeURIComponent(q), { headers: A })
    assert.equal(r.j.total, 1, `q=${q}`)
    assert.equal(r.j.items[0].id, 'u_a', `q=${q}`)
  }
  const none = await call('GET', '/api/admin/users?q=不存在的人', { headers: A })
  assert.equal(none.j.total, 0)
})

test('用户详情：默认脱敏，phone=1 才给全号', async () => {
  const { call, A } = await makeApp(seedBasic)
  const d = await call('GET', '/api/admin/user/u_a', { headers: A })
  assert.equal(d.j.user.mobile, '138****5678')
  const f = await call('GET', '/api/admin/user/u_a?phone=1', { headers: A })
  assert.equal(f.j.user.mobile, '13812345678')
})

test('用户修改：改昵称 / 解绑钉钉（要清 userByDing 索引）', async () => {
  const { call, store, A } = await makeApp(seedBasic)
  const r = await call('POST', '/api/admin/user/u_a', { body: { nick: '小明改名' }, headers: A })
  assert.equal(r.j.user.nick, '小明改名')

  const u = await call('POST', '/api/admin/user/u_a', { body: { unbindDing: true }, headers: A })
  assert.equal(u.j.user.dingBound, false)
  assert.equal(u.j.user.dingUserId, null)
  assert.equal(await store.get('userByDing:staff_a', null), null)
})

test('用户删除：连带删留言、清任务', async () => {
  const { call, store, A } = await makeApp(async (s) => {
    await seedBasic(s)
    await s.put('tasks:u_b', [{ id: 't1', machineId: '1', endAt: '2026-10-24T13:00:00Z' }])
  })
  const d = await call('DELETE', '/api/admin/user/u_b', { headers: A })
  assert.equal(d.status, 200)
  assert.equal(d.j.removedMessages, 1)
  assert.equal(await store.get('user:u_b', null), null)
  assert.equal(await store.get('tasks:u_b', null), null)
  const msgs = await store.get('messages:b1', [])
  assert.equal(msgs.length, 1) // 只剩 u_a 那条
})

test('留言板：列表倒序 + 完整昵称，删单条 / 清空', async () => {
  const { call, A } = await makeApp(seedBasic)
  const r = await call('GET', '/api/admin/messages', { headers: A })
  assert.equal(r.j.total, 2)
  assert.equal(r.j.items[0].id, 'm_2') // 倒序
  assert.equal(r.j.items[0].nick, '小红') // 管理端不打码

  const d = await call('DELETE', '/api/admin/message/m_1', { headers: A })
  assert.equal(d.j.total, 1)

  const miss = await call('DELETE', '/api/admin/message/not_exist', { headers: A })
  assert.equal(miss.status, 404)

  const c = await call('DELETE', '/api/admin/messages', { headers: A })
  assert.equal(c.j.removed, 1)
  assert.equal((await call('GET', '/api/admin/messages', { headers: A })).j.total, 0)
})

test('机器状态：合并上游状态 + 本地占用 + 排队人数', async () => {
  const { call, A } = await makeApp(seedBasic)
  const r = await call('GET', '/api/admin/machines', { headers: A })
  assert.equal(r.j.total, 2)

  const washer = r.j.rows.find((x) => x.id === '1')
  assert.equal(washer.kind, 'washer')
  assert.equal(washer.state, 'occupied')
  assert.equal(washer.remainMin, 20) // 由 leftMin 映射过来
  assert.equal(washer.occupiedBy.userId, 'u_a')
  assert.equal(washer.queueCount, 1)

  // 烘干机靠名字识别，不能因为上游没有 kind 字段就都当成洗衣机
  const dryer = r.j.rows.find((x) => x.id === 'D1')
  assert.equal(dryer.kind, 'dryer')
  assert.equal(dryer.remainMin, 30)
})

test('清占用：同时清掉提醒计数与冷却', async () => {
  const { call, store, A } = await makeApp(async (s) => {
    await seedBasic(s)
    await s.put('urgecount:b1:1', 3)
    await s.put('urge:b1:1', Date.now())
  })
  const r = await call('POST', '/api/admin/machine/1/clear-occupancy', { headers: A })
  assert.equal(r.status, 200)
  assert.equal(await store.get('urgecount:b1:1', null), null)
  assert.equal(await store.get('urge:b1:1', null), null)

  const miss = await call('POST', '/api/admin/machine/1/clear-occupancy', { headers: A })
  assert.equal(miss.status, 404)
})

test('清排队：只清指定机器', async () => {
  const { call, store, A } = await makeApp(seedBasic)
  const r = await call('POST', '/api/admin/machine/1/clear-queue', { headers: A })
  assert.equal(r.j.removed, 1)
  const left = await store.get('queue:b1', [])
  assert.equal(left.length, 1)
  assert.equal(left[0].machineId, '2')
})

test('审计：列表含上报人 ID、照片可取', async () => {
  const { call, A } = await makeApp(seedBasic)
  const r = await call('GET', '/api/admin/urge-audits', { headers: A })
  assert.equal(r.j.total, 1)
  assert.equal(r.j.items[0].requesterId, 'u_b')
  assert.equal(r.j.items[0].occupierId, 'u_a')

  const p = await call('GET', '/api/admin/urge-audit/a1/photo/occ', { headers: A })
  assert.ok(p.j.dataUrl.startsWith('data:image/'))
})

test('审计概览：今日 / 累计 / 热门机器', async () => {
  const { call, A } = await makeApp(seedBasic)
  const s = await call('GET', '/api/admin/audit-summary', { headers: A })
  assert.equal(s.j.auditsTotal, 1)
  assert.equal(s.j.topMachines[0].machineId, '1')
  assert.equal(s.j.messages, 2)
})

test('清理照片：默认 dry-run，apply=1 才真删', async () => {
  const { call, store, A } = await makeApp(async (s) => {
    await s.put('urgeaudit:b1:9:1-aOld', { auditId: 'aOld', at: '2020-01-01T00:00:00Z', machineId: '9' })
    await s.put('urgephoto:aOld:occ', 'data:image/jpeg;base64,QQ==')
  })
  const dry = await call('POST', '/api/admin/purge-audit-photos?days=30', { headers: A })
  assert.equal(dry.j.applied, false)
  assert.equal(dry.j.candidates, 1)
  assert.ok(await store.get('urgephoto:aOld:occ', null))

  const ap = await call('POST', '/api/admin/purge-audit-photos?days=30&apply=1', { headers: A })
  assert.equal(ap.j.applied, true)
  assert.equal(await store.get('urgephoto:aOld:occ', null), null)
})

test('补全资料：dry-run 不写库，apply=1 才写', async () => {
  const { call, store, A } = await makeApp(async (s) => {
    // 没有 dingUserId 的用户应被跳过（不会去调钉钉）
    await s.put('user:u_c', { id: 'u_c', nick: '丙' })
  })
  const r = await call('POST', '/api/admin/backfill-ding-profile', { headers: A })
  assert.equal(r.status, 200)
  assert.equal(r.j.scanned, 1)
  assert.equal(r.j.bound, 0) // 没绑定就不去请求钉钉
  assert.equal(r.j.filled, 0)
})
