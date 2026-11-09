// 后台会话：口令换 12 小时票据，过期/伪造一律拒
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueAdminSession, issueTicket } from '../packages/core/auth.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'test-admin-token'

async function makeApp(env = {}) {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: ADMIN, BUILDING_ID: 'b1', AUTH_SECRET: SECRET, ...env } })
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
  return { store, call }
}

test('口令正确会换到一张有有效期的会话票据', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/admin/login', { body: { token: ADMIN } })
  assert.equal(r.status, 200, r.text)
  assert.ok(r.j.session)
  const left = r.j.expAt - Date.now()
  assert.ok(left > 11 * 3600 * 1000 && left <= 12 * 3600 * 1000, '默认 12 小时')
  assert.ok(!r.text.includes(ADMIN), '响应里不能回显口令')
})

test('口令错误返回 401', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/admin/login', { body: { token: 'wrong-password' } })
  assert.equal(r.status, 401)
})

test('会话票据能访问管理接口', async () => {
  const { call } = await makeApp()
  const { j } = await call('POST', '/api/admin/login', { body: { token: ADMIN } })
  const r = await call('GET', '/api/admin/status?token=' + encodeURIComponent(j.session))
  assert.equal(r.status, 200, r.text)
})

test('会话接口能报告剩余有效期', async () => {
  const { call } = await makeApp()
  const { j } = await call('POST', '/api/admin/login', { body: { token: ADMIN } })
  const r = await call('GET', '/api/admin/session', { headers: { 'x-admin-token': j.session } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.j.kind, 'session')
  assert.ok(r.j.ttlMs > 0)
})

test('伪造/篡改的票据被拒', async () => {
  const { call } = await makeApp()
  const { j } = await call('POST', '/api/admin/login', { body: { token: ADMIN } })
  const tampered = j.session.slice(0, -3) + 'abc'
  const r = await call('GET', '/api/admin/status', { headers: { 'x-admin-token': tampered } })
  assert.equal(r.status, 403)
})

test('过期票据被拒（exp 已过）', async () => {
  const { call } = await makeApp()
  // 直接签一张已过期的票据：issueAdminSession 不接受负数 ttl，所以手搓
  const expired = await issueTicket({ role: 'admin', exp: Date.now() - 1000 }, SECRET)
  const r = await call('GET', '/api/admin/status', { headers: { 'x-admin-token': expired } })
  assert.equal(r.status, 403)
})

test('原始口令仍然可用（脚本/自检不受影响）', async () => {
  const { call } = await makeApp()
  const r = await call('GET', '/api/admin/status', { headers: { 'x-admin-token': ADMIN } })
  assert.equal(r.status, 200)
})

test('用 AUTH_SECRET 以外签的票据无效', async () => {
  const { call } = await makeApp()
  const forged = await issueAdminSession('x'.repeat(32))
  const r = await call('GET', '/api/admin/status', { headers: { 'x-admin-token': forged } })
  assert.equal(r.status, 403)
})

test('没配 AUTH_SECRET 时登录直接 503，不签发明文口令票据', async () => {
  const { call } = await makeApp({ AUTH_SECRET: '' })
  const r = await call('POST', '/api/admin/login', { body: { token: ADMIN } })
  assert.equal(r.status, 503)
})
