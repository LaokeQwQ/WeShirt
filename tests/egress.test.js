// 出口池：账号池与代理池共用的选择 / 推进逻辑（纯函数）
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickIndex, nextState, parseProxyPool, maskProxy } from '../packages/core/egress.js'

// ---------- 选择 ----------

test('空池返回 -1，不会越界', () => {
  assert.equal(pickIndex(0, { idx: 0 }), -1)
  assert.equal(pickIndex(undefined, null), -1)
})

test('从当前下标开始挑第一个可用的', () => {
  assert.equal(pickIndex(3, { idx: 1 }, 1000), 1)
  assert.equal(pickIndex(3, { idx: 2 }, 1000), 2)
})

test('跳过冷却中的下标', () => {
  const now = 1000
  const state = { idx: 0, cool: { 0: now + 5000 } }
  assert.equal(pickIndex(3, state, now), 1)
})

test('下标会被回绕（idx 超界也不炸）', () => {
  assert.equal(pickIndex(3, { idx: 7 }, 1000), 1)
  assert.equal(pickIndex(3, { idx: -1 }, 1000), 2)
})

test('全部冷却时挑最早解冻的（不能停摆）', () => {
  const now = 1000
  const state = { idx: 0, cool: { 0: now + 9000, 1: now + 2000, 2: now + 5000 } }
  assert.equal(pickIndex(3, state, now), 1)
})

// ---------- 推进 ----------

test('成功：清除该下标冷却，下标前移', () => {
  const st = nextState({ idx: 0, cool: { 0: 1 } }, 0, 2, { ok: true, now: 1000 })
  assert.deepEqual(st, { idx: 1, cool: {} })
})

test('失败：冷却该下标，下标前移', () => {
  const st = nextState({ idx: 0, cool: {} }, 0, 3, { ok: false, cooldownMs: 60000, now: 1000 })
  assert.equal(st.idx, 1)
  assert.equal(st.cool['0'], 61000)
})

test('只有一个下标时失败不冷却（否则自己锁死自己）', () => {
  const st = nextState({ idx: 0, cool: {} }, 0, 1, { ok: false, cooldownMs: 60000, now: 1000 })
  assert.equal(st.idx, 0)
  assert.deepEqual(st.cool, {})
})

test('成功后会清掉之前残留的冷却记录', () => {
  const st = nextState({ idx: 2, cool: { 2: 9 } }, 2, 3, { ok: true, now: 1000 })
  assert.equal(st.cool['2'], undefined)
})

// ---------- 代理池解析 ----------

test('代理池：字符串数组', () => {
  const pool = parseProxyPool({ HAIER_PROXIES: '["http://1.2.3.4:8080","https://5.6.7.8:3128"]' })
  assert.equal(pool.length, 2)
  assert.equal(pool[0].url, 'http://1.2.3.4:8080')
})

test('代理池：对象数组', () => {
  const pool = parseProxyPool({ HAIER_PROXIES: '[{"url":"http://1.2.3.4:8080"}]' })
  assert.equal(pool.length, 1)
})

test('代理池：过滤非法协议与重复项', () => {
  const pool = parseProxyPool({
    HAIER_PROXIES: '["socks5://1.1.1.1:1","http://2.2.2.2:2","http://2.2.2.2:2","nonsense"]',
  })
  assert.equal(pool.length, 1, '只保留合法且去重后的 http(s)')
  assert.equal(pool[0].url, 'http://2.2.2.2:2')
})

test('代理池：坏 JSON 返回空数组，不抛错', () => {
  assert.deepEqual(parseProxyPool({ HAIER_PROXIES: 'not-json' }), [])
  assert.deepEqual(parseProxyPool({}), [])
})

test('maskProxy 不泄露账号密码', () => {
  const masked = maskProxy('http://user:secret@1.2.3.4:8080')
  assert.ok(!masked.includes('user'))
  assert.ok(!masked.includes('secret'))
  assert.equal(masked, 'http://1.2.3.4:8080')
})
