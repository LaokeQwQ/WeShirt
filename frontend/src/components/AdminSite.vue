<template>
  <section class="site-admin card">
    <header><h3>网站管理</h3><button :disabled="loading || busy" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading && !data" class="dim">正在读取网站设置…</p>
    <template v-if="data">
      <p class="dim">当前权限：{{ roleName(data.role) }}。网站公开接口只返回品牌和楼栋，学校 ID 与密钥留在后台。</p>
      <form @submit.prevent="saveSite">
        <fieldset :disabled="!data.permissions.manageSite || busy">
          <label>站点名称<input v-model="draft.name" maxlength="40" required /></label>
          <label>图标地址<input v-model="draft.iconUrl" maxlength="500" placeholder="https://… 或 /icon.png" /><span class="dim">留空使用默认图标。</span></label>
          <label>学校显示名（可选，公开）<input v-model="draft.schoolLabel" maxlength="60" /></label>
          <label>学校 ID（仅后台）<input v-model="draft.schoolId" maxlength="100" autocomplete="off" /><span class="dim">用于上游接口 schoolId 参数，与设备点位 positionId 分开配置。</span></label>
          <h4>住宿楼 <span class="dim">{{ draft.buildings.length }}/30</span></h4>
          <div v-for="(building, i) in draft.buildings" :key="i" class="building"><label>代号<input v-model="building.code" maxlength="32" placeholder="dorm_a" /></label><label>名称<input v-model="building.name" maxlength="30" placeholder="A 楼" /></label><button type="button" class="remove" :disabled="draft.buildings.length <= 1" @click="draft.buildings.splice(i, 1)" aria-label="移除此楼栋">移除</button></div>
          <button type="button" :disabled="draft.buildings.length >= 30" @click="draft.buildings.push({ code: '', name: '' })">添加楼栋</button>
        </fieldset>
        <p class="dim">代号用于账号住宿楼绑定，修改或删除已有代号会要求相关用户重新选择住宿楼。</p>
        <p v-if="conflict" class="warning">服务器配置已变化，已保留本机草稿。请核对后保存或重置。</p>
        <p v-if="siteValidation" class="error">{{ siteValidation }}</p>
        <div class="actions"><button class="primary" type="submit" :disabled="!data.permissions.manageSite || busy || !dirty || !!siteValidation">{{ saving ? '保存中…' : '保存网站设置' }}</button><button type="button" :disabled="busy || !dirty" @click="reset">重置草稿</button><span v-if="dirty" class="dim">有未保存修改</span></div>
      </form>
      <details class="credentials"><summary>钉钉应用与通知通道</summary><p class="dim">密钥不会回显。输入新值才覆盖，留空保留当前值；勾选清除会停用对应配置。修改后服务端后续请求使用新配置。</p>
        <form @submit.prevent="saveCredentials"><fieldset :disabled="!data.permissions.manageCredentials || credentialSaving"><div v-for="field in credentialFields" :key="field.key" class="credential"><label>{{ field.name }} <span :class="data.credentials[field.key] ? 'configured' : 'dim'">{{ data.credentials[field.key] ? '已配置' : '未配置' }}</span><input v-model="credentialDraft[field.key]" type="password" autocomplete="new-password" :disabled="!!clearFields[field.key]" :placeholder="data.credentials[field.key] ? '留空保留现有值' : '输入配置值'" /></label><label class="clear"><input v-model="clearFields[field.key]" type="checkbox" />清除</label></div></fieldset><button type="submit" class="primary" :disabled="!data.permissions.manageCredentials || credentialSaving || !hasCredentialChanges">{{ credentialSaving ? '保存中…' : '保存通道配置' }}</button></form>
        <p v-if="!data.permissions.manageCredentials" class="warning">修改密钥需总管账号或最高管理员口令登录。</p>
      </details>
      <div class="admins"><h4>后台成员</h4><p class="dim">总管管理全站权限和密钥；管理员可分配志愿管理。志愿管理仅巡检指定楼栋，不能进入全站管理。</p>
        <article v-for="member in data.admins" :key="member.userId" class="member"><div><b>{{ member.nick }}</b><span>{{ roleName(member.role) }}{{ member.active ? '' : ' · 账号已失效' }}</span><small v-if="member.buildings?.length">{{ member.buildings.map(code=>data.site.buildings.find(b=>b.code===code)?.name||code).join('、') }}</small><code>{{ member.userId }}</code></div><button v-if="data.permissions.manageAdmins || data.permissions.manageVolunteers && member.role==='volunteer'" :disabled="memberBusy" @click="removeAdmin(member)">移除权限</button></article>
        <p v-if="!data.admins.length" class="dim">尚未添加后台成员。</p>
        <form v-if="data.permissions.manageAdmins || data.permissions.manageVolunteers" class="add-member" @submit.prevent="addAdmin"><label>真实用户 ID<input v-model="memberId" maxlength="80" placeholder="从用户管理复制 ID" required /></label><label>角色<select v-model="memberRole"><option value="volunteer">志愿管理</option><template v-if="data.permissions.manageAdmins"><option value="operator">运维</option><option value="admin">管理员</option><option value="super">总管</option></template></select></label><fieldset v-if="memberRole==='volunteer'" class="scope-buildings"><legend>授权巡检楼栋</legend><label v-for="b in data.site.buildings" :key="b.code"><input v-model="memberBuildings" type="checkbox" :value="b.code" />{{ b.name }}</label></fieldset><button type="submit" :disabled="memberBusy || !memberId.trim()">{{ memberBusy ? '处理中…' : '添加 / 更新权限' }}</button></form>
      </div>
    </template>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { showToast, showConfirmDialog } from 'vant'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
