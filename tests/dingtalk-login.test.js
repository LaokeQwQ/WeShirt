// 钉钉登录即身份：无匿名注册路径
// 背景：匿名身份只靠 localStorage 的 token 维持，换设备/清缓存就会变成另一个人。
// 现在身份只能由钉钉 OAuth 产生，/api/auth 只做「设备密钥换 token」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'

const SECRET = 's'.repeat(32)
const DEVICE_A = 'a'.repeat(32)
const DEVICE_B = 'b'.repeat(32)

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
  return { store, call, app }
}

// ---------- 没有匿名注册 ----------

test('/api/auth 不再建匿名用户：无设备密钥 → 401 need_login', async () => {
  const { call, store } = makeApp()
  const r = await call('POST', '/api/auth', { body: {} })
  assert.equal(r.status, 401)
  assert.equal(r.j.error.code, 'need_login')
  // 关键：不能悄悄建出一个用户
  const users = await store.list('user:')
  assert.equal(users.length, 0)
})

test('/api/auth 拒绝把 userId 当设备密钥', async () => {
  const { call, store } = makeApp()
  const r = await call('POST', '/api/auth', { body: { device: 'u_1rvr170b34' } })
  assert.equal(r.status, 401)
  assert.equal((await store.list('user:')).length, 0)

  const r2 = await call('POST', '/api/auth', { body: { uuid: 'u_1rvr170b34' } })
  assert.equal(r2.status, 401)
})

test('未绑定的随机设备密钥 → 401（不能凭空开户）', async () => {
  const { call } = makeApp()
  const r = await call('POST', '/api/auth', { body: { device: DEVICE_A } })
  assert.equal(r.status, 401)
  assert.equal(r.j.error.code, 'need_login')
})

test('设备密钥绑定过用户后可以续用', async () => {
  const { call, store } = makeApp()
  await store.put('user:u_1', { id: 'u_1', nick: '现有用户', takeCode: '000000' })
  await store.put(`userByDevice:${DEVICE_A}`, 'u_1')

  const a = await call('POST', '/api/auth', { body: { device: DEVICE_A } })
  assert.equal(a.status, 200)
  assert.equal(a.j.user.id, 'u_1')
  assert.ok(a.j.token)

  // 同设备再来一次还是同一身份（token 带时间戳所以会变）
  const b = await call('POST', '/api/auth', { body: { device: DEVICE_A } })
  assert.equal(b.j.user.id, 'u_1')
})

test('用户被删后设备密钥自动失效并清脏绑定', async () => {
  const { call, store } = makeApp()
  await store.put(`userByDevice:${DEVICE_B}`, 'u_gone') // 指向不存在的用户
  const r = await call('POST', '/api/auth', { body: { device: DEVICE_B } })
  assert.equal(r.status, 401)
  assert.equal(await store.get(`userByDevice:${DEVICE_B}`, null), null, '脏绑定要清掉')
})

// ---------- 退出登录 ----------

test('logout 解绑设备密钥，之后无法续用', async () => {
  const { call, store } = makeApp()
  await store.put('user:u_2', { id: 'u_2', nick: '某人', takeCode: '111111' })
  await store.put(`userByDevice:${DEVICE_A}`, 'u_2')

  const ok = await call('POST', '/api/auth/logout', { body: { device: DEVICE_A } })
  assert.equal(ok.status, 200)
  assert.equal(await store.get(`userByDevice:${DEVICE_A}`, null), null)

  const again = await call('POST', '/api/auth', { body: { device: DEVICE_A } })
  assert.equal(again.status, 401)
})

// ---------- 登录入口 ----------

test('login-url 需要 device 且不要求登录态', async () => {
  const { call } = makeApp()
  // 没配 APP_KEY → 503
  const noCfg = await call('GET', '/api/dingtalk/login-url?device=' + DEVICE_A)
  assert.equal(noCfg.status, 503)

  // 配了但没带 device → 400
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET, DINGTALK_APP_KEY: 'dingkey', DINGTALK_APP_SECRET: 'synthetic-secret' },
  })
  const r = await app.fetch(new Request('http://x/api/dingtalk/login-url'))
  assert.equal(r.status, 400)

  // 带上合法 device → 返回授权地址，且 state 里存的是 device（不是 userId）
  const r2 = await app.fetch(new Request('http://x/api/dingtalk/login-url?device=' + DEVICE_A))
  const j2 = await r2.json()
  assert.equal(r2.status, 200)
  assert.match(j2.url, /^https:\/\/login\.dingtalk\.com\/oauth2\/auth\?/)
  assert.match(j2.url, /client_id=dingkey/)

  const state = decodeURIComponent(j2.url.match(/state=([^&]+)/)[1])
  const rec = await store.get(`oauthstate:${state}`, null)
  assert.equal(rec.device, DEVICE_A)
  assert.ok(!('userId' in rec), 'state 里不该再有 userId（登录前没有用户）')
})

test('login-url 的 device 必须合法，user id 冒充不了', async () => {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET, DINGTALK_APP_KEY: 'dingkey', DINGTALK_APP_SECRET: 'synthetic-secret' },
  })
  const r = await app.fetch(new Request('http://x/api/dingtalk/login-url?device=u_1rvr170b34'))
  assert.equal(r.status, 400)
})

// ---------- 回调错误的导向 ----------

test('回调缺参数重定向到登录页而不是设置页', async () => {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET } })
  const r = await app.fetch(new Request('http://x/api/dingtalk/oauth-callback'))
  assert.equal(r.status, 302)
  const loc = r.headers.get('location')
  assert.match(loc, /#\/login\?e=missing/)
})

test('回调 state 无效也不泄露细节', async () => {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET } })
  const r = await app.fetch(
    new Request('http://x/api/dingtalk/oauth-callback?code=abc&state=nonexistent')
  )
  assert.equal(r.status, 302)
  assert.match(r.headers.get('location'), /#\/login\?e=state_invalid/)
})
