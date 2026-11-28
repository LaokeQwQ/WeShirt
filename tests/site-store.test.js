import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteSiteStore, createSiteStoreHttpHandler } from '../packages/core/site-store.js'

const secret = 'site-fixture-runtime-secret-test-only'
const importSecret = 'site-fixture-import-secret-test-only'
const url = 'https://example.invalid/site-store'
const envelope = result => ({ protocolVersion: 1, ok: true, result })
const toResponse = ({ statusCode, headers, body }) => new Response(body, { status: statusCode, headers })
const event = (body, authorization = 'Bearer ' + secret) => ({ httpMethod: 'POST', headers: { Authorization: authorization }, body: JSON.stringify(body) })
const unavailable = { code: 'site_store_unavailable' }

test('CloudBase bridge preserves real null, absence, and paginated prefix reads', async () => {
  const data = new Map([['p:1', null], ['p:2', 0], ['q:1', 'excluded']])
  const rdb = { async rpc(name, args) {
    const key = args.p_key
    if (name === 'weshirt_site_store_get') return { data: envelope(data.has(key) ? { found: true, value: data.get(key) } : { found: false }) }
    if (name === 'weshirt_site_store_put') { data.set(key, args.p_value); return { data: envelope(true) } }
    if (name === 'weshirt_site_store_delete') return { data: envelope(data.delete(key)) }
    assert.equal(name, 'weshirt_site_store_list')
    const matches = [...data].filter(([key]) => key.startsWith(args.p_prefix) && key > (args.p_after ?? '')).sort()
    const rows = matches.slice(0, 1).map(([key, value]) => ({ key, value }))
    return { data: envelope({ rows, next: matches.length > 1 ? rows[0].key : null }) }
  } }
  const handle = createSiteStoreHttpHandler({ rdb, secret })
  const store = createRemoteSiteStore({ url, secret, fetch: async (target, init) => {
    assert.equal(target, url)
    assert.equal(init.redirect, 'error')
    return toResponse(await handle({ httpMethod: init.method, body: init.body, headers: init.headers }))
  } })

  assert.equal(await store.get('absent', 42), 42)
  assert.equal(await store.get('p:1', 42), null)
  assert.equal(await store.put('p:3', false), false)
  assert.deepEqual(await store.list('p:'), [{ key: 'p:1', value: null }, { key: 'p:2', value: 0 }, { key: 'p:3', value: false }])
  assert.equal(await store.del('p:1'), true)
  assert.equal(await store.del('p:1'), false)
  assert.equal(createRemoteSiteStore({ url: 'http://example.invalid', secret }), null)
})

test('bridge restricts importing to a distinct operator credential and uses fixed operations', async () => {
  let called = 0
  const rows = [{ key: 'legacy', value: null }]
  const handle = createSiteStoreHttpHandler({ secret, importSecret, rdb: { async rpc(name, args) {
    called++
    assert.equal(name, 'weshirt_site_store_import')
    assert.deepEqual(args, { p_rows: rows })
    return { data: envelope({ inserted: 1, existing: 0 }) }
  } } })
  assert.equal((await handle(event({ op: 'get', key: 'legacy' }, 'Bearer invalid'))).statusCode, 401)
  assert.equal((await handle(event({ op: 'get', key: 'legacy' }, 'Bearer ' + importSecret))).statusCode, 403)
  assert.equal((await handle(event({ op: 'import', rows }))).statusCode, 403)
  assert.equal((await handle(event({ op: 'put', key: 'legacy' }))).statusCode, 400)
  assert.equal((await handle(event({ op: 'other', key: 'legacy' }))).statusCode, 400)
  const result = await handle(event({ op: 'import', rows }, 'Bearer ' + importSecret))
  assert.equal(result.statusCode, 200)
  assert.match(result.headers['X-Event-Id'], /^evt_[a-f0-9]{24}$/)
  assert.equal(called, 1)
})

test('ambiguous reads retry, writes do not, and bad policy rows fail closed', async () => {
  let attempts = 0
  const store = createRemoteSiteStore({ url, secret, fetch: async (_url, init) => {
    const { op, key } = JSON.parse(init.body)
    attempts++
    if (op !== 'get' || attempts === 1) return new Response(null, { status: 503 })
    return Response.json(envelope({ found: true, value: key === 'meta:siteAdmins' ? 'broken policy' : 9 }))
  } })
  assert.equal(await store.get('any'), 9)
  assert.equal(attempts, 2)
  await assert.rejects(store.put('any', 5), unavailable)
  assert.equal(attempts, 3)
  await assert.rejects(store.get('meta:siteAdmins', []), unavailable)
})

test('a repeated or out-of-scope list page fails instead of returning a partial result', async () => {
  let attempted = 0
  const store = createRemoteSiteStore({ url, secret, fetch: async () => {
    attempted++
    return Response.json(envelope({ rows: [{ key: 'a:1', value: 0 }], next: 'a:1' }))
  } })
  await assert.rejects(store.list('a:'), unavailable)
  assert.equal(attempted, 2)
  await assert.rejects(store.list('b:'), unavailable)
  assert.equal(attempted, 3)
})
