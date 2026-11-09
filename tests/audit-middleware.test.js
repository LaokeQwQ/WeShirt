import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerAuditMiddleware } from '../server/audit-middleware.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken, verifyToken, issueAdminSession, verifyAdminSession } from '../packages/core/auth.js'
import { logEvent, listEvents, bjDate } from '../packages/core/auditlog.js'
import { registerRequestSafety } from '../server/request-safety.js'

const SECRET = 'audit-real-jwt-secret-at-least-thirty-two'
const BOOTSTRAP = 'audit-bootstrap-private-secret'
async function fixture(t, suppliedStore) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in audit regression') })
  const store = suppliedStore || createMemoryStore(), app = new Hono()
  await store.put('user:real', { id: 'real', nick: '真实昵称', provider: 'dingtalk' })
  const token = await issueToken('real', SECRET)
  let sequence = 0
  app.use('/api/*', async (c, next) => { c.set('eventId', 'evt_' + String(++sequence).padStart(8, '0')); await next() })
  const authenticate = async (c) => {
    const bearer = (c.req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)
    const uid = bearer && await verifyToken(bearer[1], SECRET).catch(() => null)
    return uid ? store.get('user:' + uid, null) : null
  }
  const checkSuperAdmin = async (c) => c.req.header('x-admin-token') === BOOTSTRAP || Boolean(await verifyAdminSession(c.req.header('x-admin-token'), SECRET).catch(() => null))
  registerAuditMiddleware(app, { store, env: { AUTH_SECRET: SECRET }, authenticate, checkSuperAdmin })
  app.onError((_error, c) => c.json({ error: { code: 'internal', eventId: c.get('eventId') } }, 500))
  const call = async (path, { method = 'GET', body, user = true, bootstrap = false, adminSession, headers: extra = {} } = {}) => {
    const headers = { 'content-type': 'application/json', ...extra }
    if (user) headers.authorization = 'Bearer ' + token
    if (bootstrap || adminSession) headers['x-admin-token'] = adminSession || BOOTSTRAP
    return app.request('https://laundry.example' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  const operations = async () => (await listEvents(store, { days: 1, type: 'operation', limit: 500 })).events
  return { app, store, call, operations, token }
}

test('all business write methods record verified actor, route template, status and correlation without reading or storing payloads', async (t) => {
  const { app, call, operations } = await fixture(t)
  const secretBody = { note: 'private-note-DO-NOT-LOG', photoData: 'data:image/png;base64,NEVER_LOG', text: 'private-chat-DO-NOT-LOG', token: 'private-token-DO-NOT-LOG', userId: 'spoof-chief' }
  const routes = [['POST', '/api/tasks'], ['PUT', '/api/messages/:id'], ['PATCH', '/api/user/profile'], ['DELETE', '/api/social/threads/:id/block'], ['POST', '/api/inspections'], ['POST', '/api/mcp']]
  for (const [method, route] of routes) app.on(method, route, async (c) => c.json({ body: await c.req.json() }, method === 'POST' ? 201 : 200))
  for (const [method, route] of routes) {
    const response = await call(route.replace(':id', 'entity-1') + '?token=query-secret-NEVER_LOG', { method, body: secretBody, headers: { 'x-admin-token': 'invalid-secret-NEVER_LOG' } })
    assert.equal(response.status, method === 'POST' ? 201 : 200)
    assert.deepEqual((await response.json()).body, secretBody, 'audit does not consume or alter the body')
  }
  const entries = await operations()
  assert.equal(entries.length, routes.length)
  for (const entry of entries) {
    assert.equal(entry.actorId, 'real')
    assert.equal(entry.actorNick, '真实昵称')
    assert.equal(entry.detail.actorKind, 'user')
    assert.equal(entry.detail.outcome, 'success')
    assert.match(entry.detail.eventId, /^evt_\d{8}$/)
    assert.ok(routes.some(([method, route]) => entry.detail.method === method && entry.detail.route === route))
  }
  const serialized = JSON.stringify(entries)
  for (const secret of [secretBody.note, secretBody.photoData, secretBody.text, secretBody.token, secretBody.userId, 'query-secret-NEVER_LOG', 'invalid-secret-NEVER_LOG']) assert.equal(serialized.includes(secret), false)
})

test('denied writes and thrown handlers still audit final failure status and use the same request eventId', async (t) => {
  const { app, call, operations } = await fixture(t)
  app.use('/api/tasks/*', async (c) => c.json({ error: { code: 'forbidden' } }, 403))
  app.delete('/api/tasks/:id', (c) => c.json({ ok: true }))
  app.post('/api/queue', (c) => c.json({ error: { code: 'unauthorized' } }, 401))
  app.patch('/api/user/profile', (c) => c.json({ error: { code: 'invalid' } }, 422))
  app.post('/api/inspections', () => { throw new Error('private error message with secret-NO-LOG') })
  assert.equal((await call('/api/tasks/task-1', { method: 'DELETE' })).status, 403)
  assert.equal((await call('/api/queue', { method: 'POST', user: false })).status, 401)
  assert.equal((await call('/api/user/profile', { method: 'PATCH' })).status, 422)
  const thrown = await call('/api/inspections', { method: 'POST' })
  assert.equal(thrown.status, 500)
  const eventId = (await thrown.json()).error.eventId
  const entries = await operations()
  assert.deepEqual(entries.map((entry) => entry.detail.status).sort(), [401, 403, 422, 500])
  assert.equal(entries.every((entry) => entry.detail.outcome === 'failure'), true)
  assert.equal(entries.find((entry) => entry.detail.status === 500).detail.eventId, eventId)
  assert.equal(entries.find((entry) => entry.detail.status === 403).detail.route, '/api/tasks/:id', 'permission denial still uses the matched handler template')
  assert.equal(entries.find((entry) => entry.detail.status === 401).detail.actorKind, 'anonymous')
  assert.equal(JSON.stringify(entries).includes('secret-NO-LOG'), false)
})

test('sensitive administrator reads, photo access and exports audit while public/private polling, audit list and telemetry do not', async (t) => {
  const { app, call, operations } = await fixture(t)
  const sensitive = ['/api/admin/user/:id', '/api/admin/users', '/api/admin/site', '/api/admin/accounts', '/api/admin/audit-logs.csv', '/api/moderation/mutes', '/api/inspections/:id/photo', '/api/upstream-info', '/api/debug/storage']
  const quiet = ['/api/machines', '/api/occupancy', '/api/queue', '/api/social', '/api/queue/notices', '/api/inspections', '/api/user/identity', '/api/admin/status', '/api/admin/operations', '/api/admin/machines', '/api/admin/audit-logs']
  for (const route of [...sensitive, ...quiet]) app.get(route, (c) => c.json({ ok: true }))
  app.post('/api/telemetry', (c) => c.json({ accepted: 1 }, 202))
  for (const route of quiet) await call(route)
  await call('/api/telemetry', { method: 'POST', body: { events: [{ text: 'never-read' }] } })
  assert.equal((await operations()).length, 0)
  for (const route of sensitive) await call(route.replace(':id', 'entity-2'), { user: false, bootstrap: true })
  const entries = await operations()
  assert.equal(entries.length, sensitive.length)
  assert.equal(entries.every((entry) => entry.actorId === 'bootstrap' && entry.detail.actorKind === 'bootstrap'), true)
  assert.equal(JSON.stringify(entries).includes(BOOTSTRAP), false)
  await call('/api/admin/audit-logs.csv', { method: 'HEAD', user: false, bootstrap: true })
  assert.equal((await operations()).find((entry) => entry.detail.method === 'HEAD').detail.route, '/api/admin/audit-logs.csv')
})

test('unknown/malformed paths and credential-like dynamic fragments are redacted; invite tickets never enter audit', async (t) => {
  const { app, call, operations } = await fixture(t)
  app.delete('/api/messages/:id', (c) => c.json({ error: { code: 'not_found' } }, 404))
  app.post('/api/share/:ticket', (c) => c.json({ ok: true }))
  app.get('/api/social/invite', (c) => c.json({ valid: false }))
  const ticket = 'eyJyb2xlIjoiZnJpZW5kIn0.signature_PRIVATE'
  await call('/api/messages/' + ticket + '?access_token=QUERY_PRIVATE', { method: 'DELETE' })
  await call('/api/messages/encoded%2Fseparator_PRIVATE', { method: 'DELETE' })
  await call('/api/share/' + ticket, { method: 'POST' })
  await call('/api/not-registered/' + ticket, { method: 'POST' })
  await call('/api/social/invite?ticket=' + ticket)
  const entries = await operations()
  assert.equal(entries.length, 4)
  assert.equal(entries.filter((entry) => entry.detail.route === '/api/messages/:id').every((entry) => entry.target === '[redacted]'), true)
  assert.ok(entries.some((entry) => entry.detail.route === '/api/:unmatched' && !entry.target))
  assert.ok(entries.some((entry) => entry.detail.route === '/api/share/:ticket' && !entry.target))
  for (const secret of [ticket, 'QUERY_PRIVATE', 'separator_PRIVATE']) assert.equal(JSON.stringify(entries).includes(secret), false)
})

test('actor snapshot survives logout, authentic bootstrap sessions are distinguished, and stale/forged users cannot impersonate actors', async (t) => {
  const { app, store, call, operations } = await fixture(t)
  app.post('/api/auth/logout', async (c) => { await store.del('user:real'); return c.json({ ok: true }) })
  app.patch('/api/user/profile', (c) => c.json({ ok: true }))
  const session = await issueAdminSession(SECRET)
  await call('/api/user/profile', { method: 'PATCH', adminSession: session })
  await call('/api/auth/logout', { method: 'POST' })
  await call('/api/user/profile', { method: 'PATCH' })
  await call('/api/user/profile', { method: 'PATCH', user: false, headers: { authorization: 'Bearer forged.private.signature', 'x-user-id': 'real' } })
  const entries = await operations()
  assert.ok(entries.some((entry) => entry.actorId === 'real' && entry.detail.actorKind === 'bootstrap'))
  assert.equal(entries.find((entry) => entry.detail.route === '/api/auth/logout').actorId, 'real')
  assert.equal(entries.filter((entry) => entry.detail.actorKind === 'anonymous').length, 2)
})

test('concurrent operation and error events do not overwrite each other in a copying store and the daily ring remains bounded', async () => {
  const inner = createMemoryStore()
  const store = {
    async get(key, fallback) { const value = structuredClone(await inner.get(key, fallback)); await new Promise((resolve) => setImmediate(resolve)); return value },
    async put(key, value) { await new Promise((resolve) => setImmediate(resolve)); return inner.put(key, structuredClone(value)) },
    del: (key) => inner.del(key), list: (prefix) => inner.list(prefix),
  }
  const writes = Array.from({ length: 100 }, (_, i) => logEvent(store, { type: i % 2 ? 'operation' : 'error', action: 'concurrent-' + i }))
  assert.equal((await Promise.all(writes)).every(Boolean), true)
  let entries = await inner.get('auditlog:' + bjDate())
  assert.equal(entries.length, 100)
  assert.equal(new Set(entries.map((entry) => entry.action)).size, 100)
  await Promise.all(Array.from({ length: 550 }, (_, i) => logEvent(store, { type: 'operation', action: 'bounded-' + i })))
  entries = await inner.get('auditlog:' + bjDate())
  assert.equal(entries.length, 500)
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 500)
  assert.equal(entries.some((entry) => entry.action === 'bounded-549'), true)
})

