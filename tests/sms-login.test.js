// 短信验证码登录（半自动）：人收码、人填码，服务端只做两次转发
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { parseLoginConfig, sendLoginCode, verifyLoginCode } from '../packages/core/haier.js'

const SECRET = 's'.repeat(32)
const ADMIN = 'test-admin-token'

function makeJwt(expSec) {
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
}

// 假的海尔登录接口：发码永远成功，校验码 123456 才给 token
async function withLoginServer(fn) {
  const seen = { sent: [], verified: [] }
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {}
      if (req.url === '/sms/send') {
        seen.sent.push(json)
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ code: 0, message: 'ok' }))
      }
      if (req.url === '/login/sms') {
        seen.verified.push(json)
        res.setHeader('content-type', 'application/json')
        if (json.code !== '123456') return res.end(JSON.stringify({ code: 4001, message: '验证码错误' }))
        return res.end(
          JSON.stringify({ code: 0, data: { token: makeJwt(Math.floor(Date.now() / 1000) + 86400 * 7) } })
        )
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    return await fn(`http://127.0.0.1:${port}`, seen)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

function loginEnv(base) {
  return JSON.stringify({
    sendUrl: `${base}/sms/send`,
    sendBody: { phone: '{{phone}}', scene: 'login' },
    verifyUrl: `${base}/login/sms`,
    verifyBody: { phone: '{{phone}}', code: '{{code}}' },
    tokenPath: 'data.token',
    headers: { appId: 'demo' },
  })
}

async function makeApp(env = {}, seed) {
  const store = createMemoryStore()
  const app = createApp({
    store,
    env: { ADMIN_TOKEN: ADMIN, BUILDING_ID: 'b1', AUTH_SECRET: SECRET, HAIER_MODE: 'mock', ...env },
  })
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
  return { store, call, A: { 'x-admin-token': ADMIN } }
}

// ---------- 配置解析 ----------

test('没配 HAIER_LOGIN 时返回 null，不瞎猜接口', () => {
  assert.equal(parseLoginConfig({}), null)
  assert.equal(parseLoginConfig({ HAIER_LOGIN: 'not-json' }), null)
  assert.equal(parseLoginConfig({ HAIER_LOGIN: '{"sendUrl":"x"}' }), null, '缺 verifyUrl 不算配置好')
})

test('非 https 的公网地址被拒（防止明文发手机号）', () => {
  const bad = JSON.stringify({ sendUrl: 'http://evil.com/a', verifyUrl: 'https://x/b' })
  assert.equal(parseLoginConfig({ HAIER_LOGIN: bad }), null)
})

// ---------- 模板 ----------

test('模板只替换 {{phone}} / {{code}}，其余原样', async () => {
  await withLoginServer(async (base, seen) => {
    const env = { HAIER_LOGIN: loginEnv(base) }
    await sendLoginCode(env, '13800138000')
    assert.deepEqual(seen.sent[0], { phone: '13800138000', scene: 'login' })
  })
})

test('手机号/验证码格式不对直接拒，不打接口', async () => {
  await withLoginServer(async (base, seen) => {
    const env = { HAIER_LOGIN: loginEnv(base) }
    await assert.rejects(() => sendLoginCode(env, '123'), /手机号/)
    await assert.rejects(() => verifyLoginCode(env, '13800138000', 'abc'), /验证码/)
    assert.equal(seen.sent.length, 0)
    assert.equal(seen.verified.length, 0)
  })
})

test('验证码错误时把上游错误透出来', async () => {
  await withLoginServer(async (base) => {
    const env = { HAIER_LOGIN: loginEnv(base) }
    await assert.rejects(() => verifyLoginCode(env, '13800138000', '000000'), /4001|验证码错误/)
  })
})

test('验证成功按 tokenPath 取到 token', async () => {
  await withLoginServer(async (base) => {
    const env = { HAIER_LOGIN: loginEnv(base) }
    const r = await verifyLoginCode(env, '13800138000', '123456')
    assert.match(r.token, /^eyJ/)
  })
})

// ---------- 接口 ----------

test('未配置登录接口时返回可追溯501，不公开内部配置细节', async () => {
  const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["a"]' })
  const r = await call('POST', '/api/admin/accounts/send-code', { headers: A, body: { phone: '13800138000' } })
  assert.equal(r.status, 501)
  assert.equal(r.j.error.status, 501)
  assert.match(r.j.error.eventId, /^evt_[a-f0-9]+$/)
  assert.equal(r.j.error.message.includes('HAIER_LOGIN'), false)
})

test('发码：同号码 60 秒内只能发一次', async () => {
  await withLoginServer(async (base) => {
    const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["a"]', HAIER_LOGIN: loginEnv(base) })
    const r1 = await call('POST', '/api/admin/accounts/send-code', { headers: A, body: { phone: '13800138000' } })
    assert.equal(r1.status, 200, r1.text)
    const r2 = await call('POST', '/api/admin/accounts/send-code', { headers: A, body: { phone: '13800138000' } })
    assert.equal(r2.status, 429)
  })
})

test('登录成功：token 写进池子，返回剩余天数，不回传 token', async () => {
  await withLoginServer(async (base) => {
    const { call, A } = await makeApp({ HAIER_ACCOUNTS: '["old"]', HAIER_LOGIN: loginEnv(base) })
    const r = await call('POST', '/api/admin/accounts/login', {
      headers: A,
      body: { phone: '13800138000', code: '123456', index: 1 },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.j.accounts[0].source, 'kv')
    assert.equal(r.j.accounts[0].label, '8000')
    assert.ok(r.j.accounts[0].daysLeft >= 6)
    assert.ok(!r.text.includes('eyJ'), '不能把 token 回传')
  })
})

test('验证码错时接口报 502 且不写池子', async () => {
  await withLoginServer(async (base) => {
    const { store, call, A } = await makeApp({ HAIER_ACCOUNTS: '["old"]', HAIER_LOGIN: loginEnv(base) })
    const r = await call('POST', '/api/admin/accounts/login', {
      headers: A,
      body: { phone: '13800138000', code: '000000', index: 1 },
    })
    assert.equal(r.status, 502)
    assert.equal(await store.get('meta:haierTokens', null), null)
  })
})

test('登录接口需要管理员口令', async () => {
  const { call } = await makeApp({ HAIER_ACCOUNTS: '["a"]' })
  const r = await call('POST', '/api/admin/accounts/login', { body: { phone: '13800138000', code: '123456' } })
  assert.equal(r.status, 401)
})
