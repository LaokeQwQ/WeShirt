import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueTicket, verifyTicket } from '../packages/core/auth.js'

const secret = 'test-auth-ticket-boundary-32chars'
const device = 'a'.repeat(32)
const env = { AUTH_SECRET: secret, ADMIN_TOKEN: 'test-admin-secret', BUILDING_ID: 'b1', DINGTALK_APP_KEY: 'test-app-key', HAIER_MODE: 'mock' }
async function setup() {
  const store = createMemoryStore()
  await store.put('user:u_a', { id: 'u_a', nick: '甲', dormBuilding: 'guiyuan' })
  return { store, app: createApp({ store, env }) }
}
const claimTicket = (patch = {}) => issueTicket({ role: 'login_claim', u: 'u_a', d: device, nonce: crypto.randomUUID(), exp: Date.now() + 60000, ...patch }, secret)
async function claim(app, code, currentDevice = device) {
  const response = await app.request('/api/auth/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device: currentDevice }) })
  return { status: response.status, data: await response.json() }
}

test('login claim binds device, consumes nonce once, and wrong device does not consume it', async () => {
  const { app } = await setup()
  const code = await claimTicket()
  assert.equal((await claim(app, code, 'b'.repeat(32))).status, 400)
  const valid = await claim(app, code)
  assert.equal(valid.status, 200)
  assert.equal(valid.data.user.id, 'u_a')
  assert.ok(valid.data.token)
  assert.equal((await claim(app, code)).status, 400)
})

test('concurrent claims across app instances sharing one store issue exactly one token', async () => {
  const { app, store } = await setup()
  const second = createApp({ store, env })
  const code = await claimTicket()
  const results = await Promise.all([claim(app, code), claim(second, code), claim(app, code), claim(second, code)])
  assert.equal(results.filter((result) => result.status === 200).length, 1)
  assert.equal(results.filter((result) => result.status === 400).length, 3)
})

test('untyped and foreign role signed tickets cannot exchange a user token', async () => {
  const { app } = await setup()
  for (const payload of [{ u: 'u_a' }, { role: 'login_state', u: 'u_a', d: device }, { role: 'admin', u: 'u_a' }, { type: 'assistant_skill', u: 'u_a' }, { type: 'social-invite', u: 'u_a' }]) {
    const code = await issueTicket({ ...payload, exp: Date.now() + 60000 }, secret)
    assert.equal((await claim(app, code)).status, 400)
  }
})

test('OAuth state has a distinct role and callback rejects login claim or skill tickets before outbound exchange', async () => {
  const { app } = await setup()
  const response = await app.request('/api/dingtalk/login-url?device=' + device)
  const data = await response.json()
  const state = new URL(data.url).searchParams.get('state')
  assert.equal((await verifyTicket(state, secret)).role, 'login_state')
  const tickets = [await claimTicket(), await issueTicket({ type: 'assistant_skill', d: device, exp: Date.now() + 60000 }, secret), await issueTicket({ role: 'login_state', d: 'u_a', exp: Date.now() + 60000 }, secret)]
  for (const ticket of tickets) {
    const result = await app.request('/api/dingtalk/oauth-callback?code=test-code&state=' + encodeURIComponent(ticket))
    assert.equal(result.status, 302)
    assert.match(result.headers.get('location'), /e=state_invalid/)
  }
})

test('login and share tickets cannot authorize admin routes', async () => {
  const { app } = await setup()
  for (const ticket of [await claimTicket(), await issueTicket({ type: 'assistant_skill', exp: Date.now() + 60000 }, secret)]) {
    for (const path of ['/api/admin/users', '/api/admin/session', '/api/admin/assistant']) {
      const response = await app.request(path, { headers: { 'x-admin-token': ticket } })
      assert.equal(response.status, 401)
    }
  }
})