test('retention lazily removes at most three expired day buckets per day, preserves current data, and survives a fresh store wrapper', async (t) => {
  const store = createMemoryStore(), realNow = Date.now()
  let clock = realNow, removed = 0
  t.mock.method(Date, 'now', () => clock)
  const originalDelete = store.del
  store.del = async (key) => { removed++; return originalDelete(key) }
  for (let i = 0; i < 8; i++) await store.put('auditlog:' + bjDate(realNow - (40 + i) * 86400000), [{ id: 'old-' + i }])
  await store.put('auditlog:not-a-day', [{ id: 'unrelated-key' }])
  await logEvent(store, { type: 'operation', action: 'first' })
  assert.equal(removed, 3)
  assert.equal((await store.get('auditlog:' + bjDate(realNow))).at(-1).action, 'first')
  await logEvent(store, { type: 'operation', action: 'second' })
  assert.equal(removed, 3)
  const freshWrapper = { get: (...args) => store.get(...args), put: (...args) => store.put(...args), del: (...args) => store.del(...args), list: (...args) => store.list(...args) }
  await logEvent(freshWrapper, { type: 'operation', action: 'cold-restart' })
  assert.equal(removed, 3, 'persistent cleanup marker prevents repeat work on cold start')
  clock += 86400001
  await logEvent(store, { type: 'operation', action: 'next-day' })
  assert.equal(removed, 6)
  assert.ok(await store.get('auditlog:not-a-day'))
})

