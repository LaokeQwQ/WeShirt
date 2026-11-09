// 群播报文案：合并成一条 markdown，按机位编号，去重、分块
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBoardDigest, machineNoOf } from '../packages/core/notice.js'

const m = (id, name, mins = 20) => ({
  id,
  name,
  finishAt: new Date(Date.now() + mins * 60000).toISOString(),
})
const ev = (type, machine) => ({ type, machine })
const slots = { a: '3', b: '7', c: 'D1' }

test('没有任何事件时返回 null（不白发一条空消息）', () => {
  assert.equal(buildBoardDigest({}), null)
  assert.equal(buildBoardDigest({ started: [], idle: [], fault: [] }), null)
})

test('机号解析兼容烘干机', () => {
  assert.equal(machineNoOf('桂园1楼7号机'), 7)
  assert.equal(machineNoOf('桂园1楼7号烘干机'), 7)
  assert.equal(machineNoOf('柳园1楼烘干2号机。'), 2)
})

test('编号说人话：洗衣机 / 烘干机', () => {
  const md = buildBoardDigest({
    started: [ev('started', m('a', '桂园1楼7号机'))],
    idle: [ev('becameIdle', m('c', '桂园1楼7号烘干机'))],
    slotById: slots,
    at: Date.now(),
  })
  assert.match(md.text, /3号洗衣机/)
  assert.match(md.text, /1号烘干机/)
  assert.ok(!md.text.includes('号位'), '不再出现「号位」这种说法')
  assert.ok(!md.text.includes('桂园1楼7号机'), '有机位号时不写机器名')
})

test('明细换行，不挤在一行', () => {
  const md = buildBoardDigest({
    started: [ev('started', m('a', '桂园1楼7号机'))],
    slotById: slots,
  })
  const lines = md.text.split('\n')
  assert.ok(lines.includes('- 3号洗衣机'), '机器单独一行')
  assert.ok(
    lines.some((l) => l.startsWith('  ') && l.includes('认领 3')),
    '明细在下一行（缩进）'
  )
})

test('洗完 / 故障用短句，不写「去拿」', () => {
  const md = buildBoardDigest({
    idle: [ev('becameIdle', m('b', '桂园1楼4号机'))],
    fault: [ev('fault', m('c', '桂园1楼6号机'))],
    slotById: slots,
  })
  assert.match(md.text, /7号洗衣机/)
  assert.match(md.text, /洗好了/)
  assert.match(md.text, /1号烘干机/)
  assert.ok(md.text.includes('故障'), '故障只报状态')
  assert.ok(!md.text.includes('先别用'), '不再给建议')
  assert.ok(!md.text.includes('去拿'), '不再命令用户去拿')
  assert.ok(!md.text.includes('>'), '不挂总结引用块')
})

test('同一台机器重复事件只出现一次', () => {
  const md = buildBoardDigest({
    started: [ev('started', m('a', '桂园1楼7号机')), ev('started', m('a', '桂园1楼7号机'))],
    slotById: slots,
  })
  assert.equal(md.text.split('3号洗衣机').length - 1, 1)
})

test('多台合并成一条，不一台一条', () => {
  const list = Array.from({ length: 5 }, (_, i) => ev('started', m('x' + i, `桂园1楼${i + 1}号机`)))
  const md = buildBoardDigest({ started: list })
  assert.equal(md.text.split('\n').filter((l) => l.startsWith('- ')).length, 5)
  assert.match(md.title, /洗衣房动态/)
})

test('超过上限时提示还有几台', () => {
  const list = Array.from({ length: 12 }, (_, i) => ev('started', m('y' + i, `桂园1楼${i + 1}号机`)))
  const md = buildBoardDigest({ started: list, maxPerSection: 8 })
  assert.match(md.text, /另外还有 4 台/)
})
