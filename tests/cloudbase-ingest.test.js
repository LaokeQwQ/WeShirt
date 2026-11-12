import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runIngest, readConfig, ingestRows } from '../tools/cloudbase-fn/weshirt-sync-ingest/index.mjs'
import { parseBeijing } from '../packages/core/haier.js'

const secret = 'synthetic-secret-never-return'
const eventId = 'evt_' + 'a'.repeat(24)
const base = {
  INGEST_URL: 'https://edge.example.test/api/cron/ingest', SYNC_URL: 'https://edge.example.test/api/cron/sync', SYNC_KEY: secret,
  HAIER_URL: 'https://haier.example.test', HAIER_POSITION_ID: 'fixture-position', HAIER_AUTH_MODE: 'token',
  HAIER_HEADERS: JSON.stringify({ Authorization: 'Bearer upstream-private', 'x-upstream-only': 'private-header' }),
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
const upstreamJson = (data) => json({ code: 0, data })
function fixture(overrides = {}) {
  const calls = []
  const fetch = async (input, init = {}) => {
    const url = new URL(input), headers = new Headers(init.headers)
    const body = init.body ? JSON.parse(init.body) : null
    const call = { url, init, headers, body }
    calls.push(call)
    assert.equal(init.redirect, 'manual')
    assert.ok(init.signal)
    if (overrides.handle) {
      const response = await overrides.handle(call)
      if (response) return response
    }
    if (url.hostname === 'edge.example.test') {
      if (url.pathname.endsWith('/sync')) return json({ error: null, fetched: 2 }, 200, { 'x-event-id': eventId })
      return json({ ok: true, error: null, fetched: body.raws.length }, 200, { 'x-event-id': eventId })
    }
    if (url.pathname.endsWith('/floorCodeList')) return upstreamJson(overrides.floors || ['1', '2'])
    if (url.pathname.endsWith('/positionDevice')) return upstreamJson([{ categoryCode: '00', total: 2 }])
    return upstreamJson({ total: 1, items: [{ deviceId: 'fixture-' + body.floorCode, name: 'Fixture machine', state: 2, finishTime: '2026-11-09 16:20:00' }] })
  }
  return { calls, fetch, ingest: () => calls.filter(c => c.url.pathname.endsWith('/ingest')), sync: () => calls.filter(c => c.url.pathname.endsWith('/sync')) }
}
const clean = (value) => {
  const text = JSON.stringify(value)
  for (const privateValue of [secret, 'upstream-private', 'private-header', 'server-secret-diagnostic']) assert.ok(!text.includes(privateValue), 'No secret/diagnostic in result')
}

test('cloud ingestion preserves original and remark labels plus query-failure provenance',()=>{
 const rows=ingestRows([{id:'fixture',name:'别名',originalName:'原名',remarkName:'一楼备注',rawState:3,state:'unknown',finishAt:null,queryFailed:true,queryStatus:405}])
 assert.equal(rows[0].originalName,'原名');assert.equal(rows[0].remarkName,'一楼备注');assert.equal(rows[0].queryStatus,405)
})

test('complete real core pagination is ingested with raw state and ISO finish time; credentials stay upstream', async () => {
  const originalFetch = globalThis.fetch
  const mock = fixture({ handle: ({ url, body }) => {
    if (url.pathname.endsWith('/deviceDetailPage')) return upstreamJson({ total: 2, items: [{ deviceId: `${body.floorCode}-${body.page}`, state: body.page === 1 ? 2 : 1, name: 'Fixture', finishTime: body.page === 1 ? '2026-11-09 16:20:00' : null }] })
  } })
  const result = await runIngest({ ...base, HAIER_PAGE_SIZE: '1' }, { fetch: mock.fetch })
  assert.equal(globalThis.fetch, originalFetch)
  assert.deepEqual(result, { ok: true, mode: 'ingest', snapshotComplete: true, fetched: 4, status: 200, eventId })
  assert.equal(mock.ingest().length, 1)
  assert.equal(mock.sync().length, 0)
  const rows = mock.ingest()[0].body.raws
  assert.equal(rows[0].state, 2)
  assert.equal(rows[0].floorCode, '1')
  assert.equal(rows[0].finishTime, '2026-11-09T08:20:00.000Z')
  assert.equal(parseBeijing(rows[0].finishTime), rows[0].finishTime)
  assert.deepEqual(Object.keys(rows[0]), ['id', 'name', 'floorCode', 'state', 'finishTime', 'categoryCode'])
  for (const call of mock.calls) {
    if (call.url.hostname === 'edge.example.test') {
      assert.equal(call.headers.get('authorization'), null)
      assert.equal(call.headers.get('x-upstream-only'), null)
      assert.equal(call.body.k, secret)
      assert.equal(call.url.search, '')
    } else assert.equal(call.headers.get('authorization'), 'Bearer upstream-private')
  }
  clean(result)
})

test('one failed floor never publishes the successful partial floor; fallback occurs once', async () => {
  const mock = fixture({ handle: ({ url, body }) => {
    if (url.pathname.endsWith('/deviceDetailPage') && body.floorCode === '2') return json({ message: 'server-secret-diagnostic' }, 400)
  } })
  const result = await runIngest(base, { fetch: mock.fetch })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'fallback')
  assert.equal(result.snapshotComplete, false)
  assert.equal(result.initialFailure.reason, 'upstream_incomplete')
  assert.equal(result.initialFailure.status, 400)
  assert.equal(mock.ingest().length, 0)
  assert.equal(mock.sync().length, 1)
  clean(result)
})

