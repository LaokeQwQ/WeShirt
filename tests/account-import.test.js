// 批量导入账号 token：一行一个，最灵活（不用重新部署）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { buildPool, parseTokenLines } from '../packages/core/haier.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'test-admin-token'

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

// ---------- 解析 ----------

test('一行一个 token，支持「标签, token」', () => {
  const t1 = makeJwt(2000000000)
  const t2 = makeJwt(2000000001)
  const out = parseTokenLines(`我, ${t1}\n室友 ${t2}\n\n# 注释行\n`)
  assert.equal(out.length, 2)
  assert.equal(out[0].label, '我')
  assert.equal(out[1].label, '室友')
  assert.match(out[0].token, /^Bearer eyJ/)
})

test('纯 token 行也能认，太短的丢掉', () => {
  const out = parseTokenLines(`${makeJwt(2000000000)}\nabc\ndef\n`)
  assert.equal(out.length, 1)
})

test('超过 20 个只取前 20', () => {
  const many = Array.from({ length: 30 }, (_, i) => makeJwt(2000000000 + i)).join('\n')
  assert.equal(parseTokenLines(many).length, 20)
})

// ---------- 池优先级 ----------

test('KV 批量账号优先于环境变量', () => {
  const env = { HAIER_ACCOUNTS: '["env-token"]' }
  const kv = [{ token: 'Bearer a.b.c' }, { token: 'Bearer d.e.f' }]
  const pool = buildPool(env, kv, null)
  assert.equal(pool.length, 2)
  assert.equal(pool[0].headers.Authorization, 'Bearer a.b.c')
})

test('没有 KV 时退回环境变量 + 序号覆盖', () => {
  const env = { HAIER_ACCOUNTS: '["a","b"]' }
  const pool = buildPool(env, null, { 1: { token: makeJwt(2000000000) } })
  assert.equal(pool.length, 2)
  assert.match(pool[1].headers.Authorization, /^Bearer eyJ/)
  assert.equal(pool[0].headers.Authorization, 'a')
})

// ---------- 接口 ----------

test('批量导入 3 个 token 后池子变成 3 个', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["env"]' })
  const text = [
    `我, ${makeJwt(Math.floor(Date.now() / 1000) + 86400 * 10)}`,
    `室友, ${makeJwt(Math.floor(Date.now() / 1000) + 86400 * 20)}`,
    makeJwt(Math.floor(Date.now() / 1000) + 86400 * 30),
  ].join('\n')
  const r = await call('POST', '/api/admin/accounts/import', { headers: A, body: { text } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.imported, 3)
  assert.equal(r.j.size, 3)
  assert.equal(r.j.accounts[0].label, '我')
  assert.equal(r.j.accounts[0].source, 'kv')
  assert.ok(!r.text.includes('eyJ'), '响应里不能有 token')
})

test('导入时跳过过期 token，并在响应里说明', async () => {
  const { call, A } = await makeApp()
  const text = [
    `旧的, ${makeJwt(Math.floor(Date.now() / 1000) - 3600)}`,
    `新的, ${makeJwt(Math.floor(Date.now() / 1000) + 86400)}`,
  ].join('\n')
  const r = await call('POST', '/api/admin/accounts/import', { headers: A, body: { text } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.imported, 1)
  assert.deepEqual(r.j.skipped, ['旧的'])
})

test('全部过期则拒绝导入', async () => {
  const { call, A } = await makeApp()
  const text = makeJwt(Math.floor(Date.now() / 1000) - 3600)
  const r = await call('POST', '/api/admin/accounts/import', { headers: A, body: { text } })
  assert.equal(r.status, 400)
})

test('导入后轮询会在新池子里切换', async () => {
  const { store, call, A } = await makeApp()
  const text = [makeJwt(2000000100), makeJwt(2000000200)].join('\n')
  await call('POST', '/api/admin/accounts/import', { headers: A, body: { text } })

  const r1 = await call('POST', '/api/cron/sync', { headers: A })
  assert.equal(r1.j.account, 1)
  let st = await store.get('meta:haierPool', null)
  assert.equal(st.idx, 1)

  const r2 = await call('POST', '/api/cron/sync', { headers: A })
  assert.equal(r2.j.account, 2)
})

test('删除某个账号后池子变小', async () => {
  const { call, A } = await makeApp()
  const text = [makeJwt(2000000100), makeJwt(2000000200)].join('\n')
  await call('POST', '/api/admin/accounts/import', { headers: A, body: { text } })
  const r = await call('DELETE', '/api/admin/accounts?index=1', { headers: A })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.size, 1)
})

test('导入需要管理员口令', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/admin/accounts/import', { body: { text: 'x' } })
  assert.equal(r.status, 401)
})
