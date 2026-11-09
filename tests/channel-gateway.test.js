import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createRequire } from 'node:module'
import { attachRelay, createRelayServer, createStateReader, loadConfig, PROTOCOL, RelayError, ticketDetails } from '../tools/cloudbase-fn/weshirt-channel-gateway/index.mjs'

const require = createRequire(new URL('../tools/cloudbase-fn/weshirt-channel-gateway/package.json', import.meta.url))
const WebSocket = require('ws')
const makeTicket = (extra = {}, now = Date.now()) => `${Buffer.from(JSON.stringify({ role: 'community_ws', uid: 'synthetic-user', channel: 'public', nonce: 'fixture_nonce_01', exp: now + 120000, ...extra })).toString('base64url')}.${'a'.repeat(64)}`
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = []; closing = null
  send(text) { this.sent.push(JSON.parse(text)) }
  close(code, reason) { this.closing = { code, reason }; this.readyState = 3; this.emit('close') }
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
function scheduler() {
  const pending = new Map(); let id = 0
  return {
    pending,
    setTimer(fn, ms) { const key = ++id; pending.set(key, { fn, ms }); return key },
    clearTimer(key) { pending.delete(key) },
    async run(ms) { const entry = [...pending].find(([, value]) => value.ms === ms); assert.ok(entry, `timer ${ms} exists`); pending.delete(entry[0]); await entry[1].fn(); await tick() },
  }
}

test('deployment config rejects private, non HTTPS, credentials and non origins', () => {
  const env = { EDGE_API_ORIGIN: 'https://api.example.com', COMMUNITY_WS_ALLOWED_ORIGINS: 'https://web.example.com,https://another.example.com' }
  assert.equal(loadConfig(env).origins.size, 2)
  for (const origin of ['http://api.example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://10.0.0.1', 'https://a.internal', 'https://user:secret@api.example.com', 'https://api.example.com/path', 'https://api.example.com/?ticket=x']) {
    assert.throws(() => loadConfig({ ...env, EDGE_API_ORIGIN: origin }))
  }
  assert.throws(() => loadConfig({ ...env, COMMUNITY_WS_ALLOWED_ORIGINS: '' }))
})

test('prefilter only accepts bounded role/channel/expiry tickets and does not authenticate them', () => {
  const now = 1000000
  assert.deepEqual(ticketDetails(makeTicket({}, now), now), { channel: 'public', exp: now + 120000 })
  for (const extra of [{ role: 'admin' }, { channel: '../private' }, { exp: now - 1 }, { exp: now + 900000 }, { nonce: '' }]) assert.throws(() => ticketDetails(makeTicket(extra, now), now))
  assert.throws(() => ticketDetails('secret'))
})

test('state reader pins destination/header, disables redirects and strips unknown data', async () => {
  let call
  const read = createStateReader('https://api.example.com', { fetchImpl: async (url, options) => {
    call = { url, options }
    return new Response(JSON.stringify({ channel: 'public', revision: 1, inboxCount: 2, text: 'private body', uid: 'private user' }))
  } })
  assert.deepEqual(await read('opaque', undefined, '1'.repeat(24)), { channel: 'public', revision: 1, inboxCount: 2 })
  assert.equal(call.url, 'https://api.example.com/api/messages/realtime/state')
  assert.equal(call.options.headers.Authorization, 'Bearer opaque')
  assert.equal(call.options.redirect, 'error')
  assert.equal(call.options.cache, 'no-store')
  assert.equal(call.options.headers['X-Community-WS-Connection'], '1'.repeat(24))
  assert.ok(!call.url.includes('opaque'))
})

test('state reader bounds response, rejects malformed fields and classifies ACL/429 safely', async () => {
  for (const body of ['x'.repeat(4097), JSON.stringify({ channel: 'public', revision: 'raw error https://secret.example/?key=s', inboxCount: 0 }), JSON.stringify({ channel: 'public', revision: 1, inboxCount: -1 })]) {
    const read = createStateReader('https://api.example.com', { fetchImpl: async () => new Response(body) })
    await assert.rejects(read('opaque'), error => error.code === 'invalid_state' && !error.message.includes('secret'))
  }
  for (const status of [401, 403]) {
    const read = createStateReader('https://api.example.com', { fetchImpl: async () => new Response('sensitive', { status }) })
    await assert.rejects(read('opaque'), error => error.code === 'access_denied' && error.retry === false)
  }
  const limited = createStateReader('https://api.example.com', { fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '900' } }) })
  await assert.rejects(limited('opaque'), error => error.code === 'rate_limited' && error.waitMs === 20000)
})

