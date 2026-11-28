import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration = new URL('../cloudbase/migrations/20261128134500_site_store.sql', import.meta.url)
const chunks = new URL('../cloudbase/migrations/20261128160000_site_store_chunks.sql', import.meta.url)
const functions = {
  get: { signatures: 'text', args: ['$1::text'] },
  put: { signatures: 'text, jsonb', args: ['$1::text', '$2::jsonb'] },
  delete: { signatures: 'text', args: ['$1::text'] },
  list: { signatures: 'text, text, integer', args: ['$1::text', '$2::text', '$3::integer'] },
  import: { signatures: 'jsonb', args: ['$1::jsonb'] },
  stage: { signatures: 'text, integer, text, boolean', args: ['$1::text', '$2::integer', '$3::text', '$4::boolean'] },
  commit: { signatures: 'text, integer, text, boolean', args: ['$1::text', '$2::integer', '$3::text', '$4::boolean'] },
  read_chunk: { signatures: 'text, integer, text', args: ['$1::text', '$2::integer', '$3::text'] },
  list_keys: { signatures: 'text, text, integer', args: ['$1::text', '$2::text', '$3::integer'] },
}
let db

async function asRole(role, claims, run) {
  assert.ok(['service_role', 'anon', 'authenticated'].includes(role))
  return db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE ' + role)
    await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)])
    return run(tx)
  })
}

async function executeRpc(op, args, { role = 'service_role', claims = { role } } = {}) {
  assert.ok(Object.hasOwn(functions, op))
  return asRole(role, claims, async tx => {
    const query = 'SELECT public.weshirt_site_store_' + op + '(' + functions[op].args.join(',') + ') AS response'
    const { rows } = await tx.query(query, args)
    const envelope = rows[0].response
    assert.deepEqual(envelope, { protocolVersion: 1, ok: true, result: envelope.result })
    assert.ok(Object.hasOwn(envelope, 'result'))
    return envelope.result
  })
}

const get = key => executeRpc('get', [key])
const put = (key, value) => executeRpc('put', [key, JSON.stringify(value)])
const list = (prefix, afterKey = null, limit = 100) => executeRpc('list', [prefix, afterKey, limit])
const importRows = rows => executeRpc('import', [JSON.stringify(rows)])
const stage = (id, part, value, importOnly = false) => executeRpc('stage', [id, part, value, importOnly])

before(async () => {
  db = new PGlite()
  await db.waitReady
  await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;')
  await db.exec(await readFile(migration, 'utf8'))
  await db.exec(await readFile(chunks, 'utf8'))
})
after(async () => { await db?.close() })

test('site store distinguishes every JSON type, including null, from absence', async () => {
  const key = 'value:record'
  assert.deepEqual(await get(key), { found: false })
  for (const value of [null, '', '中文', false, 0, [], [0, null, false], { note: '洗衣', nested: {} }]) {
    assert.equal(await put(key, value), true)
    assert.deepEqual(await get(key), { found: true, value })
  }
  assert.equal(await executeRpc('put', [key, null]), true)
  assert.deepEqual(await get(key), { found: true, value: null })
  assert.equal(await executeRpc('delete', [key]), true)
  assert.equal(await executeRpc('delete', [key]), true)
  assert.deepEqual(await get(key), { found: false })
})

test('site store lists literal prefixes with exclusive C-order cursors', async () => {
  const keys = ['list:%中', 'list:%z', 'list:%Z', 'list:%000', 'list:%%', 'list:X', 'list:_']
  await importRows(keys.map((key, position) => ({ key, value: position })))
  const first = await list('list:%', null, 2)
  assert.deepEqual(first, {
    rows: [{ key: 'list:%%', value: 4 }, { key: 'list:%000', value: 3 }],
    next: 'list:%000',
  })
  const second = await list('list:%', first.next, 2)
  assert.deepEqual(second, {
    rows: [{ key: 'list:%Z', value: 2 }, { key: 'list:%z', value: 1 }],
    next: 'list:%z',
  })
  assert.deepEqual(await list('list:%', second.next, 1), {
    rows: [{ key: 'list:%中', value: 0 }],
    next: null,
  })
  assert.deepEqual(await list('list:_'), { rows: [{ key: 'list:_', value: 6 }], next: null })
  assert.deepEqual(await list('list:absent'), { rows: [], next: null })
})

test('a large value returns on its own page without dropping subsequent rows', async () => {
  const value = '汉'.repeat(140000)
  await put('large:aa', value)
  await put('large:bb', true)
  const first = await list('large:')
  assert.equal(first.next, 'large:aa')
  assert.equal(first.rows.length, 1)
  assert.deepEqual(first.rows[0], { key: 'large:aa', value })
  assert.deepEqual(await list('large:', first.next), {
    rows: [{ key: 'large:bb', value: true }],
    next: null,
  })
})

