import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { telemetryDay } from '../packages/core/telemetry.js'

const SECRET = 'edge-chunks-integration-local-test-secret'
const MODES = ['arraybuffer', 'view', 'string']
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAvsAAAAASUVORK5CYII=', 'base64')

function edgeBody(body, mode, counts, label) {
  return {
    getReader() {
      const reader = body.getReader()
      return {
        async read() {
          const part = await reader.read()
          if (part.done) return part
          counts[label] = (counts[label] || 0) + 1
          const bytes = new Uint8Array(part.value.buffer, part.value.byteOffset, part.value.byteLength)
          if (mode === 'arraybuffer') return { done: false, value: bytes.slice().buffer }
          if (mode === 'string') return { done: false, value: new TextDecoder().decode(bytes) }
          if (mode === 'unsupported') return { done: false, value: { byteLength: bytes.byteLength } }
          const padded = new Uint8Array(bytes.byteLength + 8).fill(255)
          padded.set(bytes, 4)
          return { done: false, value: new DataView(padded.buffer, 4, bytes.byteLength) }
        },
        cancel: (...args) => reader.cancel(...args),
        releaseLock: () => reader.releaseLock(),
      }
    },
  }
}

function edgeClones(t, mode) {
  const counts = {}
  for (const [Type, label] of [[Request, 'request'], [Response, 'response']]) {
    const clone = Type.prototype.clone
    t.mock.method(Type.prototype, 'clone', function () {
      const copy = clone.call(this)
      const cloneMode = label === 'response' && mode === 'unsupported' ? 'arraybuffer' : mode
      if (copy.body) Object.defineProperty(copy, 'body', { value: edgeBody(copy.body, cloneMode, counts, label), configurable: true })
      return copy
    })
  }
  return counts
}

async function fixture(t) {
  const store = createMemoryStore()
  const env = { AUTH_SECRET: SECRET, BUILDING_ID: 'b1', HAIER_MODE: 'mock' }
  for (const [id, dormBuilding] of [['alice', 'guiyuan'], ['manager', 'guiyuan'], ['target', 'guiyuan']]) {
    await store.put('user:' + id, { id, nick: id + '同学', dormBuilding, notifyOn: false })
  }
  await store.put('meta:siteAdmins', [{ userId: 'manager', role: 'admin' }])
  await store.put('access:user:manager', { permissions: { adminUsers: { view: true, operate: true, viewBuildings: ['guiyuan'], operateBuildings: ['guiyuan'] } } })
  const tokens = { alice: await issueToken('alice', SECRET), manager: await issueToken('manager', SECRET) }
  const app = createApp({ store, env })
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network is forbidden') })
  const call = async (path, { user = 'alice', method = 'POST', body, key, rawMode, raw, mime = 'application/json' } = {}) => {
    const request = new Request('https://local.example' + path, {
      method,
      headers: { ...(user ? { authorization: 'Bearer ' + tokens[user] } : {}), 'content-type': mime, ...(key ? { 'Idempotency-Key': key } : {}) },
      body: method === 'GET' ? undefined : raw ?? JSON.stringify(body),
    })
    const counts = {}
    if (rawMode && request.body) Object.defineProperty(request, 'body', { value: edgeBody(request.body, rawMode, counts, 'raw'), configurable: true })
    const response = await app.fetch(request)
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer())
    return { status: response.status, data, response, counts }
  }
  return { store, call, network }
}

function errorTrace(result, status, code, message) {
  assert.equal(result.status, status, JSON.stringify(result.data))
  assert.equal(result.data.error.code, code)
  assert.equal(result.data.error.message, message)
  assert.equal(result.data.error.status, status)
  assert.match(result.data.error.eventId, /^evt_[a-f0-9]{24}$/)
  assert.equal(result.response.headers.get('x-event-id'), result.data.error.eventId)
}