test('unauthenticated connections expire without a backend read; invalid signatures never ready', async () => {
  const timers = scheduler(), socket = new Socket(); let calls = 0
  attachRelay(socket, async () => { calls++; throw new RelayError('access_denied') }, timers)
  await timers.run(5000)
  assert.equal(socket.closing.code, 4401); assert.equal(calls, 0); assert.equal(timers.pending.size, 0)
  const denied = new Socket()
  attachRelay(denied, async () => { throw new RelayError('access_denied') }, timers)
  denied.frame({ type: 'authenticate', ticket: makeTicket() })
  await tick()
  assert.equal(denied.closing.code, 4403)
  assert.equal(denied.sent.length, 0)
})

test('one state poll at a time, only revisions or inbox changes emit; no text/user ever emitted', async () => {
  const timers = scheduler(), socket = new Socket(); let calls = 0
  const values = [
    { channel: 'public', revision: 1, inboxCount: 0 },
    { channel: 'public', revision: 1, inboxCount: 0 },
    { channel: 'public', revision: 2, inboxCount: 0, text: 'secret', uid: 'secret' },
    { channel: 'public', revision: 2, inboxCount: 3 },
  ]
  attachRelay(socket, async () => values[calls++], timers)
  socket.frame({ type: 'authenticate', ticket: makeTicket() }); await tick()
  assert.equal(socket.sent[0].type, 'ready'); assert.equal(calls, 1)
  await timers.run(4000); assert.equal(socket.sent.length, 1)
  await timers.run(4000); assert.deepEqual(socket.sent[1], { type: 'channel.changed', channel: 'public', revision: 2, inboxCount: 0 })
  await timers.run(4000); assert.equal(socket.sent[2].inboxCount, 3)
  assert.ok(!JSON.stringify(socket.sent).includes('secret'))
  socket.close(1000, 'test'); assert.equal(timers.pending.size, 0)
})

test('latest ACL revocation and mismatched channel close immediately without publishing', async () => {
  for (const second of [() => { throw new RelayError('access_denied') }, () => ({ channel: 'other', revision: 1, inboxCount: 0 })]) {
    const timers = scheduler(), socket = new Socket(); let calls = 0
    attachRelay(socket, async () => calls++ ? second() : ({ channel: 'public', revision: 1, inboxCount: 0 }), timers)
    socket.frame({ type: 'authenticate', ticket: makeTicket() }); await tick(); await timers.run(4000)
    assert.equal(socket.closing.code, 4403); assert.equal(socket.sent.length, 1)
    assert.equal(timers.pending.size, 0)
  }
})

test('client publish, binary and excess pings are rejected; ticket expires and pending HTTP is aborted', async () => {
  for (const frame of [{ type: 'publish', text: 'forbidden' }, { type: 'ping', channel: 'other' }]) {
    const timers = scheduler(), socket = new Socket()
    attachRelay(socket, async () => ({ channel: 'public', revision: 1, inboxCount: 0 }), timers)
    socket.frame({ type: 'authenticate', ticket: makeTicket() }); await tick(); socket.frame(frame)
    assert.equal(socket.closing.code, 1008); assert.equal(timers.pending.size, 0)
  }
  const timers = scheduler(), socket = new Socket(); let signal
  attachRelay(socket, async (_, passed) => { signal = passed; return new Promise(() => {}) }, { ...timers, now: () => 1000000 })
  socket.frame({ type: 'authenticate', ticket: makeTicket({}, 1000000) })
  await timers.run(120000)
  assert.equal(socket.closing.reason, 'ticket_expired'); assert.equal(signal.aborted, true)
  const binary = new Socket()
  attachRelay(binary, async () => {}, timers)
  binary.emit('message', Buffer.from('binary'), true)
  assert.equal(binary.closing.code, 1008)
  const ping = new Socket()
  attachRelay(ping, async () => ({ channel: 'public', revision: 1, inboxCount: 0 }), timers)
  ping.frame({ type: 'authenticate', ticket: makeTicket() }); await tick()
  ping.frame({ type: 'ping' }); assert.equal(ping.sent.at(-1).type, 'pong')
  ping.frame({ type: 'ping' }); assert.equal(ping.closing.code, 1008)
})

