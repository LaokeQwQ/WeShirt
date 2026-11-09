// WeShirt haier/machines 单元测试（node:test + node:assert）
// 运行：node --test tests/haier.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MOCK_MACHINES,
  DEFAULT_STATE_MAP,
  normalizeMachines,
  createHaierClient,
  parseBeijing,
} from '../packages/core/haier.js'
import {
  computeLeftMin,
  buildBoard,
  diffEvents,
} from '../packages/core/machines.js'

const FLOORS = new Set(['1F', '2F', '3F'])

// 1) mock 拉取数量与字段完整性
test('mock fetchStatus 返回 ≥12 台且覆盖 3 个楼层', async () => {
  const client = createHaierClient({ HAIER_MODE: 'mock' })
  assert.equal(client.mode, 'mock')
  const list = await client.fetchStatus()
  assert.ok(Array.isArray(list))
  assert.ok(list.length >= 12, '至少 12 台')
  assert.equal(list.length, MOCK_MACHINES.length)
  const seen = new Set()
  for (const m of list) {
    assert.ok(typeof m.id === 'string' && m.id.length > 0)
    assert.ok(typeof m.name === 'string')
    assert.ok(FLOORS.has(m.floorCode), `floorCode 合法: ${m.floorCode}`)
    assert.ok(['idle', 'occupied', 'faulty'].includes(m.state))
    if (m.state === 'occupied') assert.ok(typeof m.finishAt === 'string')
    else assert.equal(m.finishAt, null)
    seen.add(m.floorCode)
  }
  assert.deepEqual([...seen].sort(), ['1F', '2F', '3F'])
})

// 2) mock 模式连续轮询能看到状态变化
test('mock 连续两次轮询状态会演进', async () => {
  const client = createHaierClient({ HAIER_MODE: 'mock' })
  const a = await client.fetchStatus()
  const b = await client.fetchStatus()
  const sig = (arr) => arr.map((m) => `${m.id}:${m.state}:${m.finishAt}`).join('|')
  // 至少字段结构稳定、且至少有一台 occupied 曾出现（演示用）
  assert.ok(b.every((m) => typeof m.id === 'string'))
  // 两次快照不完全一致（时间/调用驱动演进）
  assert.notEqual(sig(a), sig(b))
})

// 3) normalizeMachines 状态映射（含未知状态）
test('normalizeMachines 整数 state 映射与未知状态', () => {
  const raws = [
    { id: 'w1', name: 'W1', floorCode: '1F', state: 1, finishTime: '' },
    { id: 'w2', name: 'W2', floorCode: '1F', state: 2, finishTime: '' },
    { id: 'w3', name: 'W3', floorCode: '1F', state: 3, finishTime: '' },
    { id: 'w9', name: 'W9', floorCode: '1F', state: 99, finishTime: '' },
  ]
  const out = normalizeMachines(raws)
  assert.equal(out[0].state, 'idle')
  assert.equal(out[1].state, 'occupied')
  assert.equal(out[2].state, 'faulty')
  assert.equal(out[3].state, 'unknown')
})

// 3b) 自定义 stateMap：faulty 可含多值
test('normalizeMachines 支持自定义 stateMap（faulty:[2,3]）', () => {
  const raws = [
    { id: 'x1', state: 2, floorCode: '2F' },
    { id: 'x2', state: 3, floorCode: '2F' },
  ]
  const out = normalizeMachines(raws, { idle: [0], occupied: [1], faulty: [2, 3] })
  assert.equal(out[0].state, 'faulty')
  assert.equal(out[1].state, 'faulty')
})

// 3c) deviceId 作为 id 回退、缺失字段兜底
test('normalizeMachines 兼容 deviceId 与缺失字段', () => {
  const out = normalizeMachines([{ deviceId: 'd1', state: 0 }])
  assert.equal(out[0].id, 'd1')
  assert.equal(out[0].name, '')
  assert.equal(out[0].floorCode, '')
  assert.equal(out[0].finishAt, null)
})

