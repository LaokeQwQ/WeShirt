import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { PERMISSION_RESOURCES, basePermissions, normalizePermissionOverrides } from '../packages/core/permissions.js'

const SECRET = 'global-permission-scope-test-secret'
const catalog = [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }]
const grant = (scope = null) => ({ view: true, operate: true, viewBuildings: scope, operateBuildings: scope })

async function fixture(t) {
  const store = createMemoryStore()
  for (const id of ['chief', 'admin']) await store.put('user:' + id, { id, nick: id, dormBuilding: 'guiyuan' })
  await store.put('meta:siteAdmins', [{ userId: 'chief', role: 'super' }, { userId: 'admin', role: 'admin' }])
  await store.put('operations:config', { broadcast: { enabled: false } })
  const tokens = { chief: await issueToken('chief', SECRET), admin: await issueToken('admin', SECRET) }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external requests') })
  const app = createApp({ store, env: { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'global-scope-admin', BUILDING_ID: 'b1' } })
  const call = async (path, { method = 'GET', user = 'chief', body } = {}) => {
    const response = await app.request(path, { method, headers: { authorization: 'Bearer ' + tokens[user], 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  return { store, call }
}

test('全部 scoped:false 资源只允许全局 null 范围，任何楼栋数组（含空数组）均被拒绝', () => {
  const base = basePermissions({ role: 'super' }, true)
  const globals = PERMISSION_RESOURCES.filter((resource) => !resource.scoped)
  assert.ok(globals.some((resource) => resource.key === 'adminSite'))
  assert.ok(globals.some((resource) => resource.key === 'adminOperations'))
  for (const resource of globals) {
    assert.deepEqual(normalizePermissionOverrides({ [resource.key]: grant() }, base, catalog)[resource.key], grant(), resource.key)
    for (const scope of [[], ['guiyuan'], ['guiyuan', 'liuyuan']]) {
      assert.throws(() => normalizePermissionOverrides({ [resource.key]: grant(scope) }, base, catalog), /楼栋权限范围无效/, resource.key)
      assert.throws(() => normalizePermissionOverrides({ [resource.key]: { ...grant(), operateBuildings: scope } }, base, catalog), /楼栋权限范围无效/, resource.key + ' write scope')
    }
  }
})

test('真实总管 API 不能给网站和运营全局资源配置楼范围，失败整单不写入', async (t) => {
  const { store, call } = await fixture(t)
  for (const key of ['adminSite', 'adminOperations']) {
    for (const scope of [[], ['guiyuan']]) {
      const result = await call('/api/admin/permissions/admin', { method: 'PATCH', body: { permissions: { board: grant(['guiyuan']), [key]: grant(scope) } } })
      assert.equal(result.status, 400, key + JSON.stringify(scope))
      assert.equal(result.data.error.code, 'bad_param')
      assert.equal(result.data.error.status, 400)
      assert.ok(result.data.error.eventId)
      assert.equal(await store.get('access:user:admin', null), null)
    }
  }
})

test('历史非法全局楼范围配置在真实后台接口 fail closed，不返回全站网站和运营数据', async (t) => {
  const { store, call } = await fixture(t)
  await store.put('access:user:admin', { permissions: { adminSite: grant(['guiyuan']), adminOperations: grant(['guiyuan']) } })
  const access = await call('/api/user/permissions', { user: 'admin' })
  assert.equal(access.status, 200)
  for (const key of ['adminSite', 'adminOperations']) {
    assert.equal(access.data.permissions[key].view, false)
    assert.equal(access.data.permissions[key].operate, false)
  }
  for (const path of ['/api/admin/site', '/api/admin/operations']) {
    const denied = await call(path, { user: 'admin' })
    assert.equal(denied.status, 403)
    assert.equal(denied.data.error.code, 'forbidden')
    assert.equal(denied.data.site, undefined)
    assert.equal(denied.data.config, undefined)
    assert.equal(denied.data.alerts, undefined)
  }
  // Explicit all-building grants remain a valid option for the global feature.
  assert.equal((await call('/api/admin/permissions/admin', { method: 'PATCH', body: { permissions: { adminSite: grant(), adminOperations: grant() } } })).status, 200)
  assert.equal((await call('/api/admin/site', { user: 'admin' })).status, 200)
  assert.equal((await call('/api/admin/operations', { user: 'admin' })).status, 200)
})