test('import is atomic, repeatable and never overwrites existing values or expiry', async () => {
  const now = Date.now()
  const rows = [
    { key: 'import:absent', value: 'new' },
    { key: 'import:existing', value: 'stale' },
    { key: 'import:expiry', value: null, expiresAtMs: now - 60000 },
    { key: 'import:future', value: 1, expiresAtMs: now + 3600000 },
  ]
  await put('import:existing', 'current')
  assert.deepEqual(await importRows(rows), { inserted: 3, existing: 1 })
  assert.deepEqual(await importRows(rows), { inserted: 0, existing: 4 })
  assert.deepEqual(await get('import:existing'), { found: true, value: 'current' })
  assert.deepEqual(await get('import:expiry'), { found: false })
  assert.deepEqual(await list('import:'), {
    rows: [
      { key: 'import:absent', value: 'new' },
      { key: 'import:existing', value: 'current' },
      { key: 'import:future', value: 1 },
    ],
    next: null,
  })
  const { rows: stored } = await db.query(
    'SELECT extract(epoch FROM expires_at) * 1000 AS expires_ms FROM weshirt_site_private.entries WHERE key = $1',
    ['import:future'],
  )
  assert.equal(Number(stored[0].expires_ms), rows[3].expiresAtMs)
  await assert.rejects(importRows([{ key: 'import:invalid-batch', value: 1 }, { key: 'missing-value' }]), { code: '22023' })
  assert.deepEqual(await get('import:invalid-batch'), { found: false })
  await assert.rejects(importRows([{ key: 'import:duplicate', value: 'a' }, { key: 'import:duplicate', value: 'b' }]), { code: '22023' })
  assert.deepEqual(await get('import:duplicate'), { found: false })
  assert.equal(await put('import:expiry', 'replaced'), true)
  assert.deepEqual(await get('import:expiry'), { found: true, value: 'replaced' })
})

test('invalid database input fails closed before writing', async () => {
  for (const key of [null, '', '中'.repeat(171)]) {
    await assert.rejects(get(key), { code: '22023' })
    await assert.rejects(put(key, true), { code: '22023' })
    await assert.rejects(executeRpc('delete', [key]), { code: '22023' })
  }
  await assert.rejects(list('one:', 'two:'), { code: '22023' })
  await assert.rejects(list('one:', null, 257), { code: '22023' })
  await assert.rejects(importRows([{ key: 'invalid:expiry', value: true, expiresAtMs: '0' }]), { code: '22023' })
  await assert.rejects(importRows([{ key: 'invalid:expiry', value: true, expiresAtMs: 1.25 }]), { code: '22023' })
  assert.deepEqual(await get('invalid:expiry'), { found: false })
})

test('RPC grants, JWT check, schema ACL and forced RLS protect site state', async () => {
  const key = 'roles:private'
  await put(key, { hidden: true })
  const fixture = {
    get: [key],
    put: [key, JSON.stringify(false)],
    delete: [key],
    list: ['roles:', null, 100],
    import: [JSON.stringify([{ key, value: null }])],
    stage: [crypto.randomUUID(), 0, 'null', false],
    commit: [crypto.randomUUID(), 1, key, false],
    read_chunk: [key, 0, null],
    list_keys: ['roles:', null, 100],
  }
  for (const [op, { signatures }] of Object.entries(functions)) {
    await assert.rejects(executeRpc(op, fixture[op], { role: 'anon' }), { code: '42501' })
    // Simulate CloudBase bypassing PostgreSQL's grant on RPC reachability.
    await db.exec('GRANT EXECUTE ON FUNCTION public.weshirt_site_store_' + op + '(' + signatures + ') TO anon, authenticated')
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(executeRpc(op, fixture[op], { role }), { code: '42501' })
      await assert.rejects(executeRpc(op, fixture[op], { role, claims: { role: 'service_role' } }), { code: '42501' })
    }
    await assert.rejects(executeRpc(op, fixture[op], { claims: {} }), { code: '42501', message: 'site_store_service_required' })
  }
  await assert.rejects(
    asRole('authenticated', { role: 'authenticated' }, tx => tx.query('SELECT key FROM weshirt_site_private.entries')),
    { code: '42501' },
  )
  await db.exec('GRANT USAGE ON SCHEMA weshirt_site_private TO authenticated; GRANT SELECT ON TABLE weshirt_site_private.entries TO authenticated')
  const result = await asRole('authenticated', { role: 'authenticated' }, tx => tx.query('SELECT key FROM weshirt_site_private.entries'))
  assert.deepEqual(result.rows, [])
  assert.deepEqual(await get(key), { found: true, value: { hidden: true } })
})

