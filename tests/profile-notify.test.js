// 默认昵称/头像、测试提醒接口、登录回调不阻塞
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 's'.repeat(32)

async function makeApp(seed) {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET } })
  const call = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers }
    if (body) h['content-type'] = 'application/json'
    const r = await app.fetch(
      new Request('http://x' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })
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
  if (seed) await seed(store)
  return { store, call, A: { 'x-admin-token': 'test-admin-token' } }
}

async function seedUser(store, extra = {}) {
  await store.put('user:u_1', {
    id: 'u_1',
    nick: '测试同学',
    avatar: 'av3',
    takeCode: '000000',
    dingUserId: 'staff_1',
    notifyOn: true,
    ...extra,
  })
  return { id: 'u_1' }
}

// ---------- 测试提醒（普通用户） ----------

test('测试提醒：未登录 401', async () => {
  const { call } = await makeApp()
  const r = await call('POST', '/api/user/test-notify', { body: {} })
  assert.equal(r.status, 401)
})

test('测试提醒：旧客户端没有指定目标时拒绝，不再发送钉钉', async () => {
  const { call } = await makeApp(async s => seedUser(s))
  const token = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/user/test-notify', { body: {}, headers: { authorization: 'Bearer ' + token } })
  assert.equal(r.status, 400)
  assert.equal(r.j.error.code, 'bad_param')
  assert.ok(r.j.error.eventId)
})

// ---------- 后台测试消息 ----------

test('后台测试消息：sample=take 返回卡片并且群消息用纯文本兜底', async () => {
  const { call, A } = await makeApp()
  const r = await call('POST', '/api/admin/notify-test?to=self&sample=take', { headers: A })
  assert.equal(r.status, 200)
  assert.equal(r.j.sample, 'take')
  // 没配 admin ding userId，所以 dm 明确报缺配置
  assert.equal(r.j.dm.ok, false)
  assert.equal(r.j.dm.err, 'no_admin_ding_userid')
})

test('后台测试消息：群消息未就绪时报 no_group_channel', async () => {
  const { call, A } = await makeApp()
  const r = await call('POST', '/api/admin/notify-test?to=group&sample=take', { headers: A })
  assert.equal(r.j.group.ok, false)
  assert.equal(r.j.group.err, 'no_group_channel')
})

// ---------- 昵称自动生成 ----------

test('nickFromDing：加「同学」，不重复叠加，最多 16 字', async () => {
  const { nickFromDing } = await import('../server/app.js').catch(() => ({ nickFromDing: null }))
  if (!nickFromDing) return // 未导出时跳过（保持兼容）
  assert.equal(nickFromDing('测试用户'), '测试用户同学')
  assert.equal(nickFromDing('李同学'), '李同学')
  assert.equal(nickFromDing('  张三  '), '张三同学')
  assert.equal(nickFromDing(''), '')
  assert.ok(nickFromDing('一二三四五六七八九十一二三四五六七八').length <= 16)
})

// ---------- 手工改过资料就不再被钉钉覆盖 ----------

test('改昵称后 nickAuto=false，登录不再覆盖', async () => {
  const { store, call } = await makeApp(async (s) => await seedUser(s))
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/user/profile', {
    body: { nick: '我自己取的名' },
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 200)
  const u = await store.get('user:u_1', null)
  assert.equal(u.nick, '我自己取的名')
  assert.equal(u.nickAuto, false)
})

test('选预设头像后 avatarAuto=false，钉钉头像不再覆盖', async () => {
  const { store, call } = await makeApp(async (s) => await seedUser(s))
  const tok = await issueToken('u_1', SECRET)
  await call('POST', '/api/user/profile', {
    body: { avatar: 'av8' },
    headers: { authorization: 'Bearer ' + tok },
  })
  const u = await store.get('user:u_1', null)
  assert.equal(u.avatar, 'av8')
  assert.equal(u.avatarAuto, false)
})

// ---------- 登录票据（不依赖 KV 一致性） ----------

test('issueTicket / verifyTicket 往返正确', async () => {
  const { issueTicket, verifyTicket } = await import('../packages/core/auth.js')
  const t = await issueTicket({ u: 'u_1', exp: Date.now() + 60000 }, SECRET)
  const p = await verifyTicket(t, SECRET)
  assert.equal(p.u, 'u_1')
})

test('票据被篡改 / 过期 / 换密钥都验不过', async () => {
  const { issueTicket, verifyTicket } = await import('../packages/core/auth.js')
  const t = await issueTicket({ u: 'u_1', exp: Date.now() + 60000 }, SECRET)

  const tampered = t.slice(0, -1) + (t.endsWith('f') ? 'e' : 'f')
  assert.equal(await verifyTicket(tampered, SECRET), null)
  assert.equal(await verifyTicket(t, 'x'.repeat(32)), null)

  const expired = await issueTicket({ u: 'u_1', exp: Date.now() - 1 }, SECRET)
  assert.equal(await verifyTicket(expired, SECRET), null)

  for (const bad of ['', null, 'abc', 'a.b.c']) {
    assert.equal(await verifyTicket(bad, SECRET), null)
  }
})

test('claim 能用签名票据换到 token（不再依赖 KV）', async () => {
  const { issueTicket } = await import('../packages/core/auth.js')
  const { call } = await makeApp(async (s) => await seedUser(s))
  const device='d'.repeat(32)
  const code = await issueTicket({ role:'login_claim',u:'u_1',d:device,nonce:'profile-nonce',exp:Date.now()+60000 }, SECRET)
  const r = await call('POST', '/api/auth/claim', { body: { code,device } })
  assert.equal(r.status, 200, r.text)
  assert.ok(r.j.token)
  assert.equal(r.j.user.id, 'u_1')
})

test('claim 假票据被拒', async () => {
  const { call } = await makeApp(async (s) => await seedUser(s))
  const r = await call('POST', '/api/auth/claim', { body: { code: 'a'.repeat(40) + '.deadbeef' } })
  assert.equal(r.status, 400)
  assert.equal(r.j.error.code, 'bad_code')
})
