// 管理后台安全回归（node:test）
// 三类重点：越权 / 注入 / 信息泄露
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'

const ADMIN = 'good-token'
const SECRET = 's'.repeat(32)

async function makeApp(seed) {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: ADMIN, BUILDING_ID: 'b1', AUTH_SECRET: SECRET },
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

async function seed(store) {
  await store.put('user:u_x', { id: 'u_x', nick: '甲', mobile: '13900001111', dingUserId: 'd_x' })
  await store.put('user:u_y', { id: 'u_y', nick: '乙' })
  await store.put('userByDing:d_x', 'u_x')
  await store.put('occupancy:b1', {
    9: { userId: 'u_x', nick: '甲', endAt: new Date(Date.now() + 6e5).toISOString() },
  })
}

// ---------- 越权 ----------

test('所有管理端点：无口令一律 401', async () => {
  const { call } = await makeApp(seed)
  const paths = [
    '/api/admin/users',
    '/api/admin/messages',
    '/api/admin/machines',
    '/api/admin/urge-audits',
    '/api/admin/audit-summary',
    '/api/admin/user/u_x',
  ]
  for (const p of paths) {
    const r = await call('GET', p)
    assert.equal(r.status, 401, p)
  }
})

test('错口令 / 空口令都 401（空值不能绕过）', async () => {
  const { call } = await makeApp(seed)
  const bad = await call('GET', '/api/admin/users', { headers: { 'x-admin-token': 'wrong' } })
  assert.equal(bad.status, 401)
  const empty = await call('GET', '/api/admin/users', { headers: { 'x-admin-token': '' } })
  assert.equal(empty.status, 401)
})

test('写操作同样要口令', async () => {
  const { call, store } = await makeApp(seed)
  const del = await call('DELETE', '/api/admin/user/u_y')
  assert.equal(del.status, 401)
  // 确认没被删掉
  assert.ok(await store.get('user:u_y', null))

  const occ = await call('POST', '/api/admin/machine/9/clear-occupancy')
  assert.equal(occ.status, 401)
  const occData = await store.get('occupancy:b1', {})
  assert.ok(occData['9'], '占用记录不应被未授权请求清掉')
})

// ---------- 注入 ----------

test('路径参数不能拼进任意 KV key', async () => {
  const { call, A } = await makeApp(seed)
  const vectors = ['..%2F..%2Fuser%3Au_x', 'a%2Fb', 'a%00b', '..', '%2E%2E%2Fuser%3Au_x']
  for (const v of vectors) {
    const r = await call('GET', '/api/admin/user/' + v, { headers: A })
    assert.ok(r.status === 400 || r.status === 404, `${v} -> ${r.status}`)
  }
  // 带冒号的 id（能拼出别的 key）必须拒绝
  const colon = await call('GET', '/api/admin/user/' + encodeURIComponent('user:u_y'), { headers: A })
  assert.equal(colon.status, 400)
})

test('照片接口 kind 白名单，auditId 不允许穿越', async () => {
  const { call, store, A } = await makeApp(seed)
  await store.put('urgephoto:aZ:occ', 'data:image/jpeg;base64,QQ==')

  const good = await call('GET', '/api/admin/urge-audit/aZ/photo/occ', { headers: A })
  assert.equal(good.status, 200)

  for (const bad of ['empty', 'other', 'OCC', 'Occ']) {
    const r = await call('GET', '/api/admin/urge-audit/aZ/photo/' + bad, { headers: A })
    assert.equal(r.status, 400, bad)
  }
  for (const bad of ['../occ', '..%2Focc']) {
    const r = await call('GET', '/api/admin/urge-audit/aZ/photo/' + bad, { headers: A })
    assert.ok(r.status === 400 || r.status === 404, bad)
  }
  const t = await call('GET', '/api/admin/urge-audit/..%2FaZ/photo/occ', { headers: A })
  assert.ok(t.status === 400 || t.status === 404)
})

// ---------- 信息泄露 ----------

test('列表接口不吐明文手机号', async () => {
  const { call, A } = await makeApp(seed)
  const r = await call('GET', '/api/admin/users', { headers: A })
  const u = r.j.items.find((x) => x.id === 'u_x')
  assert.equal(u.mobile, '139****1111')
  assert.ok(!r.text.includes('13900001111'))
})

test('详情默认脱敏，phone=1 才给全号', async () => {
  const { call, A } = await makeApp(seed)
  const d = await call('GET', '/api/admin/user/u_x', { headers: A })
  assert.equal(d.j.user.mobile, '139****1111')
  assert.ok(!d.text.includes('13900001111'))

  const f = await call('GET', '/api/admin/user/u_x?phone=1', { headers: A })
  assert.equal(f.j.user.mobile, '13900001111')
})

test('管理响应里不能出现任何密钥', async () => {
  const { call, A } = await makeApp(seed)
  const paths = ['/api/admin/users', '/api/admin/messages', '/api/admin/machines', '/api/admin/audit-summary']
  for (const p of paths) {
    const r = await call('GET', p, { headers: A })
    assert.ok(!r.text.includes(SECRET), `${p} 泄露 AUTH_SECRET`)
    assert.ok(!r.text.includes(ADMIN), `${p} 泄露 ADMIN_TOKEN`)
  }
})

// ---------- 破坏性操作 ----------

test('清理照片默认 dry-run，不删任何东西', async () => {
  const { call, store, A } = await makeApp(async (s) => {
    await s.put('urgeaudit:b1:9:1-aOld', { auditId: 'aOld', at: '2020-01-01T00:00:00Z', machineId: '9' })
    await s.put('urgephoto:aOld:occ', 'data:image/jpeg;base64,QQ==')
  })
  const d = await call('POST', '/api/admin/purge-audit-photos?days=30', { headers: A })
  assert.equal(d.j.applied, false)
  assert.ok(await store.get('urgephoto:aOld:occ', null))
})

test('删除不存在的资源返回 404，不是静默成功', async () => {
  const { call, A } = await makeApp(seed)
  const u = await call('DELETE', '/api/admin/user/not_exist', { headers: A })
  assert.equal(u.status, 404)
  const m = await call('DELETE', '/api/admin/message/not_exist', { headers: A })
  assert.equal(m.status, 404)
})
