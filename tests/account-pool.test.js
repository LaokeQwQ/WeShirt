// 账号池轮询：多账号分摊上游请求，某个被限流自动切下一个
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { parseAccountPool } from '../packages/core/haier.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'test-admin-token'

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

// ---------- 解析 ----------

test('字符串数组：每个元素当作 Authorization', () => {
  const pool = parseAccountPool({ HAIER_ACCOUNTS: '["tokenA","tokenB"]' })
  assert.equal(pool.length, 2)
  assert.equal(pool[0].headers.Authorization, 'tokenA')
  assert.equal(pool[1].headers['content-type'], 'application/json')
})

test('对象数组：支持完整请求头（Authorization + Cookie 等）', () => {
  const pool = parseAccountPool({
    HAIER_ACCOUNTS: '[{"Authorization":"Bearer a","Cookie":"sid=1"},{"Authorization":"Bearer b"}]',
  })
  assert.equal(pool.length, 2)
  assert.equal(pool[0].headers.Cookie, 'sid=1')
  assert.equal(pool[1].headers.Authorization, 'Bearer b')
})

test('没配账号池时退回单账号（老配置照常工作）', () => {
  const pool = parseAccountPool({ HAIER_HEADERS: '{"Authorization":"Bearer old"}' })
  assert.equal(pool.length, 1)
  assert.equal(pool[0].headers.Authorization, 'Bearer old')
})

test('账号池是坏 JSON 时不炸，退回单账号', () => {
  const pool = parseAccountPool({ HAIER_ACCOUNTS: 'not-json', HAIER_HEADERS: '{"Authorization":"x"}' })
  assert.equal(pool.length, 1)
  assert.equal(pool[0].headers.Authorization, 'x')
})

test('空数组也退回单账号，不会出现 0 个账号', () => {
  const pool = parseAccountPool({ HAIER_ACCOUNTS: '[]' })
  assert.equal(pool.length, 1)
})

// ---------- 轮询 ----------

test('两次同步会轮流用不同账号', async () => {
  const { store, call, A } = await makeApp({ HAIER_ACCOUNTS: '["a","b"]' })
  const r1 = await call('POST', '/api/cron/sync', { headers: A })
  assert.equal(r1.j.account, 1)
  let st = await store.get('meta:haierPool', null)
  assert.equal(st.idx, 1)

  const r2 = await call('POST', '/api/cron/sync', { headers: A })
  assert.equal(r2.j.account, 2)
  st = await store.get('meta:haierPool', null)
  assert.equal(st.idx, 0, '两个账号应循环回到第一个')
})

test('账号在冷却里会被跳过', async () => {
  const { call, A } = await makeApp(
    { HAIER_ACCOUNTS: '["a","b"]' },
    async (s) => {
      await s.put('meta:haierPool', { idx: 0, cool: { 0: Date.now() + 300000 } })
    }
  )
  const r = await call('POST', '/api/cron/sync', { headers: A })
  assert.equal(r.j.account, 2, '第 1 个在冷却，应该用第 2 个')
})

test('全部账号都在冷却时仍然会挑最早解冻的试，不会停摆', async () => {
  const now = Date.now()
  const { call, A } = await makeApp(
    { HAIER_ACCOUNTS: '["a","b"]' },
    async (s) => {
      // 0 号 10 分钟后解冻，1 号 1 分钟后解冻 → 应挑 1 号
      await s.put('meta:haierPool', { idx: 0, cool: { 0: now + 600000, 1: now + 60000 } })
    }
  )
  const r = await call('POST', '/api/cron/sync', { headers: A })
  assert.equal(r.j.account, 2)
})

// 本地起一个「永远 405」的上游，用来模拟账号被限流（比连不上更贴近真实）
async function with405(fn) {
  const http = await import('node:http')
  const srv = http.createServer((req, res) => {
    res.statusCode = 405
    res.end('method not allowed')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

test(
  '上游 405 时把该账号冷却，并切到下一个',
  async () => {
    await with405(async (url) => {
      const { store, call, A } = await makeApp(
        {
          HAIER_ACCOUNTS: '["a","b"]',
          HAIER_MODE: 'real',
          HAIER_URL: url,
          HAIER_POSITION_ID: '90001',
          HAIER_TIMEOUT_MS: '1500',
        },
        async (s) => {
          await s.put('meta:haierPool', { idx: 0, cool: {} })
        }
      )
      const r = await call('POST', '/api/cron/sync', { headers: A })
      assert.match(r.j.error, /405/, `应该报 405，实际：${r.j.error}`)
      const st = await store.get('meta:haierPool', null)
      assert.ok(st.cool['0'] > Date.now(), '0 号应进入冷却')
      assert.equal(st.idx, 1, '下标应切到 1 号')
    })
  },
  { timeout: 30000 }
)

test(
  '只有一个账号时不会自己把自己冷却掉（否则永远不恢复）',
  async () => {
    await with405(async (url) => {
      const { store, call, A } = await makeApp({
        HAIER_MODE: 'real',
        HAIER_URL: url,
        HAIER_POSITION_ID: '90001',
        HAIER_TIMEOUT_MS: '1500',
      })
      await call('POST', '/api/cron/sync', { headers: A })
      const st = await store.get('meta:haierPool', null)
      assert.equal(st, null, '单账号不该写冷却状态')
    })
  },
  { timeout: 30000 }
)

// ---------- 排障接口 ----------

test('diag-haier?account=2 用指定账号探测，且不泄露 token', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["secret-a","secret-b"]' })
  const r = await call('GET', '/api/admin/diag-haier?account=2', { headers: A })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.account, 2)
  assert.equal(r.j.pool.size, 2)
  assert.ok(!r.text.includes('secret-a'), '不能把账号凭证写进响应')
  assert.ok(!r.text.includes('secret-b'))
})

test('diag-haier 的账号序号越界会被拒', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["a","b"]' })
  const r = await call('GET', '/api/admin/diag-haier?account=9', { headers: A })
  assert.equal(r.status, 400)
})

test('diag-haier 会报告哪些账号在冷却', async () => {
  const { call, A } = await makeApp(
    { HAIER_ACCOUNTS: '["a","b"]' },
    async (s) => {
      await s.put('meta:haierPool', { idx: 1, cool: { 0: Date.now() + 120000 } })
    }
  )
  const r = await call('GET', '/api/admin/diag-haier', { headers: A })
  assert.equal(r.j.pool.current, 2)
  assert.equal(r.j.pool.cooling.length, 1)
  assert.equal(r.j.pool.cooling[0].account, 1)
})
