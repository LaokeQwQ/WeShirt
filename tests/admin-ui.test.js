import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DORM_BUILDINGS } from '../packages/core/buildings.js'

function evaluate(source, bindings, returned) {
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  return new Function(...Object.keys(bindings), script + '\nreturn ' + returned)(...Object.values(bindings))
}
const adminSource = await readFile(new URL('../frontend/src/views/Admin.vue', import.meta.url), 'utf8')
const telemetrySource = await readFile(new URL('../frontend/src/components/AdminTelemetry.vue', import.meta.url), 'utf8')

test('管理页返回在直达和登录回跳后都离开后台，不依赖浏览器上一页', async () => {
  for (const loggedIn of [false, true]) for (const previous of [null, '/login?to=/admin', '/admin/users']) {
    const router = createRouter({ history: createMemoryHistory(), routes: ['/admin', '/admin/users', '/login', '/settings', '/list'].map((path) => ({ path, component: {} })) })
    if (previous) await router.push(previous)
    await router.push('/admin')
    const admin = evaluate(adminSource, {
      ref, computed, onMounted() {}, onUnmounted() {}, onBeforeRouteLeave() {},
      useRouter: () => router, useUserStore: () => ({ isLoggedIn: loggedIn }),
      showToast() {}, showConfirmDialog: async () => {}, getAdminSession() {}, setAdminSession() {}, clearAdminSession() {}, DORM_BUILDINGS,
      api: async () => ({}),
    }, '({ goBack })')
    await admin.goBack()
    assert.equal(router.currentRoute.value.path, loggedIn ? '/settings' : '/list')
  }
})

test('钉钉角色账号无需口令会话即可进入后台，退出后迟到请求不能恢复后台', async () => {
  let delay = false
  const pending = []
  const calls = []
  const admin = evaluate(adminSource, {
    ref, computed, onMounted() {}, onUnmounted() {}, onBeforeRouteLeave() {},
    useRouter: () => ({}), useUserStore: () => ({ isLoggedIn: true }), showToast() {}, showConfirmDialog: async () => {},
    getAdminSession() {}, setAdminSession() {}, clearAdminSession() {}, DORM_BUILDINGS,
    api: (path, opts) => {
      calls.push({ path, opts })
      const data = path === '/api/admin/status' ? { board: { floors: [] } } : { rows: [], mapping: {} }
      return delay && path !== '/api/admin/notify-check' ? new Promise((resolve) => pending.push(() => resolve(data))) : Promise.resolve(data)
    },
  }, '({ useAccount, load, lock, authed, status, adminToken, accountMode })')
  await admin.useAccount()
  assert.equal(admin.adminToken.value, '')
  assert.equal(admin.accountMode.value, true)
  assert.equal(admin.authed.value, true)
  for (const { opts } of calls.filter(({ path }) => path === '/api/admin/status' || path === '/api/admin/machines')) assert.equal(opts.auth, 'optional', 'request must carry the existing user Bearer')
  delay = true
  const late = admin.load()
  admin.lock()
  pending.forEach((resolve) => resolve())
  await late
  assert.equal(admin.authed.value, false)
  assert.equal(admin.status.value, null)
  assert.equal(admin.accountMode.value, false)
})

test('后台刷新保留未保存绑定，服务器变化时提示冲突，重复与失效设备阻止保存', async () => {
  let mapping = { '1': 'one' }
  let writes = 0
  const admin = evaluate(adminSource, {
    ref, computed, onMounted() {}, onUnmounted() {}, onBeforeRouteLeave() {},
    useRouter: () => ({}), useUserStore: () => ({}), showToast() {}, showConfirmDialog: async () => {},
    getAdminSession() {}, setAdminSession() {}, clearAdminSession() {}, AdminTelemetry: {}, DORM_BUILDINGS,
    api: async (path, opts) => {
      if (opts?.method === 'POST') { writes++; return { mapping } }
      if (path === '/api/admin/status') return { board: { floors: [] } }
      return { mapping: { mapping }, rows: [{ id: 'one' }, { id: 'two' }] }
    },
  }, '({ load, saveMapping, draft, adminToken, mapDirty, mappingIssues, mappingConflict, savedMapping })')
  admin.adminToken.value = 'session'
  await admin.load()
  assert.equal(admin.draft.value['1'], 'one')
  admin.draft.value = { '1': 'two' }
  mapping = { '1': 'one', '2': 'two' }
  await admin.load()
  assert.equal(admin.draft.value['1'], 'two', '刷新不能丢弃人工草稿')
  assert.equal(admin.draft.value['2'], undefined)
  assert.equal(admin.mapDirty.value, true)
  assert.equal(admin.mappingConflict.value, true)
  admin.draft.value = { '1': 'one', '2': 'one' }
  assert.ok(admin.mappingIssues.value.some((issue) => issue.includes('重复')))
  await admin.saveMapping()
  assert.equal(writes, 0)
  admin.draft.value = { D1: 'missing' }
  assert.ok(admin.mappingIssues.value.some((issue) => issue.includes('不在最新看板')))
  await admin.saveMapping()
  assert.equal(writes, 0)
})

test('遥测快速切换楼栋时迟到响应不能覆盖当前筛选，错误保留最后结果', async () => {
  const pending = []
  const telemetry = evaluate(telemetrySource, {
    ref, computed, onMounted() {}, onUnmounted() {}, DORM_BUILDINGS, dormBuildingName: (code) => code,
    api: (path) => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
  }, '({ load, dorm, days, data, error, loading })')
  const first = telemetry.load()
  telemetry.dorm.value = 'liuyuan'
  const second = telemetry.load()
  assert.match(pending[1].path, /dorm=liuyuan/)
  pending[1].resolve({ pageViews: 2 })
  await second
  pending[0].resolve({ pageViews: 1 })
  await first
  assert.equal(telemetry.data.value.pageViews, 2)
  const failed = telemetry.load()
  pending[2].reject(new Error('network failed'))
  await failed
  assert.equal(telemetry.data.value.pageViews, 2)
  assert.equal(telemetry.error.value, 'network failed')
  assert.equal(telemetry.loading.value, false)
})
