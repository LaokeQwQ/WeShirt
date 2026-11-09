// 机器人指令：帮助/help、未知输入提示、单聊与群聊差异
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { parseCommand, buildHelpText, UNKNOWN_COMMAND_REPLY } from '../packages/core/dingtalk.js'

const SECRET = 's'.repeat(32)

function makeApp() {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET } })
  const call = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers }
    if (body) h['content-type'] = 'application/json'
    const r = await app.fetch(
      new Request('http://x' + path, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
      })
    )
    const text = await r.text()
    let j = null
    try {
      j = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, j, text }
  }
  return { store, call }
}

// 造一条机器人消息（明文 HTTP 模式），conversationType 1=单聊 2=群聊
function robotMsg(text, { convType = '2', convId = 'cidX==', title = '' } = {}) {
  return {
    msgtype: 'text',
    text: { content: text },
    senderId: 'sender_x',
    senderNick: '某同学',
    conversationType: convType,
    conversationId: convId,
    conversationTitle: title,
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x',
  }
}

// ---------- parseCommand ----------

test('帮助命令的多种写法都认', () => {
  for (const t of ['帮助', 'help', 'HELP', 'Help', '指令', '菜单', '?', '？', ' 帮助 ']) {
    assert.deepEqual(parseCommand(t), { cmd: 'help', arg: null }, t)
  }
})

test('未知输入一律返回 null（由调用方给出统一提示）', () => {
  for (const t of ['今天天气', 'asdf', '帮助我一下好不好呀这是什么', '1', '']) {
    const r = parseCommand(t)
    // 「帮助我…」按前缀会被当成 help，这是可接受的宽匹配；
    // 这里只断言非前缀匹配的乱码是 null
    if (t.startsWith('帮助')) continue
    assert.equal(r.cmd, null, `"${t}" 应无法识别`)
  }
})

// ---------- 帮助回复 ----------

test('指令错误文案与用户要求的完全一致', () => {
  assert.equal(UNKNOWN_COMMAND_REPLY, '指令错误，请回复「帮助」查看帮助')
})

test('帮助文案：明文模式只列真能用的命令，并给出网页地址', () => {
  const t = buildHelpText({ plainMode: true, host: 'laundry.example.test' })
  assert.match(t, /查 —— 各楼层机器空闲情况/)
  assert.match(t, /帮助 —— 显示这条说明/)
  assert.match(t, /laundry\.example\.test/)
  // 明文模式下写操作会被拒，帮助里不能出现这些命令
  assert.ok(!t.includes('提醒开'), '不该列出会被拒绝的命令')
  assert.ok(!t.includes('解绑'), '不该列出会被拒绝的命令')
})

test('帮助文案：密文模式才列绑定/提醒相关命令', () => {
  const t = buildHelpText({ plainMode: false })
  assert.match(t, /提醒开/)
  assert.match(t, /解绑/)
  assert.ok(!t.includes('网页'), '密文模式不需要引导去网页')
})

test('帮助文案不带 host 时不会留空行尾巴', () => {
  const t = buildHelpText({ plainMode: true, host: '' })
  assert.ok(!t.endsWith('\n'))
})

test('群里发「帮助」会回复指令清单', async () => {
  const { call, store } = makeApp()
  await call('POST', '/api/dingtalk/callback', { body: robotMsg('帮助') })
  const trace = await store.get('ding:lastCallback', null)
  assert.equal(trace.cmd, 'help')
})

test('单聊发「help」同样能识别（不需要身份）', async () => {
  const { call, store } = makeApp()
  await call('POST', '/api/dingtalk/callback', {
    body: robotMsg('help', { convType: '1', convId: 'cidDM==' }),
  })
  const trace = await store.get('ding:lastCallback', null)
  assert.equal(trace.cmd, 'help')
  assert.equal(trace.conversationType, '1')
})

// ---------- 未知输入 ----------

test('未知输入标记为 unknown 并仍然 ack', async () => {
  const { call, store } = makeApp()
  const r = await call('POST', '/api/dingtalk/callback', { body: robotMsg('今天天气不错') })
  assert.equal(r.status, 200, '钉钉要求回调必须 ack')
  const trace = await store.get('ding:lastCallback', null)
  assert.equal(trace.cmd, 'unknown')
})

test('空消息 / 图片消息也走未知分支而不是崩掉', async () => {
  const { call, store } = makeApp()
  await call('POST', '/api/dingtalk/callback', {
    body: { ...robotMsg(''), msgtype: 'picture' },
  })
  const trace = await store.get('ding:lastCallback', null)
  assert.equal(trace.cmd, 'unknown')
})

// ---------- 单聊 / 群聊统计 ----------

test('单聊与群聊分别计数，便于判断单聊是否可用', async () => {
  const { call, store } = makeApp()
  await call('POST', '/api/dingtalk/callback', { body: robotMsg('查', { convType: '2', convId: 'cidG==' }) })
  await call('POST', '/api/dingtalk/callback', { body: robotMsg('查', { convType: '2', convId: 'cidG==' }) })
  await call('POST', '/api/dingtalk/callback', { body: robotMsg('查', { convType: '1', convId: 'cidD==' }) })

  const s = await store.get('ding:cbStats', null)
  assert.equal(s.group.count, 2)
  assert.equal(s.dm.count, 1)
  assert.ok(s.dm.lastAt, '要记录最后一次时间')
})

test('debug 接口暴露单聊/群聊统计与已记录群会话', async () => {
  const { call } = makeApp()
  await call('POST', '/api/dingtalk/callback', { body: robotMsg('查', { convType: '2', convId: 'cidG==', title: '洗衣房群' }) })
  const r = await call('GET', '/api/debug/dingtalk?token=test-admin-token')
  assert.equal(r.status, 200)
  assert.equal(r.j.cbStats.group.count, 1)
  assert.equal(r.j.cbStats.dm.count, 0)
  assert.equal(r.j.groupConv.conversationId, 'cidG==')
})

// ---------- 写操作在明文回调下仍然拒绝 ----------

test('单聊里发「提醒关」也不会改设置（明文回调无法验证身份）', async () => {
  const { call, store } = makeApp()
  await store.put('user:u_1', { id: 'u_1', nick: '某人', dingUserId: 'sender_x', notifyOn: true })
  await store.put('userByDing:sender_x', 'u_1')

  await call('POST', '/api/dingtalk/callback', {
    body: robotMsg('提醒关', { convType: '1', convId: 'cidD==' }),
  })
  const u = await store.get('user:u_1', null)
  assert.equal(u.notifyOn, true, '不能因为伪造的 senderId 就改掉真实设置')
  const trace = await store.get('ding:lastCallback', null)
  assert.equal(trace.bindRejected, 'plain_callback_unsigned')
})
