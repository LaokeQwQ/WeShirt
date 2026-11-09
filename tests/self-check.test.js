// 自检：把「系统是否正常」变成结论，有问题私信管理员
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSelfCheck } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'

const SECRET = 's'.repeat(32)

async function makeApp(env = {}) {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET, ...env } })
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
  return { store, call, A: { 'x-admin-token': 'test-admin-token' } }
}

test('看板为空时自检能报出来', async () => {
  const { store } = await makeApp()
  const r = await runSelfCheck({ BUILDING_ID: 'b1', AUTH_SECRET: SECRET }, store)
  const kinds = r.issues.map((i) => i.kind)
  assert.ok(kinds.includes('board_empty'))
})

test('同步长时间没成功会被报出来', async () => {
  const { store } = await makeApp()
  await store.put('machines:b1', {
    board: { total: 3, floors: [] },
    rawUpdatedAt: new Date().toISOString(),
  })
  await store.put('meta:sync', {
    lastFetchAt: new Date(Date.now() - 40 * 60000).toISOString(),
    lastAttemptAt: Date.now(),
    failCount: 0,
  })
  const r = await runSelfCheck({ BUILDING_ID: 'b1', AUTH_SECRET: SECRET, DINGTALK_WEBHOOK: 'https://x' }, store)
  assert.ok(r.issues.some((i) => i.kind === 'sync_stale'))
})

test('连续失败 3 次会报出来', async () => {
  const { store } = await makeApp()
  await store.put('machines:b1', { board: { total: 3, floors: [] } })
  await store.put('meta:sync', {
    lastFetchAt: new Date().toISOString(),
    lastAttemptAt: Date.now(),
    failCount: 4,
    lastError: 'HAIER HTTP 405',
  })
  const r = await runSelfCheck({ BUILDING_ID: 'b1', AUTH_SECRET: SECRET, DINGTALK_WEBHOOK: 'https://x' }, store)
  assert.ok(r.issues.some((i) => i.kind === 'sync_fail'))
})

test('没配管理员钉钉时不发消息（但问题照样列出来）', async () => {
  const { store } = await makeApp()
  const r = await runSelfCheck({ BUILDING_ID: 'b1', AUTH_SECRET: SECRET }, store)
  assert.equal(r.sent.length, 0)
})

test('手动自检接口要口令', async () => {
  const { call } = await makeApp()
  assert.equal((await call('POST', '/api/admin/self-check')).status, 403)
  const ok = await call('POST', '/api/admin/self-check', { headers: { 'x-admin-token': 'test-admin-token' } })
  assert.equal(ok.status, 200, ok.text)
  assert.ok(Array.isArray(ok.j.issues))
})