const dorm = useDormStore()
const emit = defineEmits(['changed'])
const data = ref(null)
const savedSite = ref(null)
const draft = ref({ name: '', iconUrl: '', schoolLabel: '', schoolId: '', buildings: [] })
const loading = ref(false), saving = ref(false), error = ref(''), conflict = ref(false)
const credentialDraft = ref({}), clearFields = ref({}), credentialSaving = ref(false)
const memberId = ref(''), memberRole = ref('volunteer'), memberBusy = ref(false)
const memberBuildings=ref([])
const roleName=(role)=>({super:'总管',admin:'管理员',operator:'运维',volunteer:'志愿管理'})[role]||'普通用户'
const busy = computed(() => saving.value || credentialSaving.value || memberBusy.value)
const credentialFields = [{ key: 'appKey', name: 'App Key' }, { key: 'appSecret', name: 'App Secret' }, { key: 'robotCode', name: 'Robot Code' }, { key: 'agentId', name: 'Agent ID' }, { key: 'aesKey', name: '回调 AES Key' }, { key: 'token', name: '回调 Token' }, { key: 'webhook', name: '群 Webhook' }, { key: 'webhookSecret', name: 'Webhook 签名密钥' }]
let generation = 0, disposed = false
const clone = (value) => JSON.parse(JSON.stringify(value))
const dirty = computed(() => savedSite.value && JSON.stringify(draft.value) !== JSON.stringify(savedSite.value))
const hasCredentialChanges = computed(() => credentialFields.some(({ key }) => clearFields.value[key] || credentialDraft.value[key]?.trim()))
const siteValidation = computed(() => {
  if (!draft.value.name.trim()) return '请输入站点名称'
  const buildings = draft.value.buildings
  if (!buildings.length || buildings.length > 30) return '住宿楼须有 1~30 项'
  if (buildings.some((b) => !/^[a-z][a-z0-9_-]{0,31}$/.test(b.code) || !b.name.trim())) return '请填写楼栋名称和有效代号（小写字母开头）'
  if (new Set(buildings.map((b) => b.code)).size !== buildings.length || new Set(buildings.map((b) => b.name.trim())).size !== buildings.length) return '楼栋代号和名称不能重复'
  return ''
})
function reset() { if (savedSite.value) draft.value = clone(savedSite.value); conflict.value = false }
function apply(result, replaceDraft = false) {
  const edited = dirty.value
  const changed = savedSite.value && JSON.stringify(result.site) !== JSON.stringify(savedSite.value)
  data.value = result
  savedSite.value = clone(result.site)
  if (replaceDraft || !edited) { draft.value = clone(result.site); conflict.value = false } else if (changed) conflict.value = true
}
async function load() {
  if (busy.value) return
  const request = ++generation
  loading.value = true; error.value = ''
  try { const result = await api('/api/admin/site'); if (!disposed && request === generation) apply(result) }
  catch (e) { if (!disposed && request === generation) error.value = e?.message || '网站配置读取失败' }
  finally { if (!disposed && request === generation) loading.value = false }
}
async function saveSite() {
  if (busy.value || siteValidation.value || !dirty.value || !data.value?.permissions.manageSite) return
  const outgoing = clone(draft.value), signature = JSON.stringify(draft.value)
  ++generation; loading.value = false; saving.value = true; error.value = ''
  try {
    const result = await api('/api/admin/site', { method: 'PATCH', body: outgoing })
    if (disposed) return
    apply(result, signature === JSON.stringify(draft.value)); await dorm.loadSite(); emit('changed'); showToast('网站设置已保存')
  } catch (e) { if (!disposed) error.value = e?.message || '保存失败，草稿已保留' }
  finally { if (!disposed) saving.value = false }
}
async function saveCredentials() {
  if (busy.value || !hasCredentialChanges.value || !data.value?.permissions.manageCredentials) return
  const credentials = {}
  for (const { key } of credentialFields) { if (clearFields.value[key]) credentials[key] = ''; else if (credentialDraft.value[key]?.trim()) credentials[key] = credentialDraft.value[key].trim() }
  ++generation; loading.value = false; credentialSaving.value = true; error.value = ''
  try {
    const result = await api('/api/admin/site', { method: 'PATCH', body: { credentials } })
    if (disposed) return
    apply(result)
    for (const [key, value] of Object.entries(credentials)) { if (clearFields.value[key] && !value) delete clearFields.value[key]; if (credentialDraft.value[key]?.trim() === value) delete credentialDraft.value[key] }
    showToast('通道配置已保存')
  } catch (e) { if (!disposed) error.value = e?.message || '通道配置保存失败' }
  finally { if (!disposed) credentialSaving.value = false }
}
async function changeMember(body) {
  if (busy.value) return false
  ++generation; loading.value = false
  memberBusy.value = true; error.value = ''
  try { const result = await api('/api/admin/site', { method: 'PATCH', body }); if (!disposed) { apply(result); showToast('后台权限已更新'); return true } }
  catch (e) { if (!disposed) error.value = e?.message || '权限更新失败' }
  finally { if (!disposed) memberBusy.value = false }
  return false
}
async function addAdmin() {
  if(memberBusy.value||!(data.value?.permissions.manageAdmins||data.value?.permissions.manageVolunteers))return
  if(memberRole.value==='volunteer'&&!memberBuildings.value.length){error.value='请至少选择一个授权巡检楼栋';return}
  if(await changeMember({admin:{userId:memberId.value.trim(),role:memberRole.value,buildings:memberRole.value==='volunteer'?[...memberBuildings.value]:[]}}))memberId.value=''
}
async function removeAdmin(member) {
  if(memberBusy.value||!(data.value?.permissions.manageAdmins||data.value?.permissions.manageVolunteers&&member.role==='volunteer'))return
  try{await showConfirmDialog({title:'移除此用户的管理权限？',message:'普通账号和数据将保留。'})}catch{return}
  await changeMember({removeAdmin:member.userId})
}
onMounted(load)
onUnmounted(() => { disposed = true; generation++ })
</script>

