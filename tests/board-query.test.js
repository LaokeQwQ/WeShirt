import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoardQuery, boardAgeMinutes } from '../frontend/src/boardQueryCore.js'
import { filterDormFloors, normalizeDormBuilding } from '../packages/core/buildings.js'

const response = () => ({ board: { floors: [{ code: '1', machines: [{ id: 'm1', name: '桂园1号机' }] }] }, mapping: { D1: 'alias' } })

test('a stale edge read cannot replace a newer snapshot after a forced refresh', async () => {
  let revision = 2
  const load = createBoardQuery(async (_path, options) => {
    assert.equal(options.headers['Cache-Control'], 'no-cache')
    return { ...response(), board: { ...response().board, updatedAt: `2026-01-01T00:0${revision}:00Z` } }
  })
  const fresh = await load(); revision = 1
  assert.equal(await load({ force: true }), fresh)
  revision = 3
  assert.notEqual(await load({ force: true }), fresh)
})

test('freshness ages using server age plus elapsed time even if the phone clock has a large offset', async () => {
  let now = 10000
  const load = createBoardQuery(async () => ({ ...response(), freshness: { ageSeconds: 119, serverNow: '2026-01-01T00:00:00Z' } }), { now: () => now })
  const result = await load()
  assert.equal(boardAgeMinutes(result.board, now), 1)
  now += 62000
  assert.equal(boardAgeMinutes(result.board, now), 3)
})

test('并发看板查询和强制刷新共用在途请求，短期路由切换复用缓存', async () => {
  let calls = 0
  let release
  const load = createBoardQuery(async () => { calls++; await new Promise((resolve) => { release = resolve }); return response() })
  const first = load()
  const second = load({ force: true })
  assert.equal(first, second)
  await Promise.resolve()
  release()
  const data = await first
  assert.equal((await load()), data)
  assert.equal(calls, 1)
  assert.deepEqual(data.board.slotMapping, { D1: 'alias' })
})

test('查询失败短暂退避，用户手动重试可以恢复', async () => {
  let calls = 0
  const load = createBoardQuery(async () => { calls++; if (calls === 1) throw new Error('offline'); return response() })
  await assert.rejects(load(), /offline/)
  await assert.rejects(load(), /offline/)
  assert.equal(calls, 1)
  assert.ok((await load({ force: true })).board)
  assert.equal(calls, 2)
})

test('过期缓存重新读取，不将残缺响应缓存成空看板', async () => {
  let now = 10000
  let calls = 0
  const load = createBoardQuery(async () => { calls++; return calls === 2 ? {} : response() }, { now: () => now })
  await load()
  now += 6000
  await assert.rejects(load(), /格式异常/)
  now += 6000
  await load()
  assert.equal(calls, 3)
})

test('住宿楼筛选尊重已绑定桂园的别名，避免跨楼重复和错误机位', () => {
  const board = { slotMapping: { D1: 'alias' }, floors: [{ code: '1', machines: [
    { id: 'alias', name: '柳园西' }, { id: 'l1', name: '柳园1号机' },
    { id: 'g1', name: '桂园1号机' }, { id: 'x', name: '未知设备' },
  ] }] }
  assert.deepEqual(filterDormFloors(board, 'guiyuan')[0].machines.map((m) => m.id), ['alias', 'g1'])
  assert.deepEqual(filterDormFloors(board, 'liuyuan')[0].machines.map((m) => m.id), ['l1'])
  assert.deepEqual(filterDormFloors(board, ''), [])
  assert.deepEqual(filterDormFloors(board, 'meiyuan'), [])
  assert.equal(normalizeDormBuilding('b1'), null)
})