test('audit storage failure does not change successful business response and middleware works without a preceding eventId provider', async (t) => {
  const app = new Hono(), store = createMemoryStore()
  t.mock.method(store, 'put', async () => { throw new Error('audit storage unavailable with private credentials') })
  registerAuditMiddleware(app, { store, authenticate: () => null, checkSuperAdmin: () => false })
  app.post('/api/messages', (c) => c.json({ ok: true }, 201))
  assert.equal((await app.request('/api/messages', { method: 'POST' })).status, 201)
  const working = createMemoryStore(), fallbackApp = new Hono()
  registerAuditMiddleware(fallbackApp, { store: working })
  fallbackApp.post('/api/messages', (c) => c.json({ ok: true }))
  await fallbackApp.request('/api/messages', { method: 'POST' })
  assert.match((await listEvents(working, { type: 'operation' })).events[0].detail.eventId, /^[0-9a-f-]{36}$/)
})

test('outer audit middleware records idempotent replay and conflicts once each with request-safety event IDs and actual statuses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden') })
  const app = new Hono(), store = createMemoryStore()
  await store.put('user:real', { id: 'real', nick: '真实操作者' })
  const authenticate = () => store.get('user:real', null)
  registerAuditMiddleware(app, { store, authenticate, checkSuperAdmin: () => false })
  registerRequestSafety(app, { store, authenticate })
  let mutations = 0
  app.post('/api/messages', async (c) => { await c.req.json(); mutations++; return c.json({ ok: true }, 201) })
  const request = (text) => app.request('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'audit-replay-key' }, body: JSON.stringify({ text }) })
  const original = await request('private-text')
  const replayed = await request('private-text')
  const conflict = await request('changed-private-text')
  assert.equal(original.status, 201)
  assert.equal(replayed.status, 201)
  assert.equal(replayed.headers.get('Idempotency-Replayed'), 'true')
  assert.equal(conflict.status, 409)
  assert.equal(mutations, 1)
  const entries = (await listEvents(store, { type: 'operation' })).events
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map((entry) => entry.detail.status).sort(), [201, 201, 409])
  assert.equal(entries.filter((entry) => entry.detail.replayed === true).length, 1)
  assert.deepEqual(new Set(entries.map((entry) => entry.detail.eventId)), new Set([original, replayed, conflict].map((response) => response.headers.get('X-Event-ID'))))
  assert.equal((await listEvents(store, { type: 'error' })).events.length, 1, 'request-safety alone writes the error event, audit adds operation metadata')
  assert.equal(JSON.stringify(await store.list('auditlog:')).includes('private-text'), false)
})
