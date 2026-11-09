import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'profile-concurrency-test-secret'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture(t) {
  const memory = createMemoryStore()
  // A real KV returns separate values. Delay after copying to expose stale
  // read/modify/write races that the reference-based memory store can conceal.
  const store = {
    async get(key, fallback = null) {
      const value = structuredClone(await memory.get(key, fallback))
      if (key.startsWith('user:')) await sleep(2)
      return value
    },
    async put(key, value) { if (key.startsWith('user:')) await sleep(2); return memory.put(key, structuredClone(value)) },
    del: memory.del,
    async list(prefix) { return structuredClone(await memory.list(prefix)) },
  }
  const env = { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'profile-concurrency-admin', BUILDING_ID: 'b1', DINGTALK_APP_KEY: 'profile-concurrency-app', DINGTALK_APP_SECRET: 'synthetic-profile-secret' }
  const tokens = {}
  for (const id of ['a', 'b']) {
    await store.put('user:' + id, { id, nick: '初始' + id, nickAuto: true, avatar: 'av1', avatarAuto: true, dormBuilding: 'guiyuan', notifyOn: false, notifyLeadMin: 0, dingUserId: 'synthetic-' + id })
    tokens[id] = await issueToken(id, SECRET)
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request') })
  const app = createApp({ store, env })
  const call = async (path, { user = 'a', method = 'POST', body } = {}) => {
    const response = await app.request(path, { method, headers: { authorization: 'Bearer ' + tokens[user], 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  return { store, call }
}

test('真实 JWT 并发保存昵称、提醒、住宿楼和头像时所有字段保留，重复刷新昵称稳定', async (t) => {
  const { store, call } = await fixture(t)
  const results = await Promise.all([
    call('/api/user/profile', { body: { nick: '手动设定同学' } }),
    call('/api/user/notify', { body: { on: true, leadMin: 5 } }),
    call('/api/user/profile', { body: { dormBuilding: 'liuyuan' } }),
    call('/api/user/profile', { body: { avatar: 'av8', avatarUrl: null } }),
  ])
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200], JSON.stringify(results))
  const expected = { nick: '手动设定同学', nickAuto: false, notifyOn: true, notifyLeadMin: 5, dormBuilding: 'liuyuan', avatar: 'av8', avatarAuto: false, avatarUrl: null }
  const saved = await store.get('user:a')
  for (const [key, value] of Object.entries(expected)) assert.equal(saved[key], value, key + ' must survive a concurrent write')
  for (let i = 0; i < 5; i++) {
    const me = await call('/api/auth/me', { method: 'GET' })
    assert.equal(me.status, 200)
    assert.equal(me.data.user.nick, expected.nick)
    assert.equal(me.data.user.dormBuilding, expected.dormBuilding)
    assert.equal(me.data.user.avatar, expected.avatar)
  }
  assert.equal((await store.get('user:a')).nickAuto, false)
})

test('迟到的钉钉头像响应不会覆盖同账号新资料，另一账号不被头像网络请求阻塞', async (t) => {
  const { store, call } = await fixture(t)
  let enter, release
  const started = new Promise((resolve) => { enter = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'oapi.dingtalk.com')
    if (url.pathname === '/gettoken') return Response.json({ errcode: 0, access_token: 'synthetic-profile-token', expires_in: 7200 })
    assert.equal(url.pathname, '/topapi/v2/user/get')
    enter()
    await gate
    return Response.json({ errcode: 0, result: { avatar: 'https://images.example/avatar.jpg', name: '上游旧昵称' } })
  })
  const avatar = call('/api/user/dingtalk-avatar', { method: 'GET' })
  await started
  const updates = [
    call('/api/user/profile', { body: { nick: '保留手动昵称' } }),
    call('/api/user/notify', { body: { on: true, leadMin: 10 } }),
    call('/api/user/profile', { body: { dormBuilding: 'liuyuan' } }),
  ]
  try {
    const other = await Promise.race([
      call('/api/user/profile', { user: 'b', body: { nick: '另一个同学' } }),
      sleep(500).then(() => { throw new Error('Account B must not wait for account A network request') }),
    ])
    assert.equal(other.status, 200)
    assert.equal((await store.get('user:b')).nick, '另一个同学')
  } finally { release() }
  const results = await Promise.all([avatar, ...updates])
  assert.equal(results.every((r) => r.status === 200), true, JSON.stringify(results))
  const saved = await store.get('user:a')
  assert.equal(saved.avatarUrl, 'https://images.example/avatar.jpg')
  assert.equal(saved.nick, '保留手动昵称')
  assert.equal(saved.nickAuto, false)
  assert.equal(saved.notifyOn, true)
  assert.equal(saved.notifyLeadMin, 10)
  assert.equal(saved.dormBuilding, 'liuyuan')
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/auth/me', { method: 'GET' })).data.user.nick, saved.nick)
})