// 4) finishTime 按北京时间解析
test('parseBeijing 把北京时间解析为 ISO', () => {
  assert.equal(parseBeijing('2026-10-18 08:00:00'), '2026-10-18T00:00:00.000Z')
  assert.equal(parseBeijing('2026-10-18T08:00:00'), '2026-10-18T00:00:00.000Z')
  assert.equal(parseBeijing('2026-10-18T08:00:00Z'), '2026-10-18T08:00:00.000Z')
  assert.equal(parseBeijing('2026-10-18T08:00:00+08:00'), '2026-10-18T00:00:00.000Z')
  assert.equal(parseBeijing(''), null)
  assert.equal(parseBeijing('不是时间'), null)
  assert.equal(parseBeijing(null), null)
})

// 5) computeLeftMin 边界
test('computeLeftMin 边界：null/非法/正数/负数/零', () => {
  const now = '2026-10-18T00:00:00.000Z'
  assert.equal(computeLeftMin(null, now), null)
  assert.equal(computeLeftMin('', now), null)
  assert.equal(computeLeftMin('invalid', now), null)
  assert.equal(computeLeftMin('2026-10-18T00:30:00.000Z', now), 30)
  assert.equal(computeLeftMin('2026-10-17T23:00:00.000Z', now), -60)
  assert.equal(computeLeftMin('2026-10-18T00:00:00.000Z', now), 0)
  // 非法 now
  assert.equal(computeLeftMin('2026-10-18T00:30:00.000Z', 'bad'), null)
})

// 6) buildBoard 分组与计数
test('buildBoard 按楼层分组并计数', () => {
  const future = new Date(Date.now() + 30 * 60000).toISOString()
  const machines = [
    { id: '1F-01', name: 'a', floorCode: '1F', state: 'idle', finishAt: null },
    { id: '1F-02', name: 'b', floorCode: '1F', state: 'occupied', finishAt: future },
    { id: '3F-01', name: 'c', floorCode: '3F', state: 'faulty', finishAt: null },
    { id: '2F-01', name: 'd', floorCode: '2F', state: 'idle', finishAt: null },
  ]
  const board = buildBoard(machines, { buildingId: 'b1', buildingName: '一号楼' })
  assert.equal(board.buildingId, 'b1')
  assert.equal(board.buildingName, '一号楼')
  assert.equal(board.total, 4)
  assert.equal(board.idle, 2)
  assert.equal(board.occupied, 1)
  assert.equal(board.faulty, 1)
  // 楼层排序 1F < 2F < 3F
  assert.deepEqual(board.floors.map((f) => f.code), ['1F', '2F', '3F'])
  assert.equal(board.floors[0].machines.length, 2)
  // occupied 机器带有效 leftMin
  const occ = board.floors[0].machines.find((m) => m.id === '1F-02')
  assert.ok(typeof occ.leftMin === 'number' && occ.leftMin > 0)
  // idle 机器 leftMin 为 null
  const idl = board.floors[0].machines.find((m) => m.id === '1F-01')
  assert.equal(idl.leftMin, null)
})

// 7) diffEvents 三类事件
test('diffEvents 产生 becameIdle / started / fault', () => {
  const prev = [
    { id: '1', state: 'occupied', finishAt: 'x' },
    { id: '2', state: 'idle', finishAt: null },
    { id: '3', state: 'idle', finishAt: null },
  ]
  const next = [
    { id: '1', state: 'idle', finishAt: null },
    { id: '2', state: 'occupied', finishAt: 'y' },
    { id: '3', state: 'faulty', finishAt: null },
  ]
  const events = diffEvents(prev, next)
  const types = events.map((e) => e.type).sort()
  assert.deepEqual(types, ['becameIdle', 'fault', 'started'])
  const became = events.find((e) => e.type === 'becameIdle')
  assert.equal(became.machine.id, '1')
})

// 7b) prev 为空不产生事件；无变化不产生事件
test('diffEvents prev 为空 / 无变化', () => {
  assert.deepEqual(diffEvents([], [{ id: '1', state: 'idle' }]), [])
  const same = [
    { id: '1', state: 'idle' },
    { id: '2', state: 'occupied' },
  ]
  assert.deepEqual(diffEvents(same, same), [])
})

// 8) 默认 stateMap 暴露正确
test('DEFAULT_STATE_MAP 符合契约', () => {
  assert.deepEqual(DEFAULT_STATE_MAP, { idle: [1], occupied: [2], faulty: [3] })
})

