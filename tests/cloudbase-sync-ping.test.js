import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
const require = createRequire(import.meta.url)
const { _test: { targetFromEnv, ping, TIMEOUT_MS } } = require('../tools/cloudbase-fn/weshirt-sync-ping/index.js')

test('受保护触发器要求HTTPS固定路径，拒绝URLquery及内嵌凭据', () => {
  for (const url of ['http://laundry.example.test/api/cron/sync', 'https://user:pass@laundry.example.test/api/cron/sync', 'https://laundry.example.test/api/cron/sync?k=secret', 'https://laundry.example.test/api/cron/ingest', 'https://laundry.example.test/api/cron/sync#secret']) {
    assert.equal(targetFromEnv({ WESHIRT_SYNC_URL: url, WESHIRT_SYNC_KEY: 'private-key' }).error, 'invalid_sync_url')
  }
  assert.equal(targetFromEnv({}).error, 'missing_sync_key')
  assert.equal(TIMEOUT_MS, 30000)
})

test('触发器只POST JSON密钥，不回显密钥、响应正文和URL，拒绝重定向', async () => {
  const { target, key } = targetFromEnv({ WESHIRT_SYNC_URL: 'https://laundry.example.test/api/cron/sync', WESHIRT_SYNC_KEY: 'private-key-do-not-log' })
  let outgoing, body
  const fake = (status, eventId) => (options, callback) => {
    outgoing = options
    const req = new EventEmitter()
    req.write = (value) => { body = value }
    req.destroy = () => {}
    req.end = () => { const res = new EventEmitter(); res.statusCode = status; res.headers = { 'x-event-id': eventId }; res.resume = () => {}; callback(res); queueMicrotask(() => { res.emit('data', 'private response body'); res.emit('end') }) }
    return req
  }
  const result = await ping(target, key, fake(200))
  assert.deepEqual(result, { ok: true, status: 200 })
  assert.equal(outgoing.method, 'POST')
  assert.equal(outgoing.path, '/api/cron/sync')
  assert.equal(outgoing.path.includes(key), false)
  assert.deepEqual(JSON.parse(body), { k: key })
  assert.equal(JSON.stringify(result).includes('private'), false)
  const serverEvent = 'evt_' + 'a'.repeat(24)
  assert.deepEqual(await ping(target, key, fake(503, serverEvent)), { ok: false, reason: 'http_error', status: 503, eventId: serverEvent })
  const redirect = await ping(target, key, fake(302, 'private-key-do-not-log'))
  assert.equal(redirect.status, 302)
  assert.match(redirect.eventId, /^trigger_[a-f0-9]{24}$/)
  assert.equal(JSON.stringify(redirect).includes(key), false)
})

test('错误仅返回固定分类，异常中的凭据和目标信息不能泄露', async () => {
  const result = await ping(new URL('https://laundry.example.test/api/cron/sync'), 'private-key', () => { throw new Error('private-key and internal host') })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'request_error')
  assert.equal(result.status, 0)
  assert.match(result.eventId, /^trigger_[a-f0-9]{24}$/)
  assert.equal(JSON.stringify(result).includes('private-key'), false)
})

test('30秒总超时销毁请求，返回固定timeout分类', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let destroyed = false
  const result = ping(new URL('https://laundry.example.test/api/cron/sync'), 'private-key', () => {
    const req = new EventEmitter()
    req.write = () => {}; req.end = () => {}; req.destroy = () => { destroyed = true }
    return req
  })
  t.mock.timers.tick(30000)
  const response = await result
  assert.equal(response.reason, 'timeout')
  assert.equal(response.status, 0)
  assert.match(response.eventId, /^trigger_[a-f0-9]{24}$/)
  assert.equal(destroyed, true)
})

test('配置错误也返回事件标识和状态0，执行日志仅包含固定安全字段', async (t) => {
  const before = process.env.WESHIRT_SYNC_KEY
  delete process.env.WESHIRT_SYNC_KEY
  t.after(() => { if (before === undefined) delete process.env.WESHIRT_SYNC_KEY; else process.env.WESHIRT_SYNC_KEY = before })
  const records = []
  t.mock.method(console, 'warn', value => records.push(JSON.parse(value)))
  const result = await require('../tools/cloudbase-fn/weshirt-sync-ping/index.js').main()
  assert.equal(result.reason, 'missing_sync_key')
  assert.equal(result.status, 0)
  assert.match(result.eventId, /^trigger_[a-f0-9]{24}$/)
  assert.deepEqual(records, [{ eventId: result.eventId, status: 0, reason: 'missing_sync_key' }])
})
