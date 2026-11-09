import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { ref, computed } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { registerSiteRoutes, getSiteConfig, loadSiteRuntime, checkSiteAdmin, isSiteAdmin } from '../server/site.js'
const SECRET = 'site-test-secret-at-least-16'

async function fixture() {
  const store = createMemoryStore()
  const env = { AUTH_SECRET: SECRET, DINGTALK_APP_KEY: 'env-key', DINGTALK_APP_SECRET: 'env-secret', HAIER_PAYLOAD: '{"existing":7,"schoolId":"env-school"}' }
  await store.put('user:real', { id: 'real', nick: '真实姓名', dingUserId: 'ding-private' })
  await store.put('user:operator', { id: 'operator', nick: '运维员', dingUserId: 'ding-operator' })
  await store.put('user:anonymous', { id: 'anonymous', nick: '匿名' })
  const app = new Hono()
  const checkSuperAdmin = (c) => c.req.header('x-admin-token') === 'bootstrap-secret'
  registerSiteRoutes(app, { store, env, checkSuperAdmin, checkAdmin: (c) => isSiteAdmin(c, { store, env, superAdminCheck: () => checkSuperAdmin(c) }) })
  const tokens = { real: await issueToken('real', SECRET), operator: await issueToken('operator', SECRET), anonymous: await issueToken('anonymous', SECRET) }
  const call = async (path, { superAdmin, user, body, method = 'GET' } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (superAdmin) headers['x-admin-token'] = 'bootstrap-secret'
    if (user) headers.authorization = 'Bearer ' + tokens[user]
    const result = await app.request('http://local' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: result.status, data: await result.json() }
  }
  return { store, env, call, tokens }
}

test('公开网站配置不含学校ID/密钥；后台修改品牌与自定义楼栋持久化', async () => {
  const { call, store } = await fixture()
  assert.equal((await call('/api/admin/site')).status, 401)
  assert.equal((await call('/api/site')).data.name, '等衣')
  const body = { name: '校园洗衣', iconUrl: '/custom/icon.png', schoolLabel: '某校', schoolId: 'school-private-123', buildings: [{ code: 'new_dorm', name: '新一舍' }] }
  const result = await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body })
  assert.equal(result.status, 200)
  assert.equal(result.data.site.schoolId, body.schoolId)
  const publicResult = (await call('/api/site')).data
  assert.deepEqual(publicResult.buildings, body.buildings)
  assert.equal(publicResult.name, body.name)
  assert.equal(JSON.stringify(publicResult).includes('school-private'), false)
  assert.equal('schoolId' in publicResult, false)
  assert.deepEqual((await getSiteConfig(store)).buildings, body.buildings)
})

test('配置批量先验证；恶意图标、重复/过多楼栋、非法字段均不能部分落库', async () => {
  const { call, store } = await fixture()
  for (const iconUrl of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', '//evil.example/x', 'http://example.com/icon', '/\\evil.example/x']) {
    assert.equal((await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { name: '不得保存', iconUrl } })).status, 400)
  }
  const duplicated = [{ code: 'new', name: '新楼' }, { code: 'new', name: '另一楼' }]
  assert.equal((await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { buildings: duplicated } })).status, 400)
  assert.equal((await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { buildings: Array.from({ length: 31 }, (_, i) => ({ code: 'b' + i, name: '楼' + i })) } })).status, 400)
  assert.equal((await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { name: '不得保存', credentials: { appSecret: 'new', invalid: true } } })).status, 400)
  assert.equal(await store.get('meta:site', null), null)
  assert.equal(await store.get('meta:dingtalk', null), null)
})

test('真实用户角色鉴权，普通管理员不能提权或写密钥，bootstrap入口不可删除', async () => {
  const { call, store, tokens } = await fixture()
  assert.equal((await call('/api/admin/site', { user: 'real' })).status, 401)
  assert.equal((await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { admin: { userId: 'anonymous', role: 'admin' } } })).status, 400)
  assert.equal((await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { admin: { userId: 'real', role: 'admin' } } })).status, 200)
  let result = await call('/api/admin/site', { user: 'real' })
  assert.equal(result.data.permissions.manageSite, true)
  assert.equal(result.data.permissions.manageCredentials, false)
  assert.equal(result.data.admins[0].nick, '真**')
  assert.equal(JSON.stringify(result.data).includes('ding-private'), false)
  assert.equal((await call('/api/admin/site', { user: 'real', method: 'PATCH', body: { name: '新站名' } })).status, 200)
  assert.equal((await call('/api/admin/site', { user: 'real', method: 'PATCH', body: { credentials: { appSecret: 'not-allowed' } } })).status, 403)
  assert.equal((await call('/api/admin/site', { user: 'real', method: 'PATCH', body: { admin: { userId: 'operator', role: 'admin' } } })).status, 403)
  assert.equal((await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { removeAdmin: 'bootstrap' } })).status, 400)
  await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { admin: { userId: 'operator', role: 'operator' } } })
  assert.equal((await call('/api/admin/site', { user: 'operator', method: 'PATCH', body: { name: '越权' } })).status, 403)
  const context = { req: { header: () => 'Bearer ' + tokens.real } }
  assert.equal(await checkSiteAdmin(context, store, SECRET), true)
  assert.equal(await isSiteAdmin(context, { store, env: { AUTH_SECRET: SECRET }, superAdminCheck: false }), true)
  await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { removeAdmin: 'real' } })
  assert.equal(await checkSiteAdmin(context, store, SECRET), false)
  assert.equal(await isSiteAdmin(context, { store, env: {}, superAdminCheck: true }), true)
})

