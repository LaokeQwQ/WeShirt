<template>
  <section class="permissions-admin card" aria-label="功能权限与范围">
    <header><h3>功能权限与范围</h3><button type="button" :disabled="loading || saving" @click="refresh">刷新</button></header>
    <p class="intro">总管可为成员收紧查看、操作权限和楼栋范围。身份决定能力上限，需要增加能力时，请先在网站管理授予对应身份。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading && !loaded" class="intro">正在读取权限…</p>
    <p v-if="loaded && !canManage" class="intro">只有总管可以编辑成员功能权限。</p>
    <template v-if="loaded && canManage">
      <form class="search" @submit.prevent="search"><label>查找成员<input v-model="query" maxlength="80" placeholder="昵称或账号 ID" :disabled="loading || saving" /></label><van-button size="small" native-type="submit" :loading="loading" :disabled="saving">搜索</van-button></form>
      <label class="member-picker">选择成员<select v-model="selectedId" :disabled="loading || saving" @change="selectMember"><option value="">请选择成员</option><option v-if="selected && !users.some(user => user.id === selected.user.id)" :value="selected.user.id">{{ selected.user.nick || '同学' }} · {{ roleName(selected.user.role) }}</option><option v-for="member in users" :key="member.id" :value="member.id">{{ member.nick || '同学' }} · {{ roleName(member.role) }}</option></select></label>
      <p v-if="!users.length && !selected" class="intro">没有匹配的成员，请调整关键词。</p>
      <template v-if="selected">
        <div class="selected-member"><strong>{{ selected.user.nick || '同学' }}</strong><IdentityBadge :identity="{role:selected.user.role}" /><span>{{ hasOverrides ? '已设置个别权限' : '继承身份默认权限' }}</span></div>
        <p v-if="!editable" class="intro">总管身份的权限不能单独覆盖。</p>
        <fieldset class="resource-editor" :disabled="saving || loading || !editable">
        <div v-for="resource in resources" :key="resource.key" class="permission-row" :data-resource="resource.key">
          <h4>{{ resource.label }}</h4>
          <div class="capabilities"><label><input v-model="draft[resource.key].view" type="checkbox" :disabled="saving || loading || !baseFor(resource).view" @change="viewChanged(resource)" />可查看</label><label><input v-model="draft[resource.key].operate" type="checkbox" :disabled="saving || loading || !baseFor(resource).operate || !draft[resource.key].view" />可操作</label><button v-if="resource.scoped && draft[resource.key].view" type="button" class="scope-button" :disabled="saving || loading" @click="openScope = openScope === resource.key ? '' : resource.key">{{ openScope === resource.key ? '收起楼栋范围' : '设置楼栋范围' }}</button></div>
          <p v-if="!baseFor(resource).view" class="ceiling-note">当前身份不具备此功能，请先在网站管理调整身份。</p><p v-else-if="!baseFor(resource).operate" class="ceiling-note">当前身份仅允许查看。</p>
          <div v-if="resource.scoped && openScope === resource.key && draft[resource.key].view" class="scopes">
            <fieldset v-for="axis in scopeAxes(resource)" :key="axis.key" :disabled="saving || loading"><legend>{{ axis.label }}</legend><label class="all-buildings"><input type="checkbox" :checked="draft[resource.key][axis.key] === null" :disabled="!canSelectAll(resource, axis.key)" @change="setAll(resource, axis.key, $event.target.checked)" />全部楼栋</label><p v-if="baseFor(resource)[axis.key] !== null" class="ceiling-note">可选范围受当前身份的楼栋授权限制。</p><p v-if="axis.key === 'operateBuildings'" class="ceiling-note">操作范围只能在可查看的楼栋内选择。</p><div v-if="draft[resource.key][axis.key] !== null" class="building-options"><label v-for="building in buildings" :key="building.code"><input type="checkbox" :checked="draft[resource.key][axis.key].includes(building.code)" :disabled="!buildingAllowed(resource, axis.key, building.code)" @change="toggleBuilding(resource, axis.key, building.code, $event.target.checked)" />{{ building.name }}</label></div><p v-if="Array.isArray(draft[resource.key][axis.key]) && !draft[resource.key][axis.key].length" class="ceiling-note">尚未选择楼栋，此项范围为空。</p></fieldset>
          </div>
        </div>
        </fieldset>
        <div class="actions"><van-button size="small" type="primary" :loading="saving" :disabled="loading || !dirty || !editable" @click="save">保存成员权限</van-button><van-button size="small" :disabled="loading || saving || !hasOverrides || !editable" @click="reset">恢复身份默认</van-button><span v-if="dirty" class="draft-hint">有未保存修改</span><span v-else-if="status" class="saved" role="status">{{ status }}</span></div>
      </template>
    </template>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { showConfirmDialog } from 'vant'
