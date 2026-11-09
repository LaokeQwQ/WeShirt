// 同步心跳：提醒不能依赖「有人打开页面」
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken, deriveSyncKey } from '../packages/core/auth.js'

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

test('deriveSyncKey：稳定、可复现、不等于密钥本身', async () => {
  const a = await deriveSyncKey(SECRET)
  const b = await deriveSyncKey(SECRET)
  assert.equal(a, b)
  assert.equal(a.length, 24)
  assert.notEqual(a, SECRET)
  assert.notEqual(a, await deriveSyncKey('s'.repeat(31) + 'x'))
})

test('deriveSyncKey：密钥缺失/太短返回空串（不能退化成固定值）', async () => {
  assert.equal(await deriveSyncKey(''), '')
  assert.equal(await deriveSyncKey('short'), '')
  assert.equal(await deriveSyncKey(null), '')
})

test('/api/cron/sync 接受同步密钥（不需要管理员口令）', async () => {
  const { call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  const r = await call('POST', `/api/cron/sync?k=${k}`)
  // 测试环境没有上游，runSync 会返回 error 字段，但**鉴权必须通过**（不是 403）
  assert.notEqual(r.status, 403, r.text)
})

test('/api/cron/sync 错误密钥仍然拒绝', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/cron/sync?k=' + 'a'.repeat(24))
  assert.equal(r.status, 403)
})

test('/api/cron/sync 无凭据拒绝', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/cron/sync')
  assert.equal(r.status, 403)
})

test('管理员口令仍然可以触发同步', async () => {
  const { call, A } = await makeApp()
  const r = await call('POST', '/api/cron/sync', { headers: A })
  assert.notEqual(r.status, 403)
})

test('缺 AUTH_SECRET 时同步密钥为空，走 k 的请求被拒', async () => {
  const { call } = await makeApp({ AUTH_SECRET: '' })
  const r = await call('POST', '/api/cron/sync?k=' + 'a'.repeat(24))
  assert.equal(r.status, 403)
})

test('/api/cron/sync 也认 POST body 里的 k（给 edgeone.json schedules 用）', async () => {
  const { call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  const r = await call('POST', '/api/cron/sync', { body: { k } })
  assert.notEqual(r.status, 403, r.text)
})

test('/api/cron/sync body 里的错误 k 仍然拒绝', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/cron/sync', { body: { k: 'a'.repeat(24) } })
  assert.equal(r.status, 403)
})

test('/api/cron/sync 空 body 不报错，只是拒绝', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/cron/sync', { body: {} })
  assert.equal(r.status, 403)
})

test('edgeone.json 不再声明 schedules（平台不触发，别放密钥进去）', async () => {
  const fs = await import('node:fs')
  const cfg = JSON.parse(fs.readFileSync(new URL('../edgeone.json', import.meta.url), 'utf8'))
  // 实测 EdgeOne 的 schedules 校验通过但线上不触发，改用 CloudBase 定时触发器；
  // 这里锁住「别再把同步密钥写回 edgeone.json」。
  assert.equal(cfg.schedules, undefined, 'edgeone.json 不该再配置 schedules')
})
test('/api/admin/sync-url 返回可直接填进定时器的地址', async () => {
  const { call, A } = await makeApp()
  const r = await call('GET', '/api/admin/sync-url', { headers: A })
  assert.equal(r.status, 200, r.text)
  assert.match(r.j.url, /\/api\/cron\/sync\?k=[0-9a-f]{24}$/)
  assert.equal(r.j.every, '5 分钟')
})

test('/api/admin/sync-url 需要管理员口令', async () => {
  const { call } = await makeApp()
  const r = await call('GET', '/api/admin/sync-url')
  assert.equal(r.status, 401)
})

test('sync-url 里的密钥确实能触发同步', async () => {
  const { call, A } = await makeApp()
  const got = await call('GET', '/api/admin/sync-url', { headers: A })
  const path = got.j.url.replace(/^http:\/\/x/, '')
  const r = await call('POST', path)
  assert.notEqual(r.status, 403)
})

test('打开「我的洗衣」不会因为顺手同步而变慢或报错', async () => {
  const { call } = await makeApp({}, async (s) => {
    await s.put('user:u_1', { id: 'u_1', nick: '测试', avatar: 'av1', takeCode: '000000' })
  })
  const tok = await issueToken('u_1', SECRET)
  const t0 = Date.now()
  const r = await call('GET', '/api/tasks', { headers: { authorization: 'Bearer ' + tok } })
  const ms = Date.now() - t0
  assert.equal(r.status, 200)
  assert.ok(ms < 3000, `不该被同步拖慢（实际 ${ms}ms）`)
  assert.ok(Array.isArray(r.j.tasks))
})

// ---------- 上游失败冷却（405 时别越刷越被封） ----------

async function seedBoard(s, meta) {
  const old = new Date(Date.now() - 10 * 60000).toISOString()
  await s.put('machines:b1', {
    board: { buildingId: 'b1', buildingName: '测试楼', updatedAt: old, floors: [{ code: '1F', machines: [] }] },
    rawUpdatedAt: old,
  })
  if (meta) await s.put('meta:sync', meta)
}

test('冷却期内不会再去打上游', async () => {
  const coolUntil = Date.now() + 60000
  const { store, call } = await makeApp({}, (s) =>
    seedBoard(s, {
      lastFetchAt: new Date(Date.now() - 600000).toISOString(),
      lastAttemptAt: Date.now() - 5000,
      failCount: 2,
      cooldownUntil: coolUntil,
      lastError: 'HAIER HTTP 405',
    })
  )
  const r = await call('GET', '/api/machines?building=b1')
  assert.equal(r.status, 200)
  const meta = await store.get('meta:sync', null)
  assert.equal(meta.cooldownUntil, coolUntil, '冷却期内不该发起新请求')
  assert.equal(meta.failCount, 2, '失败计数不该变')
})

test('冷却结束后会重新尝试，成功则清零', async () => {
  const { store, call } = await makeApp({}, (s) =>
    seedBoard(s, {
      lastFetchAt: new Date(Date.now() - 600000).toISOString(),
      lastAttemptAt: Date.now() - 120000,
      failCount: 1,
      cooldownUntil: Date.now() - 1000,
      lastError: 'x',
    })
  )
  const r = await call('GET', '/api/machines?building=b1')
  assert.equal(r.status, 200)
  const meta = await store.get('meta:sync', null)
  assert.ok(meta.lastAttemptAt > Date.now() - 30000, '应该发起了一次新尝试')
  assert.equal(meta.failCount, 0, 'mock 上游成功，计数应清零')
})

test('同步失败不推进 lastFetchAt，并进入冷却', async () => {
  const oldFetch = new Date(Date.now() - 3600000).toISOString()
  const { store, call, A } = await makeApp(
    {
      HAIER_MODE: 'real',
      HAIER_URL: 'http://127.0.0.1:9',
      HAIER_HEADERS: '{}',
      HAIER_POSITION_ID: '90001',
      HAIER_TIMEOUT_MS: '400',
    },
    (s) => seedBoard(s, { lastFetchAt: oldFetch, lastAttemptAt: Date.now() - 120000, failCount: 0 })
  )
  await call('POST', '/api/cron/sync', { headers: A })
  const meta = await store.get('meta:sync', null)
  assert.equal(meta.lastFetchAt, oldFetch, '失败不能推进 lastFetchAt')
  assert.ok(meta.failCount >= 1)
  assert.ok(meta.cooldownUntil > Date.now(), '失败后要进入冷却')
})