test('staged chunks are immutable until a validated, idempotent commit', async () => {
  const id = crypto.randomUUID(), key = 'chunks:photo'
  const value = { photo: 'a'.repeat(190000) }
  const serialized = JSON.stringify(value)
  const parts = serialized.match(/.{1,100000}/g)
  assert.equal(await stage(id, 0, parts[0]), true)
  assert.equal(await stage(id, 0, parts[0]), true)
  await assert.rejects(stage(id, 0, parts[1]), { code: '22023' })
  await assert.rejects(executeRpc('commit', [id, 2, key, false]), { code: '22023' })
  assert.deepEqual(await get(key), { found: false })
  assert.equal(await stage(id, 1, parts[1]), true)
  assert.equal(await executeRpc('commit', [id, 2, key, false]), true)
  assert.deepEqual(await get(key), { found: true, value })
  assert.equal(await put(key, 'after upload'), true)
  assert.equal(await executeRpc('commit', [id, 2, key, false]), true)
  assert.deepEqual(await get(key), { found: true, value: 'after upload' })
  await assert.rejects(executeRpc('commit', [id, 2, 'chunks:wrong-key', false]), { code: '22023' })
  await assert.rejects(stage(id, 2, parts[0]), { code: '22023' })
  assert.equal(await stage(id, 0, parts[0]), true)
  const internalId = createHash('sha256').update('false:' + id).digest('hex').slice(0, 32)
  const { rows } = await db.query('SELECT count(*)::integer AS count FROM weshirt_site_private.upload_parts WHERE id = $1', [internalId])
  assert.equal(rows[0].count, 0)
})

test('chunk imports neither overwrite existing state nor partially apply malformed serialized values', async () => {
  const id = crypto.randomUUID(), key = 'chunks:transfer'
  await put(key, 1)
  assert.equal(await stage(id, 0, '2', true), true)
  await assert.rejects(executeRpc('commit', [id, 1, key, false]), { code: '22023' })
  assert.equal(await executeRpc('commit', [id, 1, key, true]), false)
  assert.equal(await executeRpc('commit', [id, 1, key, true]), false)
  assert.deepEqual(await get(key), { found: true, value: 1 })
  const invalid = crypto.randomUUID()
  assert.equal(await stage(invalid, 0, '"unfinished'), true)
  await assert.rejects(executeRpc('commit', [invalid, 1, key, false]), { code: '22P02' })
  assert.deepEqual(await get(key), { found: true, value: 1 })
  const internalId = createHash('sha256').update('false:' + invalid).digest('hex').slice(0, 32)
  await db.query("UPDATE weshirt_site_private.uploads SET expires_at = statement_timestamp() - interval '1 minute' WHERE id = $1", [internalId])
  await assert.rejects(executeRpc('commit', [invalid, 1, key, false]), { code: '22023' })
  await stage(crypto.randomUUID(), 0, 'null')
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM weshirt_site_private.upload_parts WHERE id = $1', [internalId])).rows[0].count, 0)
})

test('reads bound escaped bytes, preserve Unicode, and reject mixed versions', async () => {
  const key = 'chunks:unicode'
  const value = { photo: '🫧'.repeat(33000), note: '\\u中文\n'.repeat(2700) }
  await put(key, value)
  const first = await executeRpc('read_chunk', [key, 0, null])
  assert.equal(first.found, true)
  assert.equal(first.next, 10000)
  assert.match(first.digest, /^[a-f0-9]{64}$/)
  const parts = [first.text]
  let next = first.next
  while (next !== null) {
    const row = await executeRpc('read_chunk', [key, next, first.digest])
    assert.ok(Buffer.byteLength(JSON.stringify(row), 'utf8') < 91000)
    assert.equal(row.digest, first.digest)
    assert.ok(row.next === null || row.next > next)
    parts.push(row.text)
    next = row.next
  }
  assert.deepEqual(JSON.parse(parts.join('')), value)
  await put(key, { newVersion: true })
  await assert.rejects(executeRpc('read_chunk', [key, first.next, first.digest]), { code: '40001' })
  await executeRpc('delete', [key])
  await assert.rejects(executeRpc('read_chunk', [key, first.next, first.digest]), { code: '40001' })
  assert.deepEqual(await executeRpc('read_chunk', [key, 0, null]), { found: false })
})

test('gateway-safe pagination inlines small values, excludes expired rows and respects literal byte ordering', async () => {
  const expired = Date.now() - 60000
  await importRows([
    { key: 'chunks-list:%1', value: 'a'.repeat(120000) },
    { key: 'chunks-list:%0', value: null, expiresAtMs: expired },
    { key: 'chunks-list:%中', value: 0 },
    { key: 'chunks-list:x', value: 1 },
  ])
  assert.deepEqual(await executeRpc('list_keys', ['chunks-list:%', null, 1]), {
    rows: [{ key: 'chunks-list:%1', chunked: true }], next: 'chunks-list:%1',
  })
  assert.deepEqual(await executeRpc('list_keys', ['chunks-list:%', 'chunks-list:%1', 1]), {
    rows: [{ key: 'chunks-list:%中', value: 0 }], next: null,
  })
  await put('chunks-page:1', 'a'.repeat(45000))
  await put('chunks-page:2', 'b'.repeat(45000))
  const first = await executeRpc('list_keys', ['chunks-page:', null, 100])
  assert.equal(first.rows.length, 1)
  assert.equal(first.next, 'chunks-page:1')
  assert.equal(first.rows[0].value.length, 45000)
  const second = await executeRpc('list_keys', ['chunks-page:', first.next, 100])
  assert.equal(second.rows.length, 1)
  assert.equal(second.rows[0].value.length, 45000)
  assert.equal(second.next, null)
})