import { api } from '../api'
import IdentityBadge from './IdentityBadge.vue'
const loading = ref(false), loaded = ref(false), saving = ref(false), canManage = ref(false)
const query = ref(''), selectedId = ref(''), users = ref([]), resources = ref([]), buildings = ref([]), selected = ref(null), draft = ref({}), baseline = ref(''), openScope = ref(''), error = ref(''), status = ref('')
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const hasOverrides = computed(() => Boolean(selected.value && Object.keys(selected.value.overrides || {}).length))
const editable = computed(() => canManage.value && selected.value?.user.role !== 'super')
const roleName = (role) => ({ super: '总管', admin: '管理员', operator: '运维', volunteer: '志愿管理' })[role] || '普通成员'
let generation = 0, alive = true
function baseFor(resource) { return selected.value?.base?.[resource.key] || { view: false, operate: false, viewBuildings: [], operateBuildings: [] } }
function scopeValue(value) { return value === null ? null : Array.isArray(value) ? [...new Set(value.filter((code) => buildings.value.some((row) => row.code === code)))] : [] }
function boundedScope(value, maximum) { const requested = scopeValue(value); const allowed = scopeValue(maximum); return allowed === null ? requested : requested === null ? allowed : requested.filter((code) => allowed.includes(code)) }
function apply(data) {
  canManage.value = data.canManage === true
  resources.value = Array.isArray(data.resources) ? data.resources.filter((row) => row && typeof row.key === 'string') : []
  buildings.value = [{ code: 'public', name: '公共频道' }, ...(Array.isArray(data.buildings) ? data.buildings.filter((row) => row.code !== 'public') : [])]
  users.value = Array.isArray(data.users) ? data.users : []
  selected.value = data.selected?.user?.id ? data.selected : null
  selectedId.value = selected.value?.user.id || ''
  const next = {}
  for (const resource of resources.value) {
    const permission = selected.value?.permissions?.[resource.key] || baseFor(resource)
    const base = baseFor(resource)
    const viewBuildings = resource.scoped ? boundedScope(permission.viewBuildings, base.viewBuildings) : null
    const operateBuildings = resource.scoped ? boundedScope(boundedScope(permission.operateBuildings, base.operateBuildings), viewBuildings) : null
    next[resource.key] = { view: permission.view === true && base.view === true, operate: permission.operate === true && base.operate === true && permission.view === true && base.view === true, viewBuildings, operateBuildings }
  }
  draft.value = next
  baseline.value = JSON.stringify(next)
  openScope.value = ''
  loaded.value = true
}
async function load() {
  if (loading.value || saving.value) return
  const request = ++generation, target = selectedId.value
  loading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams()
    if (query.value.trim()) params.set('q', query.value.trim())
    if (target) params.set('userId', target)
    const result = await api('/api/admin/permissions?' + params, { auth: 'optional', retry: false })
    if (alive && request === generation) apply(result)
  } catch (e) { if (alive && request === generation) error.value = String(e?.message || '权限读取失败').split(' · ')[0] }
  finally { if (alive && request === generation) loading.value = false }
}
async function discardDraft() {
  if (!dirty.value || !selected.value) return true
  try { await showConfirmDialog({ title: '放弃未保存的权限修改？', message: '继续后会重新读取成员权限。' }); return true } catch { return false }
}
async function search() { if (loading.value || saving.value || !await discardDraft()) return; selectedId.value = ''; status.value = ''; await load() }
async function refresh() { if (loading.value || saving.value || !await discardDraft()) return; status.value = ''; await load() }
async function selectMember() { if (!await discardDraft()) { selectedId.value = selected.value?.user.id || ''; return }; status.value = ''; await load() }
function viewChanged(resource) { if (!draft.value[resource.key].view) draft.value[resource.key].operate = false }
function scopeAxes(resource) { return [{ key: 'viewBuildings', label: '可查看楼栋' }, ...(draft.value[resource.key].operate ? [{ key: 'operateBuildings', label: '可操作楼栋' }] : [])] }
function buildingAllowed(resource, key, code) { const allowed = baseFor(resource)[key]; const view = draft.value[resource.key].viewBuildings; return (allowed === null || Array.isArray(allowed) && allowed.includes(code)) && (key !== 'operateBuildings' || view === null || view.includes(code)) }
function canSelectAll(resource, key) { return baseFor(resource)[key] === null && (key !== 'operateBuildings' || draft.value[resource.key].viewBuildings === null) }
function syncOperateScope(resource) { const row = draft.value[resource.key]; row.operateBuildings = boundedScope(row.operateBuildings, row.viewBuildings) }
function setAll(resource, key, checked) { if (checked && !canSelectAll(resource, key)) return; draft.value[resource.key][key] = checked ? null : []; if (key === 'viewBuildings') syncOperateScope(resource) }
function toggleBuilding(resource, key, code, checked) {
  if (!buildingAllowed(resource, key, code)) return
  const current = draft.value[resource.key][key]
  const codes = new Set(Array.isArray(current) ? current : [])
  if (checked) codes.add(code); else codes.delete(code)
  draft.value[resource.key][key] = [...codes]
  if (key === 'viewBuildings') syncOperateScope(resource)
}
async function save() {
  if (saving.value || loading.value || !editable.value || !selected.value || !dirty.value) return
  const target = selected.value.user.id
  const permissions = JSON.parse(JSON.stringify(draft.value))
  saving.value = true; error.value = ''; status.value = ''
  try {
    await api('/api/admin/permissions/' + encodeURIComponent(target), { method: 'PATCH', auth: 'optional', retry: false, body: { permissions } })
    if (!alive) return
    saving.value = false
    await load()
    if (!error.value) status.value = '成员权限已保存'
  } catch (e) { if (alive) error.value = String(e?.message || '保存失败，修改已保留').split(' · ')[0] }
  finally { if (alive) saving.value = false }
}
async function reset() {
  if (saving.value || loading.value || !editable.value || !selected.value) return
  try { await showConfirmDialog({ title: '恢复身份默认权限？', message: '将删除此成员的个别权限设置，按当前身份重新计算。' }) } catch { return }
  const target = selected.value.user.id
  saving.value = true; error.value = ''; status.value = ''
  try {
    await api('/api/admin/permissions/' + encodeURIComponent(target), { method: 'DELETE', auth: 'optional', retry: false })
    if (!alive) return
    saving.value = false
    await load()
    if (!error.value) status.value = '已恢复身份默认权限'
  } catch (e) { if (alive) error.value = String(e?.message || '恢复失败').split(' · ')[0] }
  finally { if (alive) saving.value = false }
}
onMounted(load)
onUnmounted(() => { alive = false; generation++ })
</script>