for (const mode of MODES) {
  test(`Edge ${mode} clones preserve actual profile writes, cached replies, and equal-length body conflicts`, async t => {
    const { store, call, network } = await fixture(t)
    const counts = edgeClones(t, mode)
    const body = { nick: '甲乙同学' }, changed = { nick: '丙丁同学' }, key = 'edge-profile-' + mode
    assert.equal(JSON.stringify(body).length, JSON.stringify(changed).length)
    const first = await call('/api/user/profile', { body, key })
    assert.equal(first.status, 200, JSON.stringify(first.data))
    assert.equal(first.data.user.nick, body.nick, 'the original Request.json still reads the real body')
    const replay = await call('/api/user/profile', { body, key })
    assert.equal(replay.status, 200, JSON.stringify(replay.data))
    assert.equal(replay.response.headers.get('Idempotency-Replayed'), 'true')
    assert.deepEqual(replay.data, first.data)
    const conflict = await call('/api/user/profile', { body: changed, key })
    errorTrace(conflict, 409, 'idempotency_conflict', '请求标识已用于不同内容，请重新提交')
    assert.equal((await store.get('user:alice')).nick, body.nick)

    const invalid = await call('/api/user/profile', { body: { dormBuilding: 'missing_dorm' }, key: 'edge-invalid-' + mode })
    errorTrace(invalid, 400, 'bad_param', '请选择有效的住宿楼')
    const invalidReplay = await call('/api/user/profile', { body: { dormBuilding: 'missing_dorm' }, key: 'edge-invalid-' + mode })
    errorTrace(invalidReplay, 400, 'bad_param', '请选择有效的住宿楼')
    assert.equal(invalidReplay.response.headers.get('Idempotency-Replayed'), 'true')
    assert.notEqual(invalidReplay.data.error.eventId, invalid.data.error.eventId)
    assert.ok(counts.request > 0)
    assert.ok(counts.response > 0, 'error envelopes and replay snapshots use the simulated Edge reader')
    assert.equal(network.mock.callCount(), 0)
  })

  test(`Edge ${mode} request clones retain scoped admin destination checks`, async t => {
    const { store, call } = await fixture(t)
    const counts = edgeClones(t, mode)
    const denied = await call('/api/admin/user/target', { user: 'manager', body: { dormBuilding: 'liuyuan' } })
    errorTrace(denied, 403, 'forbidden', '目标不在授权操作范围内')
    assert.equal((await store.get('user:target')).dormBuilding, 'guiyuan')
    const allowed = await call('/api/admin/user/target', { user: 'manager', body: { nick: '楼内更新' } })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data))
    assert.equal((await store.get('user:target')).nick, '楼内更新')
    assert.ok(counts.request > 0)
  })

  test(`Edge ${mode} raw JSON bodies reach telemetry and authenticated community handlers intact`, async t => {
    const { store, call, network } = await fixture(t)
    const telemetry = await call('/api/telemetry', { user: null, rawMode: mode, body: { events: [{ name: 'page_view', route: '/list', dorm: 'guiyuan' }] } })
    assert.equal(telemetry.status, 202, JSON.stringify(telemetry.data))
    assert.equal((await store.get('telemetryday:' + telemetryDay())).scopes.all.received, 1)
    assert.ok(telemetry.counts.raw > 0)
    const posted = await call('/api/messages', { rawMode: mode, body: { channel: 'public', text: '中文正文 <b>保留为文本</b>' } })
    assert.equal(posted.status, 200, JSON.stringify(posted.data))
    assert.equal(posted.data.message.text, '中文正文 <b>保留为文本</b>')
    const saved = await store.get('messages:b1')
    assert.equal(saved[0].text, posted.data.message.text)
    assert.ok(posted.counts.raw > 0)
    assert.equal(network.mock.callCount(), 0)
  })
}

test('unreadable cloned admin bodies fail closed before the original valid body can mutate a user', async t => {
  const { store, call } = await fixture(t)
  const counts = edgeClones(t, 'unsupported')
  const before = structuredClone(await store.get('user:target'))
  const result = await call('/api/admin/user/target', { user: 'manager', body: { nick: '不应更新', dormBuilding: 'liuyuan' } })
  errorTrace(result, 400, 'bad_param', '请求须为有效 JSON 内容')
  assert.deepEqual(await store.get('user:target'), before)
  assert.ok(counts.request > 0)
})

test('raw string request budgets count UTF-8 bytes rather than UTF-16 characters', async t => {
  const { call } = await fixture(t)
  const raw = JSON.stringify({ events: [], ignored: '汉'.repeat(6000) })
  assert.ok(raw.length < 16384)
  assert.ok(new TextEncoder().encode(raw).byteLength > 16384)
  const result = await call('/api/telemetry', { user: null, rawMode: 'string', raw })
  assert.equal(result.status, 413)
  assert.equal(result.data.error.code, 'too_large')
})

for (const mode of ['arraybuffer', 'view']) {
  test(`Edge ${mode} binary media upload and ArrayBuffer-only Response download preserve every byte`, async t => {
    const { call, network } = await fixture(t)
    const upload = await call('/api/messages/media?channel=public', { rawMode: mode, raw: png, mime: 'image/png' })
    assert.equal(upload.status, 200, JSON.stringify(upload.data))
    assert.ok(upload.counts.raw > 0)
    const NativeResponse = globalThis.Response
    t.mock.method(globalThis, 'Response', class EdgeResponse extends NativeResponse {
      constructor(body, options) {
        if (ArrayBuffer.isView(body)) throw new TypeError('This runtime requires ArrayBuffer instead of ArrayBufferView')
        super(body, options)
      }
    })
    const downloaded = await call(upload.data.media.url, { method: 'GET' })
    assert.equal(downloaded.status, 200, JSON.stringify(downloaded.data))
    assert.deepEqual(Buffer.from(downloaded.data), png)
    assert.equal(downloaded.response.headers.get('content-type'), 'image/png')
    assert.equal(network.mock.callCount(), 0)
  })
}