// 9) real 模式多点位流程：楼层 → 类别 → 设备明细，state 1/2/3 正确映射
test('real 模式多点位流程拉取并归一化设备', async () => {
  const realMap = { idle: [1], occupied: [2], faulty: [3] }
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push(String(url))
    const body = init && init.body ? JSON.parse(init.body) : null
    let data
    if (String(url).includes('/position/floorCodeList')) {
      data = ['1', '4']
    } else if (String(url).includes('/position/positionDevice')) {
      data = [
        { categoryCode: '00', categoryName: '洗衣机', total: 3, idleCount: 1 },
        { categoryCode: '02', categoryName: '烘干机', total: 0, idleCount: 0 },
      ]
    } else if (String(url).includes('/position/deviceDetailPage')) {
      // 楼层 1 返回 3 台；楼层 4 返回空
      const items =
        body.floorCode === '1'
          ? [
              { id: 900, deviceId: 5101, name: '1号机', floorCode: '1', state: 1, finishTime: null },
              {
                id: 901,
                deviceId: 5102,
                name: '2号机',
                floorCode: '1',
                state: 2,
                finishTime: '2026-10-19 22:30:00',
              },
              { id: 902, deviceId: 5103, name: '3号机', floorCode: '1', state: 3, finishTime: '' },
            ]
          : []
      data = { page: 1, pageSize: 100, total: items.length, items }
    } else {
      return { ok: false, status: 404, text: async () => '{}' }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, message: 'success', data }),
    }
  }

  const original = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    const client = createHaierClient({
      HAIER_MODE: 'real',
      HAIER_URL: 'https://yshz-user.haier-ioc.com/',
      HAIER_POSITION_ID: '90001',
      HAIER_HEADERS: '{"Authorization":"Bearer test"}',
      HAIER_STATE_MAP: JSON.stringify(realMap),
    })
    const list = await client.fetchStatus()
    assert.equal(list.length, 3)
    // id 取 deviceId（稳定），并按楼层/类别串联
    assert.deepEqual(list.map((m) => m.id), ['5101', '5102', '5103'])
    assert.deepEqual(list.map((m) => m.state), ['idle', 'occupied', 'faulty'])
    assert.equal(list[0].finishAt, null)
    assert.equal(list[1].finishAt, '2026-10-19T14:30:00.000Z')
    assert.equal(list[2].finishAt, null)
    assert.ok(list.every((m) => m.floorCode === '1'))
    // 只请求了有设备的类别（02 total=0 被跳过）
    const detailCalls = calls.filter((u) => u.includes('deviceDetailPage'))
    assert.equal(detailCalls.length, 2) // 楼层1×类别00 有数据后 break; 楼层4 空
  } finally {
    globalThis.fetch = original
  }
})

// 10) real 模式 code!==0 时抛错，由调用方保留旧状态
test('real 模式业务错误码抛错', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 205, message: '参数类型错误', data: null }),
  })
  try {
    const client = createHaierClient({
      HAIER_MODE: 'real',
      HAIER_URL: 'https://example.test',
      HAIER_POSITION_ID: '1',
    })
    await assert.rejects(() => client.fetchStatus(), /HAIER code 205/)
  } finally {
    globalThis.fetch = original
  }
})

// 11) HAIER_STATE_MAP 非法时回落默认表
test('HAIER_STATE_MAP 非法回落默认映射', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const data = String(url).includes('floorCodeList')
      ? ['1']
      : String(url).includes('positionDevice')
        ? [{ categoryCode: '00', total: 1 }]
        : { total: 1, items: [{ deviceId: 1, name: 'x', floorCode: '1', state: 1 }] }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data }),
    }
  }
  try {
    const client = createHaierClient({
      HAIER_MODE: 'real',
      HAIER_URL: 'https://example.test',
      HAIER_POSITION_ID: '1',
      HAIER_STATE_MAP: 'not-json',
    })
    const list = await client.fetchStatus()
    // 实测默认表 1=idle，与浏览器直连保持一致。
    assert.equal(list[0].state, 'idle')
  } finally {
    globalThis.fetch = original
  }
})
