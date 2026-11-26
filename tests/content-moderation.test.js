import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { issueToken } from '../packages/core/auth.js'
import { createMemoryStore } from '../packages/core/store.js'

const authSecret = 'moderation-test-fixture-secret'
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN0kAAAAASUVORK5CYII='
const photo = Buffer.from(avatar.split(',')[1], 'base64')
const oldAvatar = 'https://cdn.example.test/old-avatar.png'
const mode = {
  MODERATION_MODE: 'async',
  MODERATION_CALLBACK_URL: 'https://laundry.example.test/api/content-review/callback',
  MODERATION_CALLBACK_SECRET: 'moderation-async-fixture-secret-0001'
}

async function fixture(env = {}, moderation = {}) {
  const users = ['anna', 'ben']
  const store = createMemoryStore()
  await Promise.all(users.map(id => store.put('user:' + id, {
    id, nick: id === 'anna' ? '安同学' : '本同学', avatar: 'av1',
    avatarUrl: oldAvatar, provider: 'dingtalk', dormBuilding: 'guiyuan'
  })))
  await store.put('meta:siteAdmins', [{ userId: 'anna', role: 'admin' }])
  const app = createApp({ store, env: { AUTH_SECRET: authSecret, ...env }, moderation })
  const tokens = Object.fromEntries(await Promise.all(users.map(async id => [id, await issueToken(id, authSecret)])))
  async function call(path, body, { user = 'anna', headers = {}, method = 'POST' } = {}) {
    const init = { method, headers: { ...(user ? { Authorization: 'Bearer ' + tokens[user] } : {}),
      'Content-Type': 'application/json', ...headers } }
    if (body !== undefined) init.body = body instanceof Uint8Array ? body : JSON.stringify(body)
    const res = await app.request('https://laundry.example.test' + path, init)
    return { status: res.status, data: await res.json() }
  }
  return { store, call }
}

test('sync moderation reviews normalized discussion text before publishing and never changes rejected data', async () => {
  let decision = 'review'
  const checked = []
  const provider = { async checkText(data) { checked.push(data); return { decision } } }
  const { call, store } = await fixture({ MODERATION_MODE: 'sync' }, { provider })
  assert.equal((await call('/api/messages', { channel: 'public', text: '测试留言' }, { user: null })).status, 401)
  assert.equal(checked.length, 0)
  const rejected = await call('/api/messages', { channel: 'public', text: '原文\u200b测试' })
  assert.equal(rejected.status, 422)
  assert.equal(rejected.data.error.code, 'moderation_rejected')
  assert.match(rejected.data.error.eventId, /^evt_/)
  assert.deepEqual(await store.get('messages:b1', []), [])
  assert.equal(await store.get('community:revision:public'), null)
  assert.deepEqual(checked.map(x => x.text), ['原文 测试'])
  decision = 'pass'
  const passed = await call('/api/messages', { channel: 'public', text: '原文\u200b测试' })
  assert.equal(passed.status, 200)
  assert.equal((await store.get('messages:b1'))[0].text, '原文 测试')
  assert.equal(checked.length, 2)
})

test('avatar checks the actual upload and preserves prior avatar and nickname on rejection', async () => {
  let decision = 'block'
  const checked = []
  const provider = { async checkImage(data) { checked.push(data); return { decision } } }
  const { call, store } = await fixture({ MODERATION_MODE: 'sync' }, { provider })
  const path = '/api/user/profile'
  const rejected = await call(path, { nick: '新昵称', avatarUrl: avatar })
  assert.equal(rejected.status, 422)
  assert.equal((await store.get('user:anna')).avatarUrl, oldAvatar)
  assert.equal((await store.get('user:anna')).nick, '安同学')
  assert.deepEqual(checked[0].bytes, Uint8Array.from(photo))
  assert.equal(checked[0].mime, 'image/png')
  assert.equal((await call(path, { avatarUrl: 'https://other.example.test/avatar.png' })).status, 400)
  assert.equal((await call(path, { avatarUrl: 'data:image/png;base64,MTIzNA==' })).status, 400)
  assert.equal((await call(path, { avatarUrl: oldAvatar })).status, 200)
  assert.equal(checked.length, 1)
  const channel = '/api/messages/channels/guiyuan/avatar'
  const image = { headers: { 'Content-Type': 'image/png' } }
  assert.equal((await call(channel, photo, image)).status, 422)
  assert.equal(await store.get('community:avatar:guiyuan'), null)
  decision = 'pass'
  assert.equal((await call(path, { avatarUrl: avatar })).status, 200)
  assert.equal((await store.get('user:anna')).avatarUrl, avatar)
  assert.equal((await call(channel, photo, image)).status, 200)
  assert.equal(await store.get('community:avatar:guiyuan'), avatar)
})