<style scoped>
.resource-editor{padding:0;border:0;margin:0;min-width:0}
.permissions-admin{padding:16px;margin:12px}.permissions-admin>header{display:flex;justify-content:space-between;align-items:center;gap:12px}.permissions-admin h3{font-size:16px;margin:0}.intro,.ceiling-note{font-size:11px;line-height:1.7;color:var(--text-dim)}.error{font-size:12px;line-height:1.6;color:#fca5a5;overflow-wrap:anywhere}.permissions-admin button:not(.van-button){min-height:32px;padding:5px 9px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:#93c5fd;font-size:11px;cursor:pointer}.permissions-admin button:disabled,.permissions-admin input:disabled{opacity:.5;cursor:default}.search{display:flex;align-items:end;gap:10px;margin:16px 0}.search label{display:grid;gap:6px;flex:1;min-width:0;font-size:12px}.search input,.member-picker select{box-sizing:border-box;width:100%;min-width:0;min-height:36px;padding:8px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;color-scheme:dark}.member-picker{display:grid;gap:7px;font-size:12px}.selected-member{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0;font-size:13px}.selected-member>span{font-size:10px;color:var(--text-dim)}.permission-row{border-top:1px solid var(--border);padding:13px 0}.permission-row h4{font-size:13px;margin:0 0 10px}.capabilities{display:flex;gap:14px;flex-wrap:wrap;align-items:center}.capabilities label,.building-options label,.all-buildings{display:inline-flex;align-items:center;gap:6px;font-size:12px}.permissions-admin input[type=checkbox]{width:17px;height:17px;accent-color:#3b82f6;margin:0}.scope-button{margin-left:auto}.scopes{display:grid;gap:10px;margin-top:12px}.scopes fieldset{min-width:0;padding:12px;border:1px solid var(--border);border-radius:8px}.scopes legend{font-size:11px;padding:0 5px;color:var(--text-dim)}.building-options{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}.draft-hint,.saved{font-size:11px}.draft-hint{color:#fcd34d}.saved{color:#86efac}
</style>