test('密钥仅configured布尔回显，运行环境服务端覆盖并保留payload其他字段', async () => {
  const { call, store, env } = await fixture()
  const privateValues = { appKey: 'private-app-key', appSecret: 'private-app-secret', robotCode: 'private-robot-code', agentId: 'private-agent-id', aesKey: 'private-aes-key', token: 'private-callback-token', webhook: 'https://example.com/private-hook?access_token=private-token', webhookSecret: 'private-webhook-secret' }
  const result = await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { credentials: privateValues, schoolId: 'private-school' } })
  assert.equal(result.status, 200)
  for (const [key, value] of Object.entries(privateValues)) { assert.equal(result.data.credentials[key], true); assert.equal(JSON.stringify(result.data).includes(value), false) }
  const runtime = await loadSiteRuntime(store, env)
  assert.equal(runtime.DINGTALK_APP_SECRET, privateValues.appSecret)
  assert.equal(runtime.DINGTALK_AES_KEY, privateValues.aesKey)
  assert.equal(runtime.HAIER_SCHOOL_ID, 'private-school')
  assert.deepEqual(JSON.parse(runtime.HAIER_PAYLOAD), { existing: 7, schoolId: 'private-school' })
  assert.equal(env.DINGTALK_APP_SECRET, 'env-secret')
  await call('/api/admin/site', { superAdmin: true, method: 'PATCH', body: { credentials: { appSecret: '' } } })
  assert.equal((await loadSiteRuntime(store, env)).DINGTALK_APP_SECRET, '')
  assert.equal((await call('/api/admin/site', { superAdmin: true })).data.credentials.appSecret, false)
})

test('网站管理组件编译通过，刷新保留草稿，密钥失败保留输入且成功不回显', async () => {
  const source = await readFile(new URL('../frontend/src/components/AdminSite.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'site' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'AdminSite.vue', id: 'site', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  const result = { site: { name: '初始', iconUrl: '', schoolLabel: '', schoolId: '', buildings: [{ code: 'a', name: 'A楼' }] }, admins: [], credentials: {}, permissions: { manageSite: true, manageAdmins: true, manageCredentials: true } }
  let fail = false
  let siteRefreshes = 0
  const bindings = { ref, computed, useDormStore: () => ({ loadSite: async () => { siteRefreshes++ } }), defineEmits: () => () => {}, onMounted() {}, onUnmounted() {}, showToast() {}, showConfirmDialog: async () => {}, api: async (path, options) => {
    if (options?.method === 'PATCH' && fail) throw new Error('offline')
    return structuredClone(result)
  } }
  const body = descriptor.scriptSetup.content.replace(/^import[^\n]*\n/gm, '')
  const panel = new Function(...Object.keys(bindings), body + '\nreturn { load, draft, dirty, conflict, saveSite, saveCredentials, credentialDraft, clearFields, error }')(...Object.values(bindings))
  await panel.load()
  panel.draft.value.name = '我的草稿'
  result.site.name = '服务器新名'
  await panel.load()
  assert.equal(panel.draft.value.name, '我的草稿')
  assert.equal(panel.conflict.value, true)
  fail = true
  panel.credentialDraft.value.appSecret = 'my-private-key'
  await panel.saveCredentials()
  assert.equal(panel.credentialDraft.value.appSecret, 'my-private-key')
  assert.equal(panel.error.value, 'offline')
  fail = false
  await panel.saveCredentials()
  assert.equal(panel.credentialDraft.value.appSecret, undefined)
  assert.equal(panel.draft.value.name, '我的草稿')
  await panel.saveSite()
  assert.equal(siteRefreshes, 1, 'saving site updates the active dorm catalog without reloading')
})