test('a declared total with a missing next page is incomplete and never ingested', async () => {
  const mock = fixture({ floors: ['1'], handle: ({ url, body }) => {
    if (url.pathname.endsWith('/deviceDetailPage')) return upstreamJson({ total: 3, items: body.page === 1 ? [{ deviceId: 'fixture-only', state: 1 }] : [] })
  } })
  const result = await runIngest(base, { fetch: mock.fetch })
  assert.equal(result.snapshotComplete, false)
  assert.equal(result.mode, 'fallback')
  assert.equal(mock.ingest().length, 0)
})

test('upstream hanging response body is cancelled within scrape deadline, leaving one fallback attempt', async () => {
  let cancelled = 0
  const mock = fixture({ handle: ({ url }) => {
    if (url.hostname === 'haier.example.test') return new Response(new ReadableStream({ cancel() { cancelled++ } }))
  } })
  const start = Date.now()
  const result = await runIngest(base, { fetch: mock.fetch, timeoutMs: 120 })
  assert.ok(Date.now() - start < 600)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'fallback')
  assert.equal(result.initialFailure.reason, 'timeout')
  assert.equal(result.snapshotComplete, false)
  assert.ok(cancelled >= 1)
  assert.equal(mock.ingest().length, 0)
  assert.equal(mock.sync().length, 1)
})

test('ingest body hang uses the overall deadline and cannot send fallback after the budget expires', async () => {
  let cancelled = false
  const mock = fixture({ handle: ({ url }) => {
    if (url.pathname.endsWith('/ingest')) return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'x-event-id': eventId } })
  } })
  const result = await runIngest(base, { fetch: mock.fetch, timeoutMs: 80 })
  assert.equal(result.ok, false)
  assert.equal(result.snapshotComplete, true)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.mode, 'none')
  assert.equal(result.eventId, eventId)
  assert.equal(result.status, 200)
  assert.equal(mock.sync().length, 0)
  assert.equal(cancelled, true)
})

test('HTTP 200 business failure is a failure on both ingest and sync; fixed reasons and valid event IDs only', async () => {
  const mock = fixture({ handle: ({ url }) => {
    if (url.hostname === 'edge.example.test') return json({ ok: false, error: 'server-secret-diagnostic' }, 200, { 'x-event-id': eventId })
  } })
  const result = await runIngest(base, { fetch: mock.fetch })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'business_error')
  assert.equal(result.initialFailure.reason, 'business_error')
  assert.equal(result.status, 200)
  assert.equal(result.eventId, eventId)
  assert.equal(mock.ingest().length, 1)
  assert.equal(mock.sync().length, 1)
  clean(result)
})

