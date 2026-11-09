// 外部抓取回写：CloudBase 用另一个出口 IP 抓完 POST 回来
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { deriveSyncKey } from '../packages/core/auth.js'
import { bjDate } from '../packages/core/auditlog.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'test-admin-token'

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

const RAW = [
  { id: '51074280', name: '桂园1楼7号机', floorCode: '1', state: 1, finishTime: null },
  { id: '51074281', name: '桂园1楼8号机', floorCode: '1', state: 2, finishTime: '2026-10-29T05:30:00Z' },
]

test('回写需要凭据', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/cron/ingest', { body: { raws: RAW } })
  assert.equal(r.status, 403)
})

test('错误的同步密钥被拒', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/cron/ingest', { body: { k: 'a'.repeat(24), raws: RAW } })
  assert.equal(r.status, 403)
})

test('管理员口令也可以回写', async () => {
  const { call, A } = await makeApp()
  const r = await call('POST', '/api/cron/ingest', { body: { raws: RAW }, headers: A })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.ok, true)
})

test('空 raws 被拒', async () => {
  const { call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  const r = await call('POST', `/api/cron/ingest?k=${k}`, { body: { raws: [] } })
  assert.equal(r.status, 400)
})

test('超过 500 条被拒（防止被当成写库管道）', async () => {
  const { call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  const many = Array.from({ length: 501 }, (_, i) => ({ id: String(i), name: 'x', state: 1 }))
  const r = await call('POST', `/api/cron/ingest?k=${k}`, { body: { raws: many } })
  assert.equal(r.status, 400)
})

test('没有一条合法设备时被拒', async () => {
  const { call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  const r = await call('POST', `/api/cron/ingest?k=${k}`, {
    body: { raws: [{ nope: 1 }, { id: '', state: 1 }, { id: 'x', state: 'abc' }] },
  })
  assert.equal(r.status, 400)
})

test('正常回写：看板落地、meta 更新、source 标记为 cloudbase', async () => {
  const { store, call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  const r = await call('POST', `/api/cron/ingest?k=${k}`, { body: { raws: RAW, source: 'cloudbase' } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.source, 'cloudbase')
  assert.equal(r.j.fetched, 2)

  const entry = await store.get('machines:b1', null)
  assert.ok(entry && entry.board, '应该写入看板')
  assert.equal(entry.board.total, 2)

  const meta = await store.get('meta:sync', null)
  assert.ok(meta.lastFetchAt, 'lastFetchAt 要更新')
  assert.equal(meta.failCount, 0)
})

test('多余字段不会进入看板（外部节点不能塞结构）', async () => {
  const { store, call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  await call('POST', `/api/cron/ingest?k=${k}`, {
    body: { raws: [{ ...RAW[0], evil: 'x'.repeat(100), stateText: 'hacked' }] },
  })
  const entry = await store.get('machines:b1', null)
  const m = entry.board.floors[0].machines[0]
  assert.equal(m.evil, undefined)
  assert.equal(m.stateText, undefined)
  assert.equal(m.id, '51074280')
})

test('回写会写审计，方便事后对账', async () => {
  const { store, call } = await makeApp()
  const k = await deriveSyncKey(SECRET)
  await call('POST', `/api/cron/ingest?k=${k}`, { body: { raws: RAW, source: 'cloudbase' } })
  const day = bjDate()
  const logs = await store.get(`auditlog:${day}`, [])
  const hit = (logs || []).find((e) => e.action === '外部抓取回写')
  assert.ok(hit, '应该有外部抓取回写记录')
  assert.equal(hit.detail.count, 2)
})
