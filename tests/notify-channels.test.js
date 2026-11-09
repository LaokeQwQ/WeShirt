// 提醒通道：私聊 / 群消息 / webhook
// 背景：admin/status 里的 robot:true 只代表凭证齐全，不代表真能发出去。
// 这里覆盖「通道选择逻辑」和「配置缺失时的降级」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'

const ADMIN = 'test-admin-token'

function makeApp(extraEnv = {}) {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: ADMIN, BUILDING_ID: 'b1', AUTH_SECRET: 's'.repeat(32), ...extraEnv },
  })
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
  return { store, call, A: { 'x-admin-token': ADMIN } }
}

// ---------- 通道自检 ----------

test('notify-check：全新环境里 dm/group 都未就绪', async () => {
  const { call, A } = makeApp()
  const r = await call('GET', '/api/admin/notify-check', { headers: A })
  assert.equal(r.status, 200)
  assert.equal(r.j.configured.appKey, false)
  assert.equal(r.j.channels.dm.ready, false)
  assert.equal(r.j.channels.group.ready, false)
  assert.equal(r.j.channels.group.automatic, false)
  assert.match(r.j.hint, /自动群播报已关闭/)
})

test('notify-check：有绑定用户才认为私聊可用', async () => {
  const { call, store, A } = makeApp({ DINGTALK_ROBOT_CODE: 'robot_x' })
  const before = await call('GET', '/api/admin/notify-check', { headers: A })
  assert.equal(before.j.channels.dm.ready, false, '没人绑钉钉就发不出去')

  await store.put('user:u_1', { id: 'u_1', nick: '有绑定', dingUserId: 'staff_1' })
  const after = await call('GET', '/api/admin/notify-check', { headers: A })
  assert.equal(after.j.channels.dm.ready, true)
  assert.equal(after.j.channels.dm.boundUsers, 1)
  assert.equal(after.j.boundUsers[0].dingUserId, 'staff_1')
})

test('notify-check：记录了群会话就认为群消息可用，且不泄露完整 id', async () => {
  const { call, store, A } = makeApp()
  await store.put('ding:groupConv', {
    conversationId: 'cidABCDEFGHIJKLMNOP==',
    title: '桂园洗衣房通知群',
    at: '2026-10-25T00:00:00Z',
  })
  const r = await call('GET', '/api/admin/notify-check', { headers: A })
  assert.equal(r.j.channels.group.ready, true)
  assert.equal(r.j.channels.group.via, 'conversation')
  assert.equal(r.j.channels.group.conversationTitle, '桂园洗衣房通知群')
  // 只回前 12 位加省略号，完整 id 不吐给前端
  assert.match(r.j.channels.group.conversationId, /…$/)
  assert.ok(!r.text.includes('cidABCDEFGHIJKLMNOP=='))
})

test('notify-check：配了 webhook 时优先报 webhook', async () => {
  const { call, store, A } = makeApp({ DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=x' })
  await store.put('ding:groupConv', { conversationId: 'cidZZZ==', at: '2026-10-25T00:00:00Z' })
  const r = await call('GET', '/api/admin/notify-check', { headers: A })
  assert.equal(r.j.channels.group.via, 'webhook')
})

// ---------- 发测试消息 ----------

test('notify-test：没配管理员 userId 时 dm 明确报 no_admin_ding_userid', async () => {
  const { call, A } = makeApp()
  const r = await call('POST', '/api/admin/notify-test?to=self', { headers: A })
  assert.equal(r.status, 200)
  assert.equal(r.j.dm.ok, false)
  assert.equal(r.j.dm.err, 'no_admin_ding_userid')
})

test('notify-test：没有任何群通道时给出 no_group_channel', async () => {
  const { call, A } = makeApp()
  const r = await call('POST', '/api/admin/notify-test?to=group', { headers: A })
  assert.equal(r.j.group.ok, false)
  assert.equal(r.j.group.err, 'no_group_channel')
})

test('notify-test 需要口令', async () => {
  const { call } = makeApp()
  const r = await call('POST', '/api/admin/notify-test')
  assert.equal(r.status, 401)
})

// ---------- 回调里记录群会话 ----------

test('群回调会记住 conversationId，单聊回调不会', async () => {
  const { call, store } = makeApp()
  const base = {
    msgtype: 'text',
    text: { content: '查' },
    senderId: 'someone',
    senderNick: '某同学',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x',
  }
  // 群聊
  await call('POST', '/api/dingtalk/callback', {
    body: { ...base, conversationType: '2', conversationId: 'cidGROUP==', conversationTitle: '洗衣房群' },
  })
  const conv = await store.get('ding:groupConv', null)
  assert.equal(conv.conversationId, 'cidGROUP==')
  assert.equal(conv.title, '洗衣房群')

  // 单聊：不能覆盖群 id（否则公共提醒会发错到某个人的单聊）
  await store.put('ding:groupConv', { conversationId: 'cidGROUP==', title: '洗衣房群', at: 'x' })
  await call('POST', '/api/dingtalk/callback', {
    body: { ...base, conversationType: '1', conversationId: 'cidPRIVATE==' },
  })
  const conv2 = await store.get('ding:groupConv', null)
  assert.equal(conv2.conversationId, 'cidGROUP==', '单聊不能覆盖群会话')
})

test('群回调的 trace 里能看出有没有 conversationId', async () => {
  const { call, store } = makeApp()
  await call('POST', '/api/dingtalk/callback', {
    body: {
      msgtype: 'text',
      text: { content: '查' },
      senderId: 's',
      conversationType: '2',
      conversationId: 'cidX==',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x',
    },
  })
  const trace = await store.get('ding:lastCallback', null)
  assert.equal(trace.hasConversationId, true)
})

// ---------- 迁移：烘干机跳闸通知走私聊 ----------

test('跳闸检测在无收件人时不崩（只是不发）', async () => {
  const { store } = makeApp()
  const { detectDryerStuck } = await import('../server/app.js')
  await store.put('dryerstuck:b1', {
    D1: { remain: 30, since: Date.now() - 20 * 60 * 1000, notifiedAt: 0 },
  })
  // 有占用登记，但用户没绑钉钉
  await store.put('occupancy:b1', { D1: { userId: 'u_x', nick: '没绑定' } })
  await store.put('user:u_x', { id: 'u_x', nick: '没绑定' })
  const n = await detectDryerStuck({ BUILDING_ID: 'b1' }, store, [
    { id: 'D1', name: '烘干机', state: 'occupied', leftMin: 30 },
  ])
  assert.equal(n, 0, '无收件人不算送达')
})
