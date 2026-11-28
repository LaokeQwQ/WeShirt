import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createEdgeStoreExportHandler } from '../tools/edge-store-migration/export.js'

const secret = 'fixture-secret-that-is-at-least-32-bytes'
const request = (body, { bearer = secret, method = 'POST' } = {}) => new Request('https://site.example.test/api/_migration/edge-store-export', {
  method,
  headers: { authorization: 'Bearer ' + bearer },
  body: method === 'POST' ? JSON.stringify(body) : undefined,
})

test('rejects unauthenticated access and incomplete storage bindings', async () => {
  let calls = 0
  const handler = createEdgeStoreExportHandler({ secret, binding: { get() { calls++ }, list() { calls++ } } })
  assert.equal((await handler(request({ op: 'list', cursor: null }, { bearer: 'wrong' }))).status, 404)
  assert.equal((await handler(request(null, { method: 'GET' }))).status, 404)
  assert.equal(calls, 0)
  const unavailable = createEdgeStoreExportHandler({ secret, binding: { get() {} } })
  assert.equal((await unavailable(request({ op: 'list', cursor: null }))).status, 503)
})

test('lists bounded pages from the provider and preserves its cursor', async () => {
  const expectedArgs = [{ limit: 100 }, { limit: 100, cursor: 'next-page' }]
  const pages = [{ keys: [{ key: 'user:one' }], complete: false, cursor: 'next-page' }, { keys: ['settings:one'], complete: true }]
  const handler = createEdgeStoreExportHandler({ secret, binding: { get() {}, list(args) {
    assert.deepEqual(args, expectedArgs.shift())
    return pages.shift()
  } } })
  const page = await handler(request({ op: 'list', cursor: null }))
  assert.equal(page.status, 200)
  assert.match(page.headers.get('cache-control'), /no-store/)
  assert.equal(page.headers.get('access-control-allow-origin'), null)
  assert.deepEqual(await page.json(), { protocolVersion: 1, result: { keys: ['user:one'], next: 'next-page' } })
  const last = await handler(request({ op: 'list', cursor: 'next-page' }))
  assert.deepEqual((await last.json()).result, { keys: ['settings:one'], next: null })
})

test('returns verifiable exact bytes in bounded chunks including typed-array offsets', async () => {
  const binary = Buffer.alloc(300000, 0xff)
  const raw = Buffer.concat([Buffer.from('ignored'), binary, Buffer.from('tail')])
  const handler = createEdgeStoreExportHandler({ secret, binding: { list() {}, get(key, options) {
    assert.equal(key, 'sample:key')
    assert.deepEqual(options, { type: 'arrayBuffer' })
    return raw.subarray(7, -4)
  } } })
  const first = (await (await handler(request({ op: 'get', keys: ['sample:key'], offset: 0 }))).json()).result.rows[0]
  const prefix = Buffer.from(first.data, 'base64')
  assert.equal(prefix.length, 256 * 1024)
  const second = (await (await handler(request({ op: 'get', keys: ['sample:key'], offset: prefix.length }))).json()).result.rows[0]
  const combined = Buffer.concat([prefix, Buffer.from(second.data, 'base64')])
  assert.deepEqual(combined, binary)
  assert.equal(first.bytes, 300000)
  assert.equal(second.sha256, first.sha256)
  assert.equal(first.sha256, createHash('sha256').update(binary).digest('hex'))
})

test('fails closed for oversize input, ambiguous listing, and a missing listed value', async () => {
  const handler = createEdgeStoreExportHandler({ secret, binding: { get() { return null }, list() {
    return { keys: ['repeat', 'repeat'], complete: true }
  } } })
  assert.equal((await handler(request({ op: 'list', cursor: 'x'.repeat(17000) }))).status, 413)
  assert.equal((await handler(request({ op: 'get', keys: ['dup', 'dup'], offset: 0 }))).status, 400)
  assert.equal((await handler(request({ op: 'list', cursor: null }))).status, 503)
  const response = await handler(request({ op: 'get', keys: ['private-key'], offset: 0 }))
  const body = await response.json()
  assert.equal(response.status, 503)
  assert.deepEqual(body.error, { code: 'source_export_unavailable', status: 503, eventId: response.headers.get('x-event-id') })
  assert.doesNotMatch(JSON.stringify(body), /private-key/)
})
