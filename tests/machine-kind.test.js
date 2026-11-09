import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMachineCategory, resolveMachineKind } from '../packages/core/machine-kind.js'
import { createHaierClient, normalizeMachines } from '../packages/core/haier.js'
import { runIngest, ingestRows } from '../tools/cloudbase-fn/weshirt-sync-ingest/index.mjs'

const response = data => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } })
const end = '2026-11-10T08:06:00.000Z'
const env = { HAIER_MODE: 'real', HAIER_URL: 'https://upstream.example.test', HAIER_POSITION_ID: 'fixture' }

function upstream(input, init) {
  const url = new URL(input)
  if (url.pathname.endsWith('/floorCodeList')) return response(['1'])
  if (url.pathname.endsWith('/positionDevice')) return response([
    { categoryCode: '00', categoryName: '洗衣机', total: 1 },
    { categoryCode: '01', categoryName: '洗鞋机', total: 1 },
    { categoryCode: '02', categoryName: '烘干机', total: 1 },
  ])
  const { categoryCode } = JSON.parse(init.body)
  return response({ total: 1, items: [{ deviceId: 'fixture-' + categoryCode, name: 'Alias fixture', state: 2, finishTime: end, categoryCode: '00' }] })
}

test('verified upstream category wins over cached kind, device name, D slots and numbered slots', () => {
  assert.equal(resolveMachineKind({ id: 'd', categoryCode: '02', kind: 'washer', name: 'Alias fixture' }, { 1: 'd' }), 'dryer')
  assert.equal(resolveMachineKind({ id: 'w', categoryCode: '00', kind: 'dryer', name: '烘干旧别名' }, { D1: 'w' }), 'washer')
  assert.equal(resolveMachineKind({ id: 's', categoryCode: '01', kind: 'dryer' }, { D2: 's' }), 'washer')
})

test('legacy D binding and name fallback still work when upstream category is absent', () => {
  assert.equal(resolveMachineKind({ id: 'd', name: 'Alias fixture' }, { D1: 'd' }), 'dryer')
  assert.equal(resolveMachineKind({ id: 'w', name: '烘干别名' }, { 1: 'w' }), 'washer')
  assert.equal(resolveMachineKind({ id: 'x', name: '烘干设备' }), 'dryer')
  assert.equal(resolveMachineKind({ id: 'x', kind: 'dryer' }), 'dryer')
  assert.equal(resolveMachineKind({ id: 'x', name: '普通设备' }), 'washer')
})

test('category allowlist does not accept numbers, prototypes or arbitrary category codes', () => {
  for (const value of [2, '2', '03', 'constructor', '__proto__', null, {}, '02 ']) assert.equal(normalizeMachineCategory(value), null)
  for (const value of ['00', '01', '02']) assert.equal(normalizeMachineCategory(value), value)
})

test('multi-category real fetch preserves the queried category for devices with no dryer name', async () => {
  const machines = await createHaierClient(env, { fetch: upstream }).fetchStatus()
  assert.deepEqual(machines.map(({ categoryCode, kind }) => [categoryCode, kind]), [['00', 'washer'], ['01', 'washer'], ['02', 'dryer']])
  assert.equal(machines[2].rawState, 2)
  assert.equal(machines[2].finishAt, end)
  assert.deepEqual(normalizeMachines(machines), machines, 'normalization is idempotent')
})

test('legacy single-endpoint fetch retains its category and normalizes kind', async () => {
  const machines = await createHaierClient({ ...env, HAIER_POSITION_ID: '' }, { fetch: async () => response({ total: 1, items: [{ id: 'legacy', state: 2, categoryCode: '02', kind: 'washer', name: 'Alias', finishTime: end }] }) }).fetchStatus()
  assert.equal(machines[0].categoryCode, '02')
  assert.equal(machines[0].kind, 'dryer')
})

test('CloudBase adapter posts only whitelisted category; Edge normalization recreates the same kind/time', async () => {
  let saved = null
  const result = await runIngest({ ...env, INGEST_URL: 'https://edge.example.test/api/cron/ingest', SYNC_KEY: 'fixture-sync-key' }, { fetch: async (url, init) => {
    if (new URL(url).hostname !== 'edge.example.test') return upstream(url, init)
    saved = JSON.parse(init.body).raws
    return new Response(JSON.stringify({ ok: true, error: null, fetched: saved.length }))
  } })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'ingest')
  assert.equal(saved[2].categoryCode, '02')
  assert.equal(saved[2].kind, undefined, 'kind is derived on the receiving server')
  const roundtrip = normalizeMachines(saved)
  assert.equal(roundtrip[2].kind, 'dryer')
  assert.equal(roundtrip[2].finishAt, end)
  assert.equal(roundtrip[2].rawState, 2)
})

test('unknown or absent categories are omitted by normalization and external ingest serialization', () => {
  const machine = { id: 'legacy', state: 2, rawState: 2, categoryCode: 'unknown', kind: 'dryer', finishAt: null }
  assert.equal(normalizeMachines([machine])[0].categoryCode, undefined)
  assert.equal(ingestRows([machine])[0].categoryCode, undefined)
  assert.equal(ingestRows([machine])[0].kind, undefined)
})
