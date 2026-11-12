import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed, watch, reactive, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createMemoryHistory, createRouter } from 'vue-router'
import { normalizeDormBuilding } from '../packages/core/buildings.js'

const source = await readFile(new URL('../frontend/src/views/AdminDetail.vue', import.meta.url), 'utf8')
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
function evaluate(overrides = {}, returned = '({ selectedDorm, buildings, loadUsers, users, exportLogs })') {
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  const bindings = {
    ref, computed, watch, onMounted() {}, onUnmounted() {}, defineProps: () => reactive({ tab: 'users' }),
    useRoute: () => ({ query: {} }), useRouter: () => ({ push() {} }),
    useDormStore: () => reactive({ buildings: [{ code: 'custom', name: '自定义楼' }] }),
    normalizeDormBuilding, api: async () => ({ items: [], rows: [] }),
    showToast() {}, showConfirmDialog: async () => {}, BASE: '', getToken: () => '', getAdminSession: () => null,
    ...overrides,
  }
  return new Function(...Object.keys(bindings), script + '\nreturn ' + returned)(...Object.values(bindings))
}

test('管理详情返回固定管理首页，浏览器返回不会再次打开刚关闭的详情', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: ['/settings', '/admin', '/admin/users'].map((path) => ({ path, component: {} })) })
  await router.push('/settings')
  await router.push('/admin/users')
  const panel = evaluate({ useRouter: () => router }, '({ goBack })')
  await panel.goBack()
  assert.equal(router.currentRoute.value.path, '/admin')
  const returned = new Promise((resolve) => {
    const stop = router.afterEach(() => { stop(); resolve() })
  })
  router.back()
  await returned
  assert.equal(router.currentRoute.value.path, '/settings')
})

test('管理详情 Vue 脚本和模板编译通过，住宿楼选项来自网站目录', () => {
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'admin-detail' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'AdminDetail.vue', id: 'admin-detail', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  assert.equal(source.includes('DORM_BUILDINGS'), false)
  const panel = evaluate({ useRoute: () => ({ query: { dorm: 'custom' } }) })
  assert.equal(panel.selectedDorm.value, 'custom')
  assert.deepEqual(panel.buildings.value, [{ code: 'custom', name: '自定义楼' }])
})

test('网站目录延迟加载后恢复自定义楼筛选，旧用户列表不能覆盖新结果', async () => {
  const dorm = reactive({ buildings: [{ code: 'guiyuan', name: '桂园' }] })
  const requests = []
  const panel = evaluate({ useDormStore: () => dorm, useRoute: () => ({ query: { dorm: 'custom' } }), api: (path, options) => { const task = deferred(); requests.push({ ...task, path, options }); return task.promise } })
  assert.equal(requests[0].options.auth, 'optional')
  dorm.buildings = [{ code: 'custom', name: '自定义楼' }]
  await nextTick()
  assert.equal(panel.selectedDorm.value, 'custom')
  assert.match(requests[1].path, /dorm=custom/)
  requests[1].resolve({ items: [{ id: 'current' }] })
  await Promise.resolve(); await Promise.resolve()
  requests[0].resolve({ items: [{ id: 'obsolete' }] })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(panel.users.value[0].id, 'current')
})

test('账号管理员仅有Bearer也能导出日志，会话和Bearer均存在时保留两种认证', async () => {
  for (const session of [null, { session: 'local-admin-session' }]) {
    const fetches = [], downloads = [], revoked = []
    const panel = evaluate({
      getToken: () => 'local-user-token', getAdminSession: () => session,
      fetch: async (path, options) => { fetches.push({ path, options }); return { ok: true, blob: async () => new Blob(['test']) } },
      document: { createElement: () => ({ click() { downloads.push(true) } }) },
      URL: { createObjectURL: () => 'blob:local-test', revokeObjectURL: (url) => revoked.push(url) },
    })
    await panel.exportLogs()
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0].options.headers.Authorization, 'Bearer local-user-token')
    assert.equal(fetches[0].options.headers['x-admin-token'], session?.session)
    assert.equal(downloads.length, 1)
    assert.deepEqual(revoked, ['blob:local-test'])
  }
})

