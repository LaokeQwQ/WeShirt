// 账号池 token 管理：解析、过期识别、KV 覆盖层、后台改 token
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import {
  parseAccountPool,
  normalizeAuth,
  tokenExpiry,
  applyTokenOverrides,
} from '../packages/core/haier.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'test-admin-token'

// 造一个指定过期时间的 JWT（只签名部分乱填也行，我们只读 payload）
function makeJwt(expSec, extra = {}) {
  const payload = Buffer.from(JSON.stringify({ exp: expSec, ...extra })).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
}

async function makeApp(env = {}, seed) {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: ADMIN, BUILDING_ID: 'b1', AUTH_SECRET: SECRET, HAIER_MODE: 'mock', ...env },
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

// ---------- 解析 / 归一化 ----------

test('带 label 的账号对象', () => {
  const pool = parseAccountPool({
    HAIER_ACCOUNTS: JSON.stringify([{ token: 'abc.def.ghi', label: '我' }, { token: 'x', label: '室友' }]),
  })
  assert.equal(pool.length, 2)
  assert.equal(pool[0].label, '我')
  assert.equal(pool[0].headers.Authorization, 'Bearer abc.def.ghi')
})

test('裸 JWT 自动补 Bearer；已有 Bearer 不重复加', () => {
  const jwt = makeJwt(2000000000)
  assert.equal(normalizeAuth(jwt), 'Bearer ' + jwt)
  assert.equal(normalizeAuth('Bearer ' + jwt), 'Bearer ' + jwt)
  assert.equal(normalizeAuth('bearer ' + jwt), 'bearer ' + jwt)
})

test('自定义 scheme / 普通字符串原样保留', () => {
  assert.equal(normalizeAuth('Basic abc'), 'Basic abc')
  assert.equal(normalizeAuth('tokenA'), 'tokenA')
})

// ---------- 过期识别 ----------

test('能从 JWT 读出过期时间', () => {
  const exp = 1795008180
  const at = tokenExpiry({ Authorization: 'Bearer ' + makeJwt(exp) })
  assert.equal(at, exp * 1000)
})

test('读不到的返回 null，不抛错', () => {
  assert.equal(tokenExpiry({ Authorization: 'Bearer not-a-jwt' }), null)
  assert.equal(tokenExpiry({}), null)
  assert.equal(tokenExpiry(null), null)
})

// ---------- KV 覆盖 ----------

test('覆盖层按下标替换 token，保留 label', () => {
  const pool = parseAccountPool({ HAIER_ACCOUNTS: JSON.stringify([{ token: 'a', label: '我' }, { token: 'b' }]) })
  const out = applyTokenOverrides(pool, { 0: { token: makeJwt(2000000000) } })
  assert.match(out[0].headers.Authorization, new RegExp('^Bearer eyJ'))
  assert.equal(out[0].label, '我')
  assert.equal(out[1].headers.Authorization, 'b', '没覆盖的那个不动')
})

test('覆盖层是空值时不动原池', () => {
  const pool = parseAccountPool({ HAIER_HEADERS: '{"Authorization":"Bearer x"}' })
  assert.deepEqual(applyTokenOverrides(pool, null), pool)
})

// ---------- 后台接口 ----------

test('GET /api/admin/accounts 只返回剩余天数，不返回 token', async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 5
  const { call, A } = await makeApp({
    HAIER_ACCOUNTS: JSON.stringify([{ token: makeJwt(exp), label: '我' }]),
  })
  const r = await call('GET', '/api/admin/accounts', { headers: A })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.size, 1)
  assert.equal(r.j.accounts[0].label, '我')
  assert.ok(r.j.accounts[0].daysLeft >= 4 && r.j.accounts[0].daysLeft <= 5)
  assert.equal(r.j.accounts[0].source, 'env')
  assert.ok(!r.text.includes('eyJ'), '不能把 token 回传出去')
})

test('PUT /api/admin/accounts 换 token 后立即生效（source 变 kv）', async () => {
  const oldExp = Math.floor(Date.now() / 1000) + 86400
  const newExp = Math.floor(Date.now() / 1000) + 86400 * 10
  const { call, A } = await makeApp({
    HAIER_ACCOUNTS: JSON.stringify([{ token: makeJwt(oldExp) }]),
  })
  const r = await call('PUT', '/api/admin/accounts', {
    headers: A,
    body: { index: 1, token: makeJwt(newExp), label: '新号' },
  })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.accounts[0].source, 'kv')
  assert.equal(r.j.accounts[0].label, '新号')
  assert.ok(r.j.accounts[0].daysLeft >= 9)
})

test('PUT 拒绝过期 token', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["a"]' })
  const r = await call('PUT', '/api/admin/accounts', {
    headers: A,
    body: { index: 1, token: makeJwt(Math.floor(Date.now() / 1000) - 3600) },
  })
  assert.equal(r.status, 400)
  assert.match(r.j.error.message, /过期/)
})

test('PUT 拒绝太短的 token（防止粘半截）', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["a"]' })
  const r = await call('PUT', '/api/admin/accounts', { headers: A, body: { index: 1, token: 'short' } })
  assert.equal(r.status, 400)
})

test('PUT 序号越界被拒', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["a"]' })
  const r = await call('PUT', '/api/admin/accounts', { headers: A, body: { index: 5, token: makeJwt(2000000000) } })
  assert.equal(r.status, 400)
})

test('DELETE 覆盖层后回到环境变量基线', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: JSON.stringify([{ token: makeJwt(2000000000) }]) })
  await call('PUT', '/api/admin/accounts', {
    headers: A,
    body: { index: 1, token: makeJwt(2000000000 + 86400), label: '临时' },
  })
  let r = await call('GET', '/api/admin/accounts', { headers: A })
  assert.equal(r.j.accounts[0].source, 'kv')

  r = await call('DELETE', '/api/admin/accounts?index=1', { headers: A })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.accounts[0].source, 'env')
})

test('账号接口需要管理员口令', async () => {
  const { call } = await makeApp({ HAIER_ACCOUNTS: '["a"]' })
  assert.equal((await call('GET', '/api/admin/accounts')).status, 401)
  assert.equal((await call('PUT', '/api/admin/accounts', { body: { index: 1, token: 'x'.repeat(30) } })).status, 401)
})
