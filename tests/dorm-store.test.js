// 执行实际 Pinia actions；只注入 API/存储边界，控制响应先后顺序来验证竞态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.WESHIRT_TEST_ROOT
  ? pathToFileURL(resolve(process.env.WESHIRT_TEST_ROOT) + sep)
  : new URL('../', import.meta.url)
const require = createRequire(new URL('package.json', root))
const { createPinia, setActivePinia, defineStore } = require('pinia')
const { computed, ref, reactive } = require('vue')
const buildings = await import(new URL('packages/core/buildings.js', root))
const userSource = await readFile(new URL('frontend/src/stores/user.js', root), 'utf8')
const dormSource = await readFile(new URL('frontend/src/stores/dorm.js', root), 'utf8')
const appSource = await readFile(new URL('frontend/src/App.vue', root), 'utf8')

function evaluate(source, bindings, result) {
  const code = source.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
  return new Function(...Object.keys(bindings), code + '\nreturn ' + result)(...Object.values(bindings))
}

function fixture({ id = 'A', remote = null, preferences = {}, ready = true, storage: existingStorage } = {}) {
  const values = new Map()
  const storage = existingStorage || {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
  if (!existingStorage) {
    if (id) {
      storage.setItem('ws_profile', JSON.stringify({ id, nick: id, dormBuilding: remote }))
      storage.setItem('ws_token', 'token-' + id)
    }
    storage.setItem('ws_dorm_preferences', JSON.stringify(preferences))
  }
  const requests = []
  const api = (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }))
  setActivePinia(createPinia())
  const useUserStore = evaluate(userSource, {
    defineStore, localStorage: storage, api,
    setToken: (token) => storage.setItem('ws_token', token),
    getToken: () => storage.getItem('ws_token'),
    onReauth: () => {}, NEED_LOGIN: 'NEED_LOGIN', apiLogout: async () => {},
  }, 'useUserStore')
  const user = useUserStore()
  user.ready = ready
  const useDormStore = evaluate(dormSource, { defineStore, localStorage: storage, useUserStore, ...buildings }, 'useDormStore')
  const dorm = useDormStore()
  return { user, dorm, requests, storage, useUserStore, useDormStore }
}

function switchUser(user, id, dormBuilding = null, token = 'token-' + id) {
  user.token = token
  user.applyUser({ id, nick: id, dormBuilding })
}

test('身份探测未完成时立即恢复账号本机偏好，不等待网络也不提前提交', async () => {
  const f = fixture({ ready: false, preferences: { 'user:A': { code: 'liuyuan', pending: true } } })
  const result = f.dorm.reconcile()
  assert.equal(f.dorm.code, 'liuyuan')
  assert.equal(f.user.ready, false)
  assert.equal(f.requests.length, 0)
  await result
  assert.equal(f.dorm.showPicker, false)
})

test('未登录本机选楼后重新打开无需再次选择，身份探测也不阻塞恢复', async () => {
  const f = fixture({ id: null })
  await f.dorm.reconcile()
  assert.equal(f.dorm.code, '')
  await f.dorm.select('zhuyuan')
  assert.equal(f.requests.length, 0)
  assert.equal(f.dorm.showPicker, false)
  const reopened = fixture({ storage: f.storage, ready: false })
  await reopened.dorm.reconcile()
  assert.equal(reopened.dorm.code, 'zhuyuan')
  assert.equal(reopened.dorm.showPicker, false)
  assert.equal(reopened.requests.length, 0)
})

test('A 的迟到偏好响应不能覆盖 B；A 在途时 B 的同步仍可立即开始', async () => {
  const f = fixture({ preferences: {
    'user:A': { code: 'liuyuan', pending: true },
    'user:B': { code: 'meiyuan', pending: true },
  } })
  const first = f.dorm.reconcile()
  assert.equal(f.requests.length, 1)
  assert.equal(f.dorm.saving, true)
  switchUser(f.user, 'B')
  const second = f.dorm.reconcile()
  assert.equal(f.requests.length, 2, 'B 不应被 A 的同步阻塞')
  assert.equal(f.dorm.code, 'meiyuan')
  assert.equal(f.requests[1].options.body.dormBuilding, 'meiyuan')
  f.requests[0].resolve({ user: { id: 'A', nick: 'A', dormBuilding: 'liuyuan' } })
  await first
  assert.equal(f.user.user.id, 'B')
  assert.equal(f.user.token, 'token-B')
  assert.equal(JSON.parse(f.storage.getItem('ws_profile')).id, 'B')
  assert.equal(f.dorm.code, 'meiyuan')
  assert.equal(f.dorm.saving, true, 'A 完成不能清除 B 的在途状态')
  f.requests[1].resolve({ user: { id: 'B', nick: 'B', dormBuilding: 'meiyuan' } })
  await second
  assert.equal(f.dorm.saving, false)
  assert.equal(f.user.user.id, 'B')
  assert.equal(f.user.user.dormBuilding, 'meiyuan')
  assert.equal(f.dorm.preferences['user:B'].pending, false)
})