test('未登录时不发起日志导出，管理详情切换页签会重新请求对应数据', async () => {
  const props = reactive({ tab: 'users' }), notices = [], paths = []
  let fetches = 0
  const panel = evaluate({
    defineProps: () => props, showToast: (message) => notices.push(message), fetch: async () => { fetches++; throw new Error('unexpected') },
    api: async (path, options) => { paths.push({ path, options }); return { items: [], rows: [] } },
  })
  await panel.exportLogs()
  assert.equal(fetches, 0)
  assert.match(notices.at(-1), /登录管理账号/)
  props.tab = 'machines'
  await nextTick()
  assert.match(paths.at(-1).path, /\/api\/admin\/machines/)
  assert.equal(paths.at(-1).options.auth, 'optional')
})

test('用户批量选择只包含可操作目标，取消确认不写入，失败逐项可见', async () => {
  let cancel = true
  const writes = []
  const panel = evaluate({
    showConfirmDialog: async () => { if (cancel) throw new Error('cancel') },
    api: async (path, options) => {
      if (options?.method === 'POST') {
        writes.push({ path, options })
        return { succeeded: 1, failed: 1, eventId: 'evt_fixture', results: [{ id: 'one', ok: true, status: 200 }, { id: 'two', ok: false, status: 409, error: { message: '仍有任务', eventId: 'evt_fixture' } }] }
      }
      return { items: [{ id: 'one', canOperate: true }, { id: 'two', canOperate: true }, { id: 'view-only', canOperate: false }], bulk: { operate: true, operateBuildings: ['custom'] } }
    },
  }, '({ loadUsers, selectVisibleUsers, selectUser, selectedUsers, batchUsers, batchResult, bulkBuildings })')
  await panel.loadUsers()
  panel.selectVisibleUsers(true)
  assert.deepEqual(panel.selectedUsers.value, ['one', 'two'])
  panel.selectUser('view-only', true)
  assert.deepEqual(panel.selectedUsers.value, ['one', 'two'])
  await panel.batchUsers('setNotify', false)
  assert.equal(writes.length, 0)
  cancel = false
  await panel.batchUsers('setNotify', false)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/api/admin/users/batch')
  assert.deepEqual(writes[0].options.body, { ids: ['one', 'two'], action: 'setNotify', confirmed: true, notifyOn: false })
  assert.equal(panel.batchResult.value.failed, 1)
  assert.deepEqual(panel.selectedUsers.value, ['two'])
  assert.deepEqual(panel.bulkBuildings.value.map(row => row.code), ['custom'])
})

test('机器登记人导航携带账号筛选，用户CSV保留筛选且兼容两种管理认证', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: ['/admin/users', '/admin/machines'].map(path => ({ path, component: {} })) })
  await router.push('/admin/machines')
  const machinePanel = evaluate({ useRouter: () => router, defineProps: () => reactive({ tab: 'machines' }) }, '({ openOccupant })')
  await machinePanel.openOccupant({ userId: 'occupier_123' })
  assert.equal(router.currentRoute.value.path, '/admin/users')
  assert.equal(router.currentRoute.value.query.q, 'occupier_123')
  const fetches = [], downloads = []
  const panel = evaluate({
    useRoute: () => router.currentRoute.value, getToken: () => 'fixture-user-token', getAdminSession: () => ({ session: 'fixture-admin-session' }),
    fetch: async (path, options) => { fetches.push({ path, options }); return { ok: true, blob: async () => new Blob(['masked,csv']) } },
    document: { createElement: () => ({ click() { downloads.push(true) } }) },
    URL: { createObjectURL: () => 'blob:csv', revokeObjectURL() {} },
  }, '({ exportUsers, userQ })')
  assert.equal(panel.userQ.value, 'occupier_123')
  await panel.exportUsers()
  assert.match(fetches[0].path, /\/api\/admin\/users\.csv\?q=occupier_123/)
  assert.equal(fetches[0].options.headers.Authorization, 'Bearer fixture-user-token')
  assert.equal(fetches[0].options.headers['x-admin-token'], 'fixture-admin-session')
  assert.equal(downloads.length, 1)
})