test('misconfigured opt-in fails safely and default-off preserves old behavior', async () => {
  const content = { channel: 'public', text: '可选审核测试' }
  const off = await fixture()
  assert.equal((await off.call('/api/messages', content)).status, 200)
  const missing = await fixture({ MODERATION_MODE: 'sync' })
  assert.equal((await missing.call('/api/messages', content)).status, 503)
  assert.deepEqual(await missing.store.get('messages:b1', []), [])
  const unavailable = await fixture({ MODERATION_MODE: 'async' }, { provider: {} })
  assert.equal((await unavailable.call('/api/messages', content)).status, 503)
  assert.deepEqual(await unavailable.store.get('messages:b1', []), [])
})

test('requests that fail review count toward the review admission limit', async () => {
  let reviewed = 0
  const provider = { async checkText() { reviewed++; return { decision: 'block' } } }
  const { call, store } = await fixture({ MODERATION_MODE: 'sync' }, { provider, now: () => 1780000000000 })
  for (let index = 0; index < 30; index++)
    assert.equal((await call('/api/messages', { channel: 'public', text: '拒绝提交 ' + index })).status, 422)
  const rejected = await call('/api/messages', { channel: 'public', text: '第 31 条' })
  assert.equal(rejected.status, 429)
  assert.equal(rejected.data.error.code, 'moderation_too_frequent')
  assert.equal(reviewed, 30)
  assert.deepEqual(await store.get('messages:b1', []), [])
})

test('async holds uploads, rechecks CI after a signed callback, and publishes only the owner request', async () => {
  const jobId = 'ci-job-fixture-0001'
  let providerDecision = 'block'
  let submitted
  let providerReads = 0
  let staged = 0
  const provider = {
    async stage() { staged++ },
    async submit(input) { submitted = input; return { jobId } },
    async getResult(input) {
      providerReads++
      assert.equal(input.objectKey, submitted.objectKey)
      assert.equal(input.jobId, jobId)
      return { decision: providerDecision }
    }
  }
  const rows = new Map()
  const atomicStore = {
    consistency: 'linearizable', durable: true,
    async get(key) { return rows.get(key) ?? null },
    async compareAndSet(key, expected, value) {
      if ((rows.get(key)?.version ?? null) !== expected) return false
      rows.set(key, { version: crypto.randomUUID(), value })
      return true
    }
  }
  const { call, store } = await fixture(mode, { provider, atomicStore })
  const message = { channel: 'public', text: '不会由外部回调直接发布' }
  const options = { headers: { 'Idempotency-Key': 'content-review-fixture-001' } }
  const first = await call('/api/messages', message, options)
  assert.equal(first.status, 409)
  assert.equal(first.data.error.code, 'moderation_pending')
  assert.equal(staged, 1)
  assert.equal((await call('/api/messages', message, options)).status, 409)
  assert.equal(staged, 1)
  const url = new URL(submitted.callbackUrl)
  const body = { EventName: 'ReviewText',
    JobsDetail: { JobId: jobId, DataId: submitted.dataId, Object: submitted.objectKey, Result: 0 } }
  assert.equal((await call(url.pathname, body, { user: null })).status, 401)
  assert.equal(providerReads, 0)
  const forged = { ...body, JobsDetail: { ...body.JobsDetail, JobId: 'forged-other-task' } }
  assert.equal((await call(url.pathname + url.search, forged, { user: null })).data.accepted, false)
  assert.equal(providerReads, 0)
  assert.equal((await call(url.pathname + url.search, body, { user: null })).data.accepted, true)
  assert.equal(providerReads, 1)
  assert.deepEqual(await store.get('messages:b1', []), [])
  assert.equal((await call('/api/messages', message, options)).status, 422)
  assert.equal((await call(url.pathname + url.search, body, { user: null })).data.accepted, true)
  assert.equal(providerReads, 1, 'replays do not retrigger CI')

  const passed = { ...message, text: '合格文字仍需要作者本人发布' }
  providerDecision = 'pass'
  const passingOptions = { headers: { 'Idempotency-Key': 'content-review-fixture-002' } }
  assert.equal((await call('/api/messages', passed, passingOptions)).status, 409)
  const passUrl = new URL(submitted.callbackUrl)
  const passedBody = { ...body, JobsDetail: { JobId: jobId, DataId: submitted.dataId, Object: submitted.objectKey } }
  assert.equal((await call(passUrl.pathname + passUrl.search, passedBody, { user: null })).data.accepted, true)
  assert.deepEqual(await store.get('messages:b1', []), [])
  assert.equal((await call('/api/messages', passed, { user: 'ben' })).status, 409)
  assert.equal((await call('/api/messages', passed, passingOptions)).status, 200)
  assert.equal((await store.get('messages:b1'))[0].userId, 'anna')
})