test('退出登录后到达的偏好响应不能恢复旧账号和本机资料', async () => {
  const f = fixture()
  const request = f.user.setDormBuilding('guiyuan')
  await f.user.logout()
  f.requests[0].resolve({ user: { id: 'A', dormBuilding: 'guiyuan' } })
  assert.equal(await request, null)
  assert.equal(f.user.user, null)
  assert.equal(f.user.token, '')
  assert.equal(f.storage.getItem('ws_profile'), null)
})

test('相同账号换 token 后旧请求也不能覆盖新会话资料', async () => {
  const f = fixture({ remote: 'guiyuan' })
  const request = f.user.setDormBuilding('liuyuan')
  switchUser(f.user, 'A', 'zhuyuan', 'new-session-token')
  f.requests[0].resolve({ user: { id: 'A', dormBuilding: 'liuyuan' } })
  assert.equal(await request, null)
  assert.equal(f.user.user.dormBuilding, 'zhuyuan')
  assert.equal(f.user.token, 'new-session-token')
})

test('账号保存失败保留本机选择；之后 reconcile 能重试并清掉 pending', async () => {
  const f = fixture()
  const first = f.dorm.select('meiyuan')
  assert.equal(f.dorm.code, 'meiyuan')
  assert.equal(f.dorm.showPicker, false)
  assert.equal(JSON.parse(f.storage.getItem('ws_dorm_preferences'))['user:A'].code, 'meiyuan')
  f.requests[0].reject(new Error('network down'))
  await assert.rejects(first, /network down/)
  assert.equal(f.dorm.saving, false)
  assert.equal(f.dorm.preferences['user:A'].pending, true)
  const retry = f.dorm.reconcile()
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve({ user: { id: 'A', nick: 'A', dormBuilding: 'meiyuan' } })
  await retry
  assert.equal(f.dorm.preferences['user:A'].pending, false)
  assert.equal(JSON.parse(f.storage.getItem('ws_dorm_preferences'))['user:A'].pending, false)
  assert.equal(f.user.user.dormBuilding, 'meiyuan')
})

test('已有账号远端偏好优先于访客偏好，避免登录后覆盖账号住宿楼', async () => {
  const f = fixture({ remote: 'meiyuan', preferences: { guest: { code: 'guiyuan' } } })
  await f.dorm.reconcile()
  assert.equal(f.dorm.code, 'meiyuan')
  assert.equal(f.requests.length, 0)
})

test('大屏允许首次选楼和主动切换；登录与后台页面不弹选楼框', () => {
  const f = fixture({ id: null })
  const route = reactive({ path: '/display', name: 'display', meta: { full: true } })
  const script = appSource.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const popup = evaluate(script, {
    computed, ref, watch: () => {}, onUnmounted: () => {}, assistantData: { setSession() {}, prefetch() {} },
    useRoute: () => route, useRouter: () => ({ push() {}, replace() {} }),
    useUserStore: f.useUserStore, useDormStore: f.useDormStore,
    showConfirmDialog: () => {}, showToast: () => {}, api: () => {},
  }, 'showDormPicker')
  assert.equal(popup.value, true)
  f.dorm.code = 'guiyuan'
  assert.equal(popup.value, false)
  f.dorm.showPicker = true
  assert.equal(popup.value, true)
  route.path = '/login'
  route.name = 'login'
  assert.equal(popup.value, false)
  route.path = '/admin/users'
  route.name = 'admin-users'
  assert.equal(popup.value, false)
})

test('只有设备密钥、token尚未恢复时也从上次账号楼栋立即展示公开机器且不写账号', async () => {
  const f = fixture({ready:false,remote:'guiyuan',preferences:{'user:A':{code:'liuyuan',pending:false}}})
  f.user.token = ''
  await f.dorm.reconcile()
  assert.equal(f.dorm.code,'liuyuan')
  assert.equal(f.requests.length,0)
  assert.equal(f.dorm.activeScope,'')
  await assert.rejects(f.dorm.select('meiyuan'),/恢复账号/)
  switchUser(f.user,'B','meiyuan');f.user.ready=true
  await f.dorm.reconcile()
  assert.equal(f.dorm.code,'meiyuan')
  assert.equal(f.requests.length,0,'cached A public preview must never become a B profile update')
})

test('资料已清理但浏览器记住公开楼栋时恢复账号不挡住首屏，也不会据此设置账号楼栋',async()=>{
  const f=fixture({id:null,ready:false})
  f.storage.setItem('ws_last_public_dorm','guiyuan')
  await f.dorm.reconcile()
  assert.equal(f.dorm.code,'guiyuan');assert.equal(f.requests.length,0)
  switchUser(f.user,'B','liuyuan');f.user.ready=true
  await f.dorm.reconcile()
  assert.equal(f.dorm.code,'liuyuan');assert.equal(f.requests.length,0)
})

test('设备恢复未成功时继续展示上次公开洗衣房，不把已显示的机器重新藏回选楼弹窗',async()=>{
  const f=fixture({id:null,ready:false});f.storage.setItem('ws_last_public_dorm','guiyuan')
  await f.dorm.reconcile();f.user.ready=true
  await f.dorm.reconcile()
  assert.equal(f.dorm.code,'guiyuan');assert.equal(f.dorm.activeScope,'guest');assert.equal(f.requests.length,0)
})
