import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTakeNotice, buildStuckNotice, buildUrgeNotice, buildWelcomeText, buildMachineLabel, NOTICE_TEMPLATES } from '../packages/core/notice.js'
import { buildBindReply, buildHelpText, buildStatusReply } from '../packages/core/dingtalk.js'

const END = '2026-11-09T10:30:00Z'

test('后台机位和可信类型优先，别名烘干机使用烘干文案', () => {
  const notice = buildTakeNotice({ machineName: '柳园西', slot: 'D1', kind: 'dryer', endAt: END, leftMin: 5, variant: 0 })
  assert.match(notice.title, /快烘好了/)
  assert.match(notice.text, /1号烘干机/)
  assert.ok(!notice.text.includes('柳园西'))
  assert.match(notice.text, /预计 18:30 结束/)
  assert.equal(buildMachineLabel({ machineLabel: '桂园 · 2号烘干机', slot: 'D1' }), '桂园 · 2号烘干机')
  assert.equal(buildMachineLabel({ slot: '3', kind: 'washer', machineName: '别名' }), '3号洗衣机')
})

test('计时到期不声称上游已完成，真实完成区分洗衣和烘干', () => {
  const timer = buildTakeNotice({ slot: 'D2', kind: 'dryer', confirmed: false, endAt: END, estimated: true })
  assert.match(timer.title, /烘干计时结束/)
  for (const value of [timer.markdown, timer.text]) {
    assert.match(value, /请先确认现场是否完成/)
    assert.match(value, /预计结束 18:30（估时）/)
    assert.ok(!value.includes('烘好了') && !value.includes('洗好了'))
  }
  assert.match(buildTakeNotice({ kind: 'dryer', confirmed: true }).title, /烘好了/)
  assert.match(buildTakeNotice({ kind: 'washer', confirmed: true }).title, /洗好了/)
})

test('所有模板的纯文本与卡片都包含相同时间、设备及取衣动作', () => {
  for (const leftMin of [5, null]) {
    const variants = leftMin ? NOTICE_TEMPLATES.BEFORE_LINES : NOTICE_TEMPLATES.DONE_LINES
    for (let variant = 0; variant < variants.length; variant++) {
      const notice = buildTakeNotice({ machineLabel: '3号洗衣机', floorCode: '1', leftMin, endAt: END, variant })
      for (const value of [notice.text, notice.markdown]) {
        assert.match(value, /3号洗衣机 · 1 楼/)
        assert.match(value, /18:30/)
        assert.match(value, /「我的洗衣」里点「我已取衣」/)
        if (leftMin) assert.match(value, /5 分钟/)
      }
      const plainBody = notice.text.split('\n').slice(2)
      const richBody = notice.markdown.split('\n\n').slice(2)
      assert.deepEqual(plainBody, richBody)
    }
  }
})

test('异常提醒只描述观测时间并要求现场确认，不推断断电原因', () => {
  const notice = buildStuckNotice({ slot: 'D1', kind: 'dryer', leftMin: 42, stuckMin: 12, variant: 0 })
  for (const value of [notice.text, notice.markdown]) {
    assert.match(value, /42 分钟/)
    assert.match(value, /12 分钟未变化/)
    assert.match(value, /数据延迟/)
    assert.match(value, /现场确认/)
    assert.ok(!/跳闸|断电|插头|十几分钟/.test(value))
  }
  const missing = buildStuckNotice()
  assert.ok(!/undefined|NaN|Infinity/.test(missing.text))
})

test('催取文案保留次数与操作，不催骂或宣称一定有人排队', () => {
  const notice = buildUrgeNotice({ slot: 'D1', count: 3, variant: 0 })
  for (const value of [notice.text, notice.markdown]) {
    assert.match(value, /1号烘干机/)
    assert.match(value.replaceAll('**', ''), /第 3 次取衣提醒/)
    assert.match(value, /我已取衣/)
    assert.ok(!/赶紧|红点|这已经|后面还有人排着/.test(value))
  }
})

test('欢迎与绑定结果不泄露账号身份，帮助只展示当前能用的指令', () => {
  const welcome = buildWelcomeText({ userId: 'u_private', nick: '小明' })
  assert.match(welcome, /选择住宿楼/)
  assert.match(welcome, /登记洗衣或烘干/)
  assert.match(welcome, /我已取衣/)
  assert.ok(!welcome.includes('u_private'))
  for (const ok of [true, false]) {
    const reply = buildBindReply('staff_private', { id: 'u_private', nick: '小明' }, ok)
    assert.ok(!/staff_private|u_private|账号 ID|staffId/.test(reply))
  }
  const plain = buildHelpText({ plainMode: true, host: 'weshirt.example' })
  assert.ok(!/认领|提醒开|解绑|已取 ——/.test(plain))
  assert.match(plain, /weshirt.example/)
  assert.match(buildHelpText({ plainMode: false }), /认领 D1/)
})

test('状态回复按北京时间显示刷新时间，区分烘干机并提示陈旧数据', () => {
  const board = { updatedAt: END, floors: [{ code: '1F', machines: [
    { kind: 'washer', state: 'idle' },
    { kind: 'dryer', name: '别名设备', state: 'idle' },
    { kind: 'dryer', state: 'occupied' },
  ] }] }
  const fresh = buildStatusReply(board, { at: new Date(END).getTime() + 60000 })
  assert.match(fresh, /更新于 18:30/)
  assert.match(fresh, /洗衣机 1\/1 空闲/)
  assert.match(fresh, /烘干机 1\/2 空闲/)
  assert.ok(!fresh.includes('未更新'))
  const stale = buildStatusReply(board, { at: new Date(END).getTime() + 8 * 60000 })
  assert.match(stale, /已 8 分钟未更新/)
  assert.match(stale, /以现场为准/)
})
