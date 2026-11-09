import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'building-preference-secret-32-letters'

async function fixture(seed = true) {
  const store = createMemoryStore()
  if (seed) await store.put('user:u1', { id: 'u1', nick: '原昵称', dingUserId: 'staff1', avatar: 'av1', mobile: '13800000000' })
  const app = createApp({ store, env: { AUTH_SECRET: SECRET } })
  const token = await issueToken('u1', SECRET)
  const call = async (method, path, body, authenticated = true) => {
    const response = await app.fetch(new Request('http://local' + path, {
      method,
      headers: { ...(authenticated ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: response.status, data: await response.json() }
  }
  return { store, call }
}

test('老用户未绑定住宿楼时返回null；保存后后续读取保留且不改变昵称和身份', async () => {
  const { call, store } = await fixture()
  assert.equal((await call('GET', '/api/auth/me')).data.user.dormBuilding, null)
  for (const dormBuilding of ['guiyuan', 'liuyuan', 'meiyuan', 'zhuyuan']) {
    const result = await call('POST', '/api/user/profile', { dormBuilding })
    assert.equal(result.status, 200)
    assert.equal(result.data.user.dormBuilding, dormBuilding)
    assert.equal(result.data.user.nick, '原昵称')
    assert.equal((await call('GET', '/api/auth/me')).data.user.dormBuilding, dormBuilding)
  }
  assert.equal((await store.get('user:u1')).dingUserId, 'staff1')
  assert.equal((await store.get('user:u1')).mobile, '13800000000')
})

test('非法住宿楼在修改任何资料之前拒绝', async () => {
  const { call, store } = await fixture()
  for (const dormBuilding of ['b1', 'other', '', null, 1, {}]) {
    const result = await call('POST', '/api/user/profile', { nick: '不应写入', dormBuilding })
    assert.equal(result.status, 400)
    const user = await store.get('user:u1')
    assert.equal(user.nick, '原昵称')
    assert.equal(user.dormBuilding, undefined)
  }
})

test('只修改昵称时保留已选住宿楼', async () => {
  const { call } = await fixture()
  await call('POST', '/api/user/profile', { dormBuilding: 'liuyuan' })
  const result = await call('POST', '/api/user/profile', { nick: '新昵称' })
  assert.equal(result.status, 200)
  assert.equal(result.data.user.nick, '新昵称')
  assert.equal(result.data.user.dormBuilding, 'liuyuan')
})

test('未登录不能绑定住宿楼，真实用户记录缺失时不写入临时资料', async () => {
  const { call, store } = await fixture(false)
  assert.equal((await call('POST', '/api/user/profile', { dormBuilding: 'guiyuan' }, false)).status, 401)
  assert.equal((await call('POST', '/api/user/profile', { dormBuilding: 'guiyuan' })).status, 409)
  assert.equal(await store.get('user:u1'), null)
})