<style scoped>
.scope-buildings{display:flex;flex-wrap:wrap;gap:10px;border:1px solid var(--border);border-radius:8px;padding:10px}.scope-buildings label{display:flex;align-items:center;gap:4px}.scope-buildings input{width:auto!important}.member small{display:block;color:var(--text-dim);margin:5px 0}

.site-admin{padding:16px;margin:12px}.site-admin header,.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.site-admin header{justify-content:space-between}.site-admin h3{font-size:16px;margin:0}.site-admin h4{font-size:14px;margin:18px 0 12px}.dim{color:var(--text-dim);font-size:11px;line-height:1.7}.site-admin label{display:grid;gap:5px;font-size:12px;color:var(--text-dim);margin:10px 0}.site-admin input,.site-admin select,.site-admin button{min-height:36px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;background:var(--bg);color:var(--text);box-sizing:border-box}.site-admin button{cursor:pointer}.site-admin button:disabled,.site-admin fieldset:disabled{opacity:.55}.site-admin fieldset{border:0;margin:0;padding:0;min-width:0}.site-admin input{min-width:0;width:100%}.site-admin .primary{background:#2563eb;border-color:#2563eb;color:white}.building{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end;margin-bottom:10px}.building label{margin:0;min-width:0}.building .remove{padding:6px}.actions{margin-top:12px}.warning{font-size:12px;color:#fbbf24;line-height:1.7}.error{font-size:12px;color:#fca5a5;overflow-wrap:anywhere}.credentials{margin-top:22px;padding-top:16px;border-top:1px solid var(--border)}summary{font-size:14px;cursor:pointer}.credential{display:flex;gap:8px;align-items:center}.credential>label:first-child{flex:1;min-width:0}.configured{font-size:10px;color:#6ee7b7}.site-admin .clear{display:flex;gap:5px;align-items:center;padding-top:17px}.clear input{width:16px;min-height:16px;accent-color:#2563eb}.member{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:12px}.member>div{min-width:0;display:grid;gap:5px}.member span{font-size:11px;color:var(--text-dim)}.member code{font-size:11px;overflow-wrap:anywhere}.member button{flex:none}.add-member{display:grid;grid-template-columns:minmax(0,1fr) 100px;gap:8px;align-items:end}.add-member button{grid-column:1/-1}.site-admin select{color-scheme:dark}@media(max-width:360px){.building{grid-template-columns:1fr 1fr}.building .remove{grid-column:2;justify-self:end}.add-member{grid-template-columns:1fr}.add-member button{grid-column:auto}}
</style>