test('connection ID is server generated and reused for polling/release; no browser fields accepted', async () => {
  const timers = scheduler(), socket = new Socket(); const ids = [], released = []
  const reader = async (_, __, id) => { ids.push(id); return { channel: 'public', revision: 1, inboxCount: 0 } }
  reader.release = async (...args) => released.push(args)
  attachRelay(socket, reader, timers)
  const ticket = makeTicket()
  socket.frame({ type: 'authenticate', ticket }); await tick(); await timers.run(4000)
  socket.close(1000, 'test'); await tick()
  assert.match(ids[0], /^[a-f0-9]{24}$/); assert.equal(ids[0], ids[1])
  assert.deepEqual(released, [[ticket, ids[0]]])
  const malicious = new Socket()
  attachRelay(malicious, reader, timers)
  malicious.frame({ type: 'authenticate', ticket, connectionId: 'client-picked' })
  assert.equal(malicious.closing.code, 1008)
})

test('release uses a fixed POST endpoint/header and absorbs failures without logging payload', async () => {
  let call
  const read = createStateReader('https://api.example.com', { fetchImpl: async (url, options) => { call = { url, options }; throw new Error('https://secret.example/?key=private') } })
  await read.release('opaque', 'b'.repeat(24))
  assert.equal(call.url, 'https://api.example.com/api/messages/realtime/release')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers['X-Community-WS-Connection'], 'b'.repeat(24))
  assert.equal(call.options.headers.Authorization, 'Bearer opaque')
  assert.equal(call.options.redirect, 'error')
})

test('transient errors back off and close after bounded failures, without overlapping polls', async () => {
  const timers = scheduler(), socket = new Socket(); let calls = 0
  attachRelay(socket, async () => { if (calls++) throw new RelayError('state_unavailable', { retry: true }); return { channel: 'public', revision: 1, inboxCount: 0 } }, timers)
  socket.frame({ type: 'authenticate', ticket: makeTicket() }); await tick()
  await timers.run(4000); await timers.run(8000); await timers.run(16000)
  assert.equal(calls, 4); assert.equal(socket.closing.code, 1013); assert.equal(timers.pending.size, 0)
})

test('real local WebSocket uses subprotocol and first-frame auth; Origin/query/publication restricted', async () => {
  const config = { apiOrigin: 'https://api.example.com', origins: new Set(['https://web.example.com']) }
  let reads = 0
  const relay = createRelayServer(config, { readState: async () => { reads++; return { channel: 'public', revision: 7, inboxCount: 2 } } })
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening')
  const address = relay.server.address(), url = `ws://127.0.0.1:${address.port}`
  const client = new WebSocket(url, PROTOCOL, { origin: 'https://web.example.com' })
  await once(client, 'open'); const message = once(client, 'message')
  client.send(JSON.stringify({ type: 'authenticate', ticket: makeTicket() }))
  const [raw] = await message
  assert.equal(JSON.parse(raw.toString()).type, 'ready'); assert.equal(client.protocol, PROTOCOL); assert.equal(reads, 1)
  const closed = once(client, 'close'); client.send(JSON.stringify({ type: 'publish', text: 'blocked' })); assert.equal((await closed)[0], 1008)
  for (const [suffix, origin, protocol] of [['?ticket=secret', 'https://web.example.com', PROTOCOL], ['', 'https://attacker.example.com', PROTOCOL], ['', 'https://web.example.com', 'wrong-protocol']]) {
    const rejected = new WebSocket(url + suffix, protocol, { origin })
    const error = await new Promise(resolve => rejected.on('error', resolve))
    assert.match(error.message, /403/)
  }
  const health = await fetch(`http://127.0.0.1:${address.port}/health`)
  assert.deepEqual(await health.json(), { ok: true, protocol: PROTOCOL })
  await relay.shutdown()
})
