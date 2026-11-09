import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed, watch } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
const userSource = await readFile(new URL('../frontend/src/stores/user.js', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../frontend/src/views/Settings.vue', import.meta.url), 'utf8')
const userA = { id: 'a', nick: '已保存昵称', avatar: 'av1', avatarUrl: '', dormBuilding: 'guiyuan', notifyOn: true, notifyLeadMin: 0 }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function storeHarness(api) {
  const cache = new Map([['ws_token', 'token-a'], ['ws_profile', JSON.stringify(userA)]])
  let token = 'token-a'
  const localStorage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: (key) => cache.delete(key) }
  const defineStore = (_, options) => {
    const store = options.state()
    for (const [name, getter] of Object.entries(options.getters)) Object.defineProperty(store, name, { get: () => getter(store) })
    for (const [name, action] of Object.entries(options.actions)) store[name] = action.bind(store)
    return () => store
  }
  const script = userSource.replace(/^import[^\n]*\n/gm, '').replace('export const useUserStore', 'const useUserStore')
  const useStore = new Function('defineStore', 'api', 'localStorage', 'setToken', 'getToken', 'onReauth', 'NEED_LOGIN', 'apiLogout', script + '\nreturn useUserStore')(
    defineStore, api, localStorage, (value) => { token = value }, () => token, () => {}, 'NEED_LOGIN', async () => { token = '' },
  )
  return { store: useStore(), cache }
}

test('旧me与bootstrap响应不能覆盖刚保存的昵称和本机缓存', async () => {
  for (const method of ['me', 'bootstrap']) {
    const old = deferred()
    const { store, cache } = storeHarness(async (path) => path === '/api/auth/me' ? old.promise : { user: { ...userA, nick: '新昵称' } })
    const reading = store[method]()
    await store.setProfile({ nick: '新昵称' })
    old.resolve({ user: { ...userA, nick: '旧昵称' } })
    await reading
    assert.equal(store.user.nick, '新昵称')
    assert.equal(JSON.parse(cache.get('ws_profile')).nick, '新昵称')
  }
})

test('旧住宿和通知响应只合并修改字段，不回灌昵称与头像', async () => {
  const dorm = deferred(), notify = deferred()
  const { store } = storeHarness(async (path, options) => {
    if (path === '/api/user/notify') return notify.promise
    if (options?.body?.dormBuilding) return dorm.promise
    return { user: { ...userA, nick: '最新昵称', avatarUrl: 'https://example.com/avatar.png' } }
  })
  const changingDorm = store.setDormBuilding('liuyuan')
  const changingNotify = store.setNotify({ on: false })
  await store.setProfile({ nick: '最新昵称', avatarUrl: 'https://example.com/avatar.png' })
  dorm.resolve({ user: { ...userA, dormBuilding: 'liuyuan' } })
  notify.resolve({ user: { ...userA, notifyOn: false } })
  await Promise.all([changingDorm, changingNotify])
  assert.equal(store.user.nick, '最新昵称')
  assert.equal(store.user.avatarUrl, 'https://example.com/avatar.png')
  assert.equal(store.user.dormBuilding, 'liuyuan')
  assert.equal(store.user.notifyOn, false)
})

test('切换账号或退出后忽略旧账号资料响应，暂不可读时保留已缓存昵称', async () => {
  const pending = deferred()
  const { store } = storeHarness(async () => pending.promise)
  const saving = store.setProfile({ nick: '不能串号' })
  store.token = 'token-b'
  store.applyUser({ id: 'b', nick: '另一位同学' })
  pending.resolve({ user: { ...userA, nick: '不能串号' } })
  assert.equal(await saving, null)
  assert.equal(store.user.nick, '另一位同学')

  const old = deferred()
  const loggedOut = storeHarness(async () => old.promise).store
  const reading = loggedOut.me()
  await loggedOut.logout()
  old.resolve({ user: userA })
  await reading
  assert.equal(loggedOut.user, null)

  const unavailable = storeHarness(async () => { throw new Error('account_out_of_sync') })
  await unavailable.store.bootstrap()
  assert.equal(unavailable.store.user.nick, userA.nick)
  assert.equal(JSON.parse(unavailable.cache.get('ws_profile')).nick, userA.nick)
})

function settingsHarness() {
  const mounted = [], pending = deferred()
  const userStore = { user: { ...userA }, me: () => pending.promise }
  const bindings = { ref, computed, watch, onMounted: (callback) => mounted.push(callback), onUnmounted() {}, useRouter: () => ({}), useRoute: () => ({ query: {} }), useUserStore: () => userStore, useDormStore: () => ({ code: 'guiyuan' }), navigator: { doNotTrack: '1' }, telemetryEnabled: () => false, setTelemetryEnabled() {}, api: async () => ({}), showToast() {}, showConfirmDialog: async () => {}, NEED_LOGIN: 'NEED_LOGIN' }
  const script = settingsSource.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  const panel = new Function(...Object.keys(bindings), script + '\nreturn ({nick,avatarUrl,notifyOn,notifyLead})')(...Object.values(bindings))
  return { panel, pending, hydrate: mounted.at(-1) }
}

test('设置页慢资料读取保留正在编辑的昵称头像和通知草稿，未编辑字段可正常刷新', async () => {
  const dirty = settingsHarness()
  const waiting = dirty.hydrate()
  dirty.panel.nick.value = '正在编辑'
  dirty.panel.avatarUrl.value = 'data:image/png;base64,draft'
  dirty.panel.notifyOn.value = false
  dirty.panel.notifyLead.value = 5
  dirty.pending.resolve({ ...userA, nick: '服务端旧值' })
  await waiting
  assert.equal(dirty.panel.nick.value, '正在编辑')
  assert.equal(dirty.panel.avatarUrl.value, 'data:image/png;base64,draft')
  assert.equal(dirty.panel.notifyOn.value, false)
  assert.equal(dirty.panel.notifyLead.value, 5)
  const clean = settingsHarness()
  const refreshed = clean.hydrate()
  clean.pending.resolve({ ...userA, nick: '服务端新值' })
  await refreshed
  assert.equal(clean.panel.nick.value, '服务端新值')
})

test('设置页不展示内部用户ID，Vue模板与脚本均可编译', () => {
  assert.equal(settingsSource.includes('title="用户ID"'), false)
  const { descriptor, errors } = parse(settingsSource)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'settings' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'Settings.vue', id: 'settings', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
})
