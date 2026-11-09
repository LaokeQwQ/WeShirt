import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirectBoardClient, rawToMachines } from '../frontend/src/haierDirect.js'

const INFO = { base: 'https://up.example.test', positionId: '1' }
const result = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } })
const machine = (id, state = 1) => ({ deviceId: id, name: '设备 ' + id, state })

test('直连共享默认状态码，支持显式时区、原始状态与缺省字段', () => {
  const list = rawToMachines([
    { ...machine(1), finishTime: '2026-11-09T08:00:00Z' },
    machine(2, 2), machine(3, 3), machine(4, 99), { name: '无ID' }, null,
  ])
  assert.deepEqual(list.map((m) => m.state), ['idle', 'occupied', 'faulty', 'unknown'])
  assert.equal(list[0].id, '1')
  assert.equal(list[0].finishAt, '2026-11-09T08:00:00.000Z')
  assert.equal(list[1].rawState, 2)
  assert.equal(list[1].leftMin, null)
})

test('直连有效未来完成时间保留实际倒计时，过期时间归零', () => {
  const now = Date.now()
  const list = rawToMachines([
    { ...machine('future', 2), finishTime: new Date(now + 20 * 60000).toISOString() },
    { ...machine('past', 2), finishTime: new Date(now - 5 * 60000).toISOString() },
  ])
  assert.equal(list[0].leftMin, 20)
  assert.equal(list[1].leftMin, 0)
})

test('直连分页、去重、有限并发，并复用元数据和在途查询', async () => {
  let clock = 1000
  let infoCalls = 0
  let metadataCalls = 0
  let detailCalls = 0
  let active = 0
  let peak = 0
  const client = createDirectBoardClient({
    now: () => clock,
    getInfo: async () => { infoCalls++; return INFO },
    fetchImpl: async (url, init) => {
      if (url.includes('floorCodeList')) { metadataCalls++; return result(['1', '2', '3', '4', '5', '6']) }
      if (url.includes('positionDevice')) { metadataCalls++; return result([{ categoryCode: '00', total: 800 }]) }
      const { page, floorCode } = JSON.parse(init.body)
      detailCalls++
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      // total 缺省：满页后还必须继续；跨楼层返回相同deviceId也要去重。
      return result({ items: page === 1 ? Array.from({ length: 100 }, (_, i) => machine(`${floorCode}-${i}`)) : [machine('shared')] })
    },
  })
  const first = client.fetchBoardDirect()
  assert.equal(first, client.fetchBoardDirect())
  const data = await first
  assert.equal(data.board.total, 601)
  assert.equal(data.board.idle, 601)
  assert.equal(data.board.floors.length, 6)
  assert.equal(infoCalls, 1)
  assert.equal(metadataCalls, 2)
  assert.equal(detailCalls, 12)
  assert.ok(peak > 1 && peak <= 4)
  await client.fetchBoardDirect()
  assert.equal(infoCalls, 1)
  assert.equal(metadataCalls, 2)
  assert.equal(detailCalls, 24)
  clock += 5 * 60000 + 1
  await client.fetchBoardDirect()
  assert.equal(infoCalls, 2)
  assert.equal(metadataCalls, 4)
})

test('失败冷却期跳过重复请求，冷却结束允许恢复', async () => {
  let clock = 1000
  let calls = 0
  let fail = true
  const client = createDirectBoardClient({
    now: () => clock,
    getInfo: async () => INFO,
    fetchImpl: async (url) => {
      calls++
      if (fail) return new Response('', { status: 503 })
      if (url.includes('floorCodeList')) return result(['1'])
      if (url.includes('positionDevice')) return result([{ categoryCode: '00', total: 1 }])
      return result({ total: 1, items: [machine('1')] })
    },
  })
  await assert.rejects(client.fetchBoardDirect(), /HTTP 503/)
  const before = calls
  await assert.rejects(client.fetchBoardDirect(), /暂不可用/)
  assert.equal(calls, before)
  clock += 30001
  fail = false
  assert.equal((await client.fetchBoardDirect()).board.total, 1)
})

test('直连超时真正取消响应体读取，并停止该轮请求', async () => {
  let aborted = false
  const client = createDirectBoardClient({
    getInfo: async () => INFO,
    fetchImpl: async (url, init) => {
      if (url.includes('floorCodeList')) return result(['1'])
      if (url.includes('positionDevice')) return result([{ categoryCode: '00', total: 1 }])
      return {
        ok: true,
        json: () => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
        }),
      }
    },
  })
  await assert.rejects(client.fetchBoardDirect(10), /上游超时/)
  assert.equal(aborted, true)
})

test('任一楼层失败取消其余查询，不能返回部分看板', async () => {
  let aborted = false
  const client = createDirectBoardClient({
    getInfo: async () => INFO,
    fetchImpl: async (url, init) => {
      if (url.includes('floorCodeList')) return result(['1', '2'])
      if (url.includes('positionDevice')) return result([{ categoryCode: '00', total: 2 }])
      if (JSON.parse(init.body).floorCode === '2') return new Response('', { status: 404 })
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
      })
    },
  })
  await assert.rejects(client.fetchBoardDirect(), /HTTP 404/)
  assert.equal(aborted, true)
})

test('已知 total 但中途空页时，不能静默丢失设备', async () => {
  const client = createDirectBoardClient({
    getInfo: async () => INFO,
    fetchImpl: async (url) => {
      if (url.includes('floorCodeList')) return result(['1'])
      if (url.includes('positionDevice')) return result([{ categoryCode: '00', total: 2 }])
      return result({ total: 2, items: [] })
    },
  })
  await assert.rejects(client.fetchBoardDirect(), /分页不完整/)
})