test('upstream and ingest redirects are never followed; fallback is single and safe', async () => {
  for (const target of ['upstream', 'ingest']) {
    const mock = fixture({ handle: ({ url }) => {
      if (target === 'upstream' && url.hostname === 'haier.example.test' || target === 'ingest' && url.pathname.endsWith('/ingest')) return new Response(null, { status: 302, headers: { location: 'https://other.example.test/?token=' + secret } })
    } })
    const result = await runIngest(base, { fetch: mock.fetch })
    assert.equal(result.mode, 'fallback')
    assert.equal(result.initialFailure.reason, 'redirect_rejected')
    assert.ok(mock.calls.every(c => c.url.hostname !== 'other.example.test'))
    assert.equal(mock.sync().length, 1)
    clean(result)
  }
})

test('streamed upstream response size is bounded even without content-length', async () => {
  const mock = fixture({ handle: ({ url }) => {
    if (url.pathname.endsWith('/floorCodeList')) return new Response(new Uint8Array(1024 * 1024 + 1))
  } })
  const result = await runIngest(base, { fetch: mock.fetch })
  assert.equal(result.initialFailure.reason, 'response_too_large')
  assert.equal(mock.ingest().length, 0)
  assert.equal(mock.sync().length, 1)
})

test('edge oversized response is rejected; invalid trace does not escape', async () => {
  const mock = fixture({ handle: ({ url }) => {
    if (url.pathname.endsWith('/ingest')) return new Response(new Uint8Array(65537), { headers: { 'x-event-id': 'unsafe-' + secret } })
  } })
  const result = await runIngest(base, { fetch: mock.fetch })
  assert.equal(result.initialFailure.reason, 'response_too_large')
  assert.match(result.initialFailure.eventId, /^trigger_[a-f0-9]{24}$/)
  assert.equal(result.mode, 'fallback')
  clean(result)
})

test('new names take precedence; fixed HTTPS paths, no credential query, and same origin are enforced before fetch', async () => {
  const config = readConfig({ ...base, WESHIRT_SYNC_KEY: 'new-key', WESHIRT_INGEST_URL: base.INGEST_URL, WESHIRT_SYNC_URL: base.SYNC_URL })
  assert.equal(config.key, 'new-key')
  for (const mutation of [
    { INGEST_URL: 'http://edge.example.test/api/cron/ingest' },
    { INGEST_URL: base.INGEST_URL + '?k=private' },
    { INGEST_URL: 'https://private@edge.example.test/api/cron/ingest' },
    { INGEST_URL: 'https://edge.example.test/wrong' },
    { SYNC_URL: 'https://other.example.test/api/cron/sync' },
    { HAIER_URL: 'https://edge.example.test' },
  ]) {
    let calls = 0
    const result = await runIngest({ ...base, ...mutation }, { fetch: async () => { calls++; throw new Error(secret) } })
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'none')
    assert.equal(calls, 0)
    clean(result)
  }
})

test('empty or malformed normalized snapshots fail as a whole', async () => {
  for (const machines of [[], [{ id: 'a', rawState: 'occupied' }], [{ id: 'a', rawState: null }], [{ id: 'a', rawState: 1, finishAt: 'bad' }]]) assert.throws(() => ingestRows(machines), /snapshot_invalid/)
  const mock = fixture({ floors: [] })
  const result = await runIngest(base, { fetch: mock.fetch })
  assert.equal(result.snapshotComplete, false)
  assert.equal(mock.ingest().length, 0)
})

test('network exceptions containing credentials are never returned or logged by the adapter', async () => {
  const result = await runIngest(base, { fetch: async () => { throw new Error(secret + ' server-secret-diagnostic') } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'network_error')
  assert.equal(result.initialFailure.reason, 'network_error')
  assert.equal(result.status, 0)
  clean(result)
})
