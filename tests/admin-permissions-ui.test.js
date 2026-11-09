import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
const source = await readFile(new URL('../frontend/src/components/AdminPermissions.vue', import.meta.url), 'utf8')
const buildings = [{ code: 'a', name: '甲楼' }, { code: 'b', name: '乙楼' }]
const resources = [{ key: 'users', label: '用户', scoped: true }, { key: 'site', label: '网站', scoped: false }]
const full = { view: true, operate: true, viewBuildings: null, operateBuildings: null }
function data(role = 'admin', max = full) { return { canManage: true, resources, buildings, users: [{ id: 'target', nick: '目标同学', role }], selected: { user: { id: 'target', nick: '目标同学', role }, base: { users: max, site: { view: false, operate: false, viewBuildings: null, operateBuildings: null } }, permissions: { users: full, site: full }, overrides: {} } } }
function harness(overrides = {}) {
  const bindings = { ref, computed, onMounted() {}, onUnmounted() {}, showConfirmDialog: async () => {}, api: async () => data(), ...overrides }
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  return new Function(...Object.keys(bindings), script + '\nreturn ({apply,draft,resources,baseFor,selected,selectedId,editable,canSelectAll,buildingAllowed,setAll,toggleBuilding,viewChanged,save,reset,error,status,dirty})')(...Object.values(bindings))
}

test('权限编辑器脚本模板编译通过，角色能力上限不可提升，总管不可覆写', () => {
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'permissions' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'AdminPermissions.vue', id: 'permissions', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  const panel = harness()
  panel.apply(data())
  assert.equal(panel.draft.value.site.view, false)
  assert.equal(panel.draft.value.site.operate, false)
  panel.apply(data('super'))
  assert.equal(panel.editable.value, false)
})

test('查看楼栋收窄同步收窄操作，操作仅能选择查看范围内且身份允许的楼栋', () => {
  const panel = harness()
  panel.apply(data())
  const resource = resources[0]
  panel.setAll(resource, 'viewBuildings', false)
  assert.deepEqual(panel.draft.value.users.viewBuildings, [])
  assert.deepEqual(panel.draft.value.users.operateBuildings, [])
  assert.equal(panel.canSelectAll(resource, 'operateBuildings'), false)
  panel.toggleBuilding(resource, 'viewBuildings', 'a', true)
  assert.equal(panel.buildingAllowed(resource, 'operateBuildings', 'a'), true)
  assert.equal(panel.buildingAllowed(resource, 'operateBuildings', 'b'), false)
  panel.toggleBuilding(resource, 'operateBuildings', 'b', true)
  assert.deepEqual(panel.draft.value.users.operateBuildings, [])
  panel.toggleBuilding(resource, 'operateBuildings', 'a', true)
  panel.toggleBuilding(resource, 'viewBuildings', 'a', false)
  assert.deepEqual(panel.draft.value.users.operateBuildings, [])
  panel.apply(data('volunteer', { ...full, viewBuildings: ['a'], operateBuildings: ['a'] }))
  assert.deepEqual(panel.draft.value.users.viewBuildings, ['a'])
  assert.deepEqual(panel.draft.value.users.operateBuildings, ['a'])
  assert.equal(panel.canSelectAll(resource, 'viewBuildings'), false)
  assert.equal(panel.buildingAllowed(resource, 'viewBuildings', 'b'), false)
})

test('权限全量保存含空范围，失败保留草稿，恢复默认只在确认后删除', async () => {
  const writes = []
  let fail = true, confirm = false
  const panel = harness({ api: async (path, options) => {
    if (options.method === 'PATCH') { writes.push({ path, options }); if (fail) throw new Error('保存失败'); return { ok: true } }
    if (options.method === 'DELETE') { writes.push({ path, options }); return { ok: true } }
    return data()
  }, showConfirmDialog: async () => { if (!confirm) throw new Error('cancel') } })
  panel.apply(data())
  panel.setAll(resources[0], 'viewBuildings', false)
  await panel.save()
  assert.match(panel.error.value, /保存失败/)
  assert.deepEqual(panel.draft.value.users.viewBuildings, [])
  assert.equal(panel.dirty.value, true)
  assert.deepEqual(Object.keys(writes[0].options.body.permissions).sort(), ['site', 'users'])
  assert.equal(writes[0].options.auth, 'optional')
  await panel.reset()
  assert.equal(writes.length, 1)
  confirm = true
  await panel.reset()
  assert.equal(writes.at(-1).options.method, 'DELETE')
  assert.equal(writes.at(-1).path, '/api/admin/permissions/target')
  fail = false
  panel.setAll(resources[0], 'viewBuildings', false)
  await panel.save()
  assert.equal(panel.status.value, '成员权限已保存')
})
