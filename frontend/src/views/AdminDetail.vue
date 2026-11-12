<template>
  <div class="page adm">
    <van-nav-bar :title="title" left-text="返回" left-arrow @click-left="goBack" />

    <div class="admin-detail-content">
    <div v-if="error" class="request-error" role="alert">{{ error }}<button class="op" @click="reload">重试</button></div>
    <div v-if="loading" class="empty text-dim">读取中…</div>

    <!-- 用户管理 -->
    <template v-else-if="tab === 'users'">
      <div class="toolbar">
        <select v-model="selectedDorm" class="log-sel" aria-label="按住宿楼筛选用户" @change="changeDormFilter"><option value="">全部住宿楼</option><option v-for="b in buildings" :key="b.code" :value="b.code">{{ b.name }}</option><option value="unbound">未绑定住宿楼</option></select>
      </div>
      <div class="toolbar">
        <input v-model="userQ" class="q" placeholder="搜昵称 / 账号 ID / 钉钉 ID" @keyup.enter="loadUsers" />
        <van-button size="small" @click="loadUsers">搜索</van-button>
        <van-button size="small" :loading="exportingUsers" @click="exportUsers">导出脱敏 CSV</van-button>
      </div>
      <section v-if="bulkAccess.operate" class="bulk-users card" aria-label="批量用户管理">
        <div class="bulk-selection"><label><input type="checkbox" :checked="allVisibleSelected" :disabled="batchSaving || !selectableUsers.length" @change="selectVisibleUsers($event.target.checked)" />选择当前可操作用户</label><span>已选 {{ selectedUsers.length }} / 50</span></div>
        <div class="bulk-controls"><select v-model="bulkDorm" class="log-sel" aria-label="批量目标住宿楼" :disabled="batchSaving"><option value="">选择目标住宿楼</option><option v-for="b in bulkBuildings" :key="b.code" :value="b.code">{{ b.name }}</option><option v-if="bulkAccess.operateBuildings === null" value="__unbound__">清除住宿楼绑定</option></select><van-button size="small" :disabled="!selectedUsers.length || !bulkDorm || batchSaving" @click="batchUsers('setDorm')">修改住宿楼</van-button></div>
        <div class="bulk-controls"><van-button size="small" :disabled="!selectedUsers.length || batchSaving" @click="batchUsers('setNotify', true)">开启提醒</van-button><van-button size="small" :disabled="!selectedUsers.length || batchSaving" @click="batchUsers('setNotify', false)">关闭提醒</van-button><van-button size="small" type="danger" :disabled="!selectedUsers.length || batchSaving" @click="batchUsers('delete')">删除所选用户</van-button></div>
        <p class="text-dim">每次最多 50 人。未取衣任务、现场登记和高权限账号会受到额外保护。</p>
      </section>
      <section v-if="batchResult" class="batch-result card" role="status"><b>成功 {{ batchResult.succeeded }} 人，未完成 {{ batchResult.failed }} 人</b><p v-for="item in batchResult.results.filter(row => !row.ok)" :key="item.id">{{ item.id }}：{{ item.error?.message || '请刷新后核对' }}（{{ item.status }} · {{ item.error?.eventId || batchResult.eventId }}）</p></section>
      <div class="toolbar">
        <van-button size="small" block :loading="backfilling" @click="backfill">补全已绑定用户的手机号 / 钉钉昵称</van-button>
      </div>
      <div class="hint text-dim">共 {{ users.length }} 人（手机号默认脱敏）</div>
      <div v-for="u in users" :key="u.id" class="row card">
        <input v-if="u.canOperate" class="user-select" type="checkbox" :aria-label="'选择用户 ' + u.nick" :checked="selectedUsers.includes(u.id)" :disabled="batchSaving" @change="selectUser(u.id, $event.target.checked)" />
        <Avatar :seed="u.avatar" :src="u.avatarUrl" :size="38" />
        <div class="row-main">
          <div class="row-title">{{ u.nick }}<span class="dim-id">{{ u.id }}</span></div>
          <div class="row-sub text-dim">
            <span :class="u.dingBound ? 'ok' : 'off'">{{ u.dingBound ? '钉钉已绑' : '未绑钉钉' }}</span>
            <template v-if="u.dingNick"> · {{ u.dingNick }}</template>
            <template v-if="u.mobile"> · {{ u.mobile }}</template>
          </div>
          <label class="user-dorm">住宿楼<select v-model="u._dormDraft" :disabled="!u.canOperate || savingUser === u.id || batchSaving" aria-label="用户住宿楼"><option value="">未绑定</option><option v-for="b in buildings" :key="b.code" :value="b.code">{{ b.name }}</option></select><button class="op" :disabled="!u.canOperate || savingUser === u.id || batchSaving || (u.dormBuilding || '') === u._dormDraft" @click="saveUserDorm(u)">{{ savingUser === u.id ? '保存中…' : '保存' }}</button></label>
        </div>
        <div class="row-ops">
          <button class="op" @click="togglePhone(u)">{{ u._full ? '隐藏' : '全号' }}</button>
          <button v-if="u.canOperate && u.dingBound" class="op warn" :disabled="batchSaving" @click="unbind(u)">解绑</button>
          <button v-if="u.canOperate" class="op danger" :disabled="batchSaving" @click="removeUser(u)">删</button>
        </div>
      </div>
      <div v-if="!users.length" class="empty text-dim">没有匹配的用户</div>
    </template>

    <!-- 留言板管理 -->
    <template v-else-if="tab === 'messages'">
      <AdminCommunityReports />
      <div class="toolbar">
        <van-button size="small" @click="loadMessages">刷新</van-button>
        <van-button size="small" type="danger" @click="clearMessages">清空全部</van-button>
      </div>
      <div class="hint text-dim">共 {{ messages.length }} 条（管理端显示完整昵称）</div>
      <div v-for="m in messages" :key="m.id" class="row card">
        <div class="row-main">
          <div class="row-title">
            {{ m.nick || '匿名' }}
            <span v-if="m.machineName || m.machineId" class="tag">{{ m.machineName || m.machineId }}</span>
            <span class="dim-id">{{ fmtTime(m.at) }}</span>
          </div>
          <div class="row-text">{{ m.text }}</div>
        </div>
        <button class="op danger" @click="removeMessage(m)">删</button>
      </div>
      <div v-if="!messages.length" class="empty text-dim">留言板是空的</div>
    </template>

    <!-- 机器 / 机器状态 -->
    <template v-else-if="tab === 'machines'">
      <div class="toolbar">
        <select v-model="selectedDorm" class="log-sel" aria-label="按住宿楼筛选机器" @change="changeDormFilter"><option value="">全部住宿楼</option><option v-for="b in buildings" :key="b.code" :value="b.code">{{ b.name }}</option><option value="unbound">归属未知</option></select>
        <van-button size="small" @click="loadMachines">刷新</van-button>
        <span class="hint text-dim">数据于 {{ fmtTime(machineAt) }}</span>
      </div>
      <div v-for="r in machines" :key="r.id" class="row card">
        <div class="state-dot" :class="'st-' + r.state" />
        <div class="row-main">
          <div class="row-title">
            {{ r.displayName || r.remarkName || r.name || r.id }}
            <span class="tag">{{ r.dormBuildingName || '归属未知' }} · {{ floorText(r.floor) }}</span>
            <span class="tag">{{ r.kind === 'dryer' ? '烘干' : '洗衣' }}</span>
            <span v-if="r.slots?.length" class="tag">机位 {{ r.slots.join(' / ') }}</span>
            <span class="st-text" :class="'st-' + r.state">{{ stateText(r.state) }}</span>
          </div>
          <div v-if="(r.originalName || r.name) !== (r.displayName || r.remarkName || r.name)" class="row-sub text-dim">原名 {{ r.originalName || r.name }}</div>
          <div class="row-sub text-dim">
            <template v-if="r.leftMin != null">{{ r.state === 'idle' ? '已完成' : r.leftMin === 0 ? '即将完成' : `${r.estimated ? '预计' : '剩余'} ${r.leftMin} 分` }}</template>
            <template v-if="r.occupiedBy"> · 登记人 <button class="occupant-link" @click="openOccupant(r.occupiedBy)">{{ r.occupiedBy.nick || r.occupiedBy.userId }}</button></template>
            <template v-if="r.queueCount"> · 排队 {{ r.queueCount }}</template>
          </div>
        </div>
        <div class="row-ops">
          <button v-if="r.occupiedBy" class="op warn" @click="clearOcc(r)">清占用</button>
          <button v-if="r.queueCount" class="op" @click="clearQueue(r)">清排队</button>
        </div>
      </div>
      <div v-if="!machines.length" class="empty text-dim">还没拿到设备数据</div>
      <MachineFeedbackAdmin />
      <AdminMachineTimeCalibration />
    </template>

    <!-- 上报事件审计 -->
    <template v-else-if="tab === 'audits'">
      <div class="toolbar">
        <van-button size="small" @click="loadAudits">刷新</van-button>
        <van-button size="small" @click="purgePhotos">清理 30 天前照片</van-button>
      </div>
      <div class="stats-mini">
        <div><b>{{ summary.auditsToday ?? '—' }}</b><span>今日</span></div>
        <div><b>{{ summary.auditsTotal ?? '—' }}</b><span>累计</span></div>
        <div><b>{{ summary.messages ?? '—' }}</b><span>留言</span></div>
      </div>
      <div v-if="summary.topMachines?.length" class="hint text-dim">
        被申请最多：{{ summary.topMachines.map((x) => `${x.machineId}(${x.count})`).join('、') }}
      </div>
      <div v-for="a in audits" :key="a.auditId" class="row card">
        <div class="row-main">
          <div class="row-title">
            {{ a.machineId }}
            <span class="dim-id">{{ fmtTime(a.at) }}</span>
          </div>
          <div class="row-sub text-dim">
            申请人 {{ a.requesterNick || a.requesterId }} → 被查 {{ a.occupierNick || a.occupierId }}
            · 已提醒 {{ a.urgeCount }} 次
          </div>
          <div class="photos">
            <button class="op" @click="showPhoto(a.auditId, 'occ')">衣物占用照</button>
            <button class="op" @click="showPhoto(a.auditId, 'around')">机器周围照</button>
          </div>
        </div>
      </div>
      <div v-if="!audits.length" class="empty text-dim">还没有申请记录</div>
    </template>

    <!-- 操作日志审计：谁在什么时候对什么做了什么 -->
    <template v-else-if="tab === 'logs'">
      <div class="toolbar">
        <van-button size="small" @click="loadLogs">刷新</van-button>
        <van-button size="small" @click="exportLogs">导出 CSV</van-button>
      </div>

      <div class="log-filters">
        <select v-model="logType" class="log-sel" @change="loadLogs">
          <option value="">全部类型</option>
          <option v-for="(label, k) in logTypes" :key="k" :value="k">{{ label }}</option>
        </select>
        <select v-model="logLevel" class="log-sel" @change="loadLogs">
          <option value="">全部级别</option>
          <option value="info">普通</option>
          <option value="warn">警告</option>
          <option value="error">错误</option>
        </select>
        <select v-model.number="logDays" class="log-sel" @change="loadLogs">
          <option :value="1">今天</option>
          <option :value="3">近 3 天</option>
          <option :value="7">近 7 天</option>
          <option :value="30">近 30 天</option>
        </select>
      </div>

      <div class="log-search">
        <input v-model="logKeyword" class="log-input" placeholder="搜动作 / 机器 / 昵称 / 详情" @keyup.enter="loadLogs" />
        <van-button size="small" @click="loadLogs">搜索</van-button>
      </div>

      <div class="hint text-dim">共 {{ logTotal }} 条（最多显示 200 条，按时间倒序）</div>

      <div v-for="e in logs" :key="e.id" class="row card log-row" :class="'lv-' + e.level">
        <div class="row-main">
          <div class="row-title">
            <span class="log-type">{{ logTypes[e.type] || e.type }}</span>
            <span class="log-action">{{ e.action }}</span>
            <span class="dim-id">{{ fmtTime(e.at) }}</span>
          </div>
          <div class="row-sub text-dim">
            <template v-if="e.actorNick || e.actorId">
              {{ e.actorNick || '—' }}<template v-if="e.actorId">（{{ e.actorId }}）</template>
            </template>
            <template v-else>系统</template>
            <template v-if="e.target"> → {{ e.target }}</template>
          </div>
          <div v-if="detailText(e)" class="log-detail">{{ detailText(e) }}</div>
        </div>
      </div>
      <div v-if="!logs.length" class="empty text-dim">这段时间没有记录</div>
    </template>

    <van-popup v-model:show="photoShow" position="bottom" round>
      <div class="photo-wrap">
        <img v-if="photoUrl" :src="photoUrl" class="photo-img" alt="凭证照片" />
        <div v-else class="empty text-dim">照片不存在或已清理</div>
        <van-button block class="photo-close" @click="photoShow = false">关闭</van-button>
      </div>
    </van-popup>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api, BASE, getAdminSession, getToken } from '../api'
import Avatar from '../components/Avatar.vue'
import AdminCommunityReports from '../components/AdminCommunityReports.vue'
import MachineFeedbackAdmin from '../components/MachineFeedbackAdmin.vue'
import AdminMachineTimeCalibration from '../components/AdminMachineTimeCalibration.vue'
import { useDormStore } from '../stores/dorm'
import { normalizeDormBuilding } from '../../../packages/core/buildings.js'

const props = defineProps({ tab: { type: String, default: 'users' } })
const router = useRouter()
const route = useRoute()
const dorm = useDormStore()
const buildings = computed(() => dorm.buildings || [])
const initialDorm = String(route.query.dorm || '')
const selectedDorm = ref(normalizeDormBuilding(initialDorm, buildings.value) || (initialDorm === 'unbound' ? 'unbound' : ''))
let awaitingInitialDorm = Boolean(initialDorm && initialDorm !== 'unbound' && !selectedDorm.value)
const error = ref('')
const savingUser = ref('')
let usersRequest = 0
let machinesRequest = 0
let active = true

const loading = ref(false)
const title = computed(
  () =>
    ({
      users: '用户管理',
      messages: '留言板管理',
      machines: '机器状态',
      audits: '上报事件审计',
      logs: '操作日志',
    })[props.tab] || '管理'
)

const users = ref([])
const userQ = ref(String(route.query.q || ''))
const selectedUsers = ref([])
const bulkAccess = ref({ operate: false, operateBuildings: [] })
const bulkDorm = ref('')
const batchSaving = ref(false)
const batchResult = ref(null)
const exportingUsers = ref(false)
const selectableUsers = computed(() => users.value.filter(user => user.canOperate))
const allVisibleSelected = computed(() => selectableUsers.value.length > 0 && selectableUsers.value.every(user => selectedUsers.value.includes(user.id)))
const bulkBuildings = computed(() => buildings.value.filter(building => bulkAccess.value.operateBuildings === null || bulkAccess.value.operateBuildings?.includes(building.code)))
const messages = ref([])
const machines = ref([])
const machineAt = ref('')
const audits = ref([])
const summary = ref({})

const photoShow = ref(false)
const photoUrl = ref('')

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function stateText(s) {
  // 后端归一化后的状态就是 idle / occupied / faulty，
  // 之前字典写成 busy/offline，机器页直接显示英文 "occupied"。
  return (
    { idle: '空闲', occupied: '使用中', faulty: '故障', unknown: '未知' }[s] || s || '未知'
  )
}
function goBack() {
  return router.replace('/admin')
}
function openOccupant(user) {
  if (user?.userId) return router.push({ path: '/admin/users', query: { q: user.userId } })
}
function selectUser(id, checked) {
  if (batchSaving.value || !selectableUsers.value.some(user => user.id === id)) return
  if (checked && selectedUsers.value.length >= 50) return showToast('每次最多选择 50 人')
  selectedUsers.value = checked ? [...new Set([...selectedUsers.value, id])] : selectedUsers.value.filter(value => value !== id)
}
function selectVisibleUsers(checked) {
  if (batchSaving.value) return
  selectedUsers.value = checked ? selectableUsers.value.slice(0, 50).map(user => user.id) : []
  if (checked && selectableUsers.value.length > 50) showToast('已选择当前列表前 50 位可操作用户')
}
async function batchUsers(action, notifyOn) {
  if (batchSaving.value || !selectedUsers.value.length || selectedUsers.value.length > 50) return
  const ids = [...selectedUsers.value]
  const principal = getToken() + '|' + (getAdminSession()?.session || '')
  const body = { ids, action, confirmed: true }
  let description
  if (action === 'setDorm') {
    if (!bulkDorm.value) return
    body.dormBuilding = bulkDorm.value === '__unbound__' ? null : bulkDorm.value
    description = body.dormBuilding ? `更换住宿楼为「${bulkBuildings.value.find(b => b.code === body.dormBuilding)?.name || body.dormBuilding}」` : '清除住宿楼绑定'
  } else if (action === 'setNotify') { body.notifyOn = notifyOn; description = notifyOn ? '开启钉钉提醒' : '关闭钉钉提醒' }
  else if (action === 'delete') description = '永久删除用户及相关个人数据；有未取衣任务或登记的用户将跳过'
  else return
  batchSaving.value = true
  try { await showConfirmDialog({ title: `确认操作 ${ids.length} 位用户？`, message: description + '。系统会逐人校验权限，失败项会保留原因。' }) } catch { batchSaving.value = false; return }
  if (!active || props.tab !== 'users' || principal !== getToken() + '|' + (getAdminSession()?.session || '')) { batchSaving.value = false; return }
  batchResult.value = null
  try {
    const result = await adminApi('/api/admin/users/batch', { method: 'POST', body })
    if (!active) return
    batchResult.value = result
    selectedUsers.value = (result.results || []).filter(item => !item.ok).map(item => item.id)
    if (props.tab === 'users') await loadUsers()
  } catch (e) { showToast(e?.message || '批量操作未完成，请刷新后核对') }
  finally { batchSaving.value = false }
}
async function exportUsers() {
  if (exportingUsers.value) return
  const token = getToken(), session = getAdminSession()
  if (!token && !session?.session) return showToast('请先登录管理账号')
  exportingUsers.value = true
  try {
    const query = new URLSearchParams({ q: userQ.value.trim(), dorm: selectedDorm.value })
    const response = await fetch(BASE + '/api/admin/users.csv?' + query, { headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(session?.session ? { 'x-admin-token': session.session } : {}) }, cache: 'no-store' })
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(`${data.error?.message || '导出未完成'}（HTTP ${response.status}，事件 ${data.error?.eventId || response.headers.get('X-Event-ID') || 'client_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)}）`) }
    if (!active || token !== getToken() || session?.session !== getAdminSession()?.session) return
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a')
    try { link.href = url; link.download = `weshirt-users-${new Date().toISOString().slice(0, 10)}.csv`; link.click() } finally { URL.revokeObjectURL(url) }
  } catch (e) { const message = e?.message || '导出失败'; showToast(message.includes('事件 ') ? message : `${message}（网络 0，事件 client_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}）`) }
  finally { exportingUsers.value = false }
}
function floorText(value) { const s = String(value || ''); return /F$/i.test(s) ? s : s ? s + ' 层' : '楼层未知' }
function reload() { ({ users: loadUsers, messages: loadMessages, machines: loadMachines, audits: loadAudits, logs: loadLogs })[props.tab]?.() }
function adminApi(path, options = {}) { return api(path, { auth: 'optional', ...options }) }
function changeDormFilter() { awaitingInitialDorm = false; reload() }
watch(buildings, (catalog) => {
  const initial = awaitingInitialDorm ? normalizeDormBuilding(initialDorm, catalog) : null
  if (initial) { awaitingInitialDorm = false; selectedDorm.value = initial; reload() }
  else if (selectedDorm.value && selectedDorm.value !== 'unbound' && !normalizeDormBuilding(selectedDorm.value, catalog)) { selectedDorm.value = ''; reload() }
})

async function saveUserDorm(u) {
  if (savingUser.value) return
  savingUser.value = u.id
  try {
    const d = await adminApi('/api/admin/user/' + encodeURIComponent(u.id), { method: 'POST', body: { dormBuilding: u._dormDraft || null } })
    Object.assign(u, d.user || {}, { _dormDraft: d.user?.dormBuilding || '', _full: false })
    if (selectedDorm.value && (selectedDorm.value === 'unbound' ? Boolean(u.dormBuilding) : u.dormBuilding !== selectedDorm.value)) users.value = users.value.filter((x) => x.id !== u.id)
    showToast('住宿楼已保存')
  } catch (e) { showToast(e?.message || '住宿楼保存失败') }
  finally { savingUser.value = '' }
}

async function loadUsers() {
  const request = ++usersRequest
  loading.value = true
  error.value = ''
  try {
    const q = userQ.value.trim()
    const query = new URLSearchParams()
    if (q) query.set('q', q)
    if (selectedDorm.value) query.set('dorm', selectedDorm.value)
    const d = await adminApi('/api/admin/users?' + query)
    if (request === usersRequest) {
      users.value = (d.items || []).map((u) => ({ ...u, _full: false, _dormDraft: u.dormBuilding || '' }))
      bulkAccess.value = d.bulk || { operate: false, operateBuildings: [] }
      selectedUsers.value = selectedUsers.value.filter(id => users.value.some(user => user.id === id && user.canOperate))
    }
  } catch (e) {
    if (request === usersRequest) error.value = e?.message || '读取失败'
  } finally {
    if (request === usersRequest) loading.value = false
  }
}

// 补全历史用户资料（早于兜底逻辑绑定的用户没存手机号/钉钉昵称）
const backfilling = ref(false)
async function backfill() {
  if (backfilling.value) return
  backfilling.value = true
  try {
    const d = await adminApi('/api/admin/backfill-ding-profile?apply=1', { method: 'POST' })
    showToast(`扫描 ${d.scanned} 人，已绑定 ${d.bound}，补全 ${d.filled}`)
    await loadUsers()
  } catch (e) {
    showToast(e?.message || '补全失败')
  } finally {
    backfilling.value = false
  }
}

// 手机号全号：按需单独请求，避免列表接口把全号批量吐出来
async function togglePhone(u) {
  if (u._full) {
    try {
      const d = await adminApi('/api/admin/user/' + encodeURIComponent(u.id))
      Object.assign(u, d.user || {}, { _full: false })
    } catch (e) { showToast(e?.message || '隐藏失败') }
    return
  }
  try {
    const d = await adminApi('/api/admin/user/' + encodeURIComponent(u.id) + '?phone=1')
    u.mobile = d.user?.mobile || u.mobile
    u._full = true
  } catch (e) {
    showToast(e?.message || '读取失败')
  }
}

async function unbind(u) {
  try {
    await showConfirmDialog({ title: '解除钉钉绑定？', message: `${u.nick} 将收不到取衣提醒` })
  } catch {
    return
  }
  try {
    await adminApi('/api/admin/user/' + encodeURIComponent(u.id), { method: 'POST', body: { unbindDing: true } })
    u.dingBound = false
    u.dingNick = null
    showToast('已解绑')
  } catch (e) {
    showToast(e?.message || '操作失败')
  }
}

async function removeUser(u) {
  try {
    await showConfirmDialog({
      title: '删除用户？',
      message: `将删除 ${u.nick}（${u.id}）及其留言，不可恢复`,
    })
  } catch {
    return
  }
  try {
    const d = await adminApi('/api/admin/user/' + encodeURIComponent(u.id), { method: 'DELETE' })
    users.value = users.value.filter((x) => x.id !== u.id)
    showToast(`已删除${d?.removedMessages ? `，连带 ${d.removedMessages} 条留言` : ''}`)
  } catch (e) {
    showToast(e?.message || '删除失败')
  }
}

async function loadMessages() {
  loading.value = true
  try {
    const d = await adminApi('/api/admin/messages')
    messages.value = d.items || []
  } catch (e) {
    showToast(e?.message || '读取失败')
  } finally {
    loading.value = false
  }
}

async function removeMessage(m) {
  try {
    await showConfirmDialog({ title: '删除这条留言？', message: m.text })
  } catch {
    return
  }
  try {
    await adminApi('/api/admin/message/' + encodeURIComponent(m.id), { method: 'DELETE' })
    messages.value = messages.value.filter((x) => x.id !== m.id)
    showToast('已删除')
  } catch (e) {
    showToast(e?.message || '删除失败')
  }
}

async function clearMessages() {
  try {
    await showConfirmDialog({ title: '清空留言板？', message: `将删除全部 ${messages.value.length} 条，不可恢复` })
  } catch {
    return
  }
  try {
    const d = await adminApi('/api/admin/messages', { method: 'DELETE' })
    messages.value = []
    showToast(`已清空 ${d?.removed ?? 0} 条`)
  } catch (e) {
    showToast(e?.message || '操作失败')
  }
}

async function loadMachines() {
  const request = ++machinesRequest
  loading.value = true
  error.value = ''
  try {
    const d = await adminApi('/api/admin/machines' + (selectedDorm.value ? '?dorm=' + encodeURIComponent(selectedDorm.value) : ''))
    if (request === machinesRequest) { machines.value = d.rows || []; machineAt.value = d.updatedAt || '' }
  } catch (e) {
    if (request === machinesRequest) error.value = e?.message || '读取失败'
  } finally {
    if (request === machinesRequest) loading.value = false
  }
}

async function clearOcc(r) {
  try {
    await showConfirmDialog({ title: '清掉本地登记？', message: `${r.name || r.id} 的登记人 ${r.occupiedBy?.nick}` })
  } catch {
    return
  }
  try {
    await adminApi('/api/admin/machine/' + encodeURIComponent(r.id) + '/clear-occupancy', { method: 'POST' })
    r.occupiedBy = null
    showToast('已清除')
  } catch (e) {
    showToast(e?.message || '操作失败')
  }
}

async function clearQueue(r) {
  try {
    await showConfirmDialog({ title: '清掉这台机器的排队？', message: `共 ${r.queueCount} 人` })
  } catch {
    return
  }
  try {
    await adminApi('/api/admin/machine/' + encodeURIComponent(r.id) + '/clear-queue', { method: 'POST' })
    r.queueCount = 0
    showToast('已清除')
  } catch (e) {
    showToast(e?.message || '操作失败')
  }
}

async function loadAudits() {
  loading.value = true
  try {
    const [a, s] = await Promise.all([adminApi('/api/admin/urge-audits'), adminApi('/api/admin/audit-summary')])
    audits.value = a.items || []
    summary.value = s || {}
  } catch (e) {
    showToast(e?.message || '读取失败')
  } finally {
    loading.value = false
  }
}

async function showPhoto(auditId, kind) {
  photoUrl.value = ''
  photoShow.value = true
  try {
    const d = await adminApi(`/api/admin/urge-audit/${encodeURIComponent(auditId)}/photo/${kind}`)
    photoUrl.value = d.dataUrl || ''
  } catch (e) {
    showToast(e?.message || '照片读取失败')
  }
}

async function purgePhotos() {
  try {
    await showConfirmDialog({ title: '清理旧照片？', message: '会先统计 30 天前的凭证照片，确认后删除' })
  } catch {
    return
  }
  try {
    const d = await adminApi('/api/admin/purge-audit-photos?days=30&apply=1', { method: 'POST' })
    showToast(`已清理 ${d?.candidates ?? 0} 组照片`)
  } catch (e) {
    showToast(e?.message || '操作失败')
  }
}

// ---------- 操作日志审计 ----------
const logs = ref([])
const logTotal = ref(0)
const logTypes = ref({})
const logType = ref('')
const logLevel = ref('')
const logDays = ref(7)
const logKeyword = ref('')
const logLoading = ref(false)

async function loadLogs() {
  if (logLoading.value) return
  logLoading.value = true
  try {
    const qs = new URLSearchParams()
    if (logType.value) qs.set('type', logType.value)
    if (logLevel.value) qs.set('level', logLevel.value)
    if (logKeyword.value.trim()) qs.set('q', logKeyword.value.trim())
    qs.set('days', String(logDays.value || 7))
    qs.set('limit', '200')
    const d = await adminApi('/api/admin/audit-logs?' + qs.toString())
    logs.value = d.events || []
    logTotal.value = d.total || 0
    if (d.types) logTypes.value = d.types
  } catch (e) {
    showToast(e?.message || '日志读取失败')
  } finally {
    logLoading.value = false
  }
}

// 详情只展示扁平标量，太长就截断（后端已经过滤掉大对象）
function detailText(e) {
  const d = e?.detail
  if (!d || typeof d !== 'object') return ''
  return Object.entries(d)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ')
    .slice(0, 160)
}

// 导出 CSV：带口令走 header 不方便让浏览器直接下载，改用 blob
async function exportLogs() {
  try {
    const qs = new URLSearchParams()
    if (logType.value) qs.set('type', logType.value)
    if (logLevel.value) qs.set('level', logLevel.value)
    if (logKeyword.value.trim()) qs.set('q', logKeyword.value.trim())
    qs.set('days', String(logDays.value || 7))
    const token = getAdminSession()?.session || ''
    const bearer = getToken()
    if (!token && !bearer) throw new Error('请登录管理账号或返回后台重新登录')
    const headers = {}
    if (token) headers['x-admin-token'] = token
    if (bearer) headers.Authorization = 'Bearer ' + bearer
    const res = await fetch(BASE + '/api/admin/audit-logs.csv?' + qs.toString(), {
      headers,
    })
    if (!res.ok) throw new Error('导出失败（' + res.status + '）')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `weshirt-audit-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    showToast('已导出')
  } catch (e) {
    showToast(e?.message || '导出失败')
  }
}

watch(() => [props.tab, route.query.q], () => {
  usersRequest++; machinesRequest++; error.value = ''; selectedUsers.value = []; batchResult.value = null
  if (props.tab === 'users') userQ.value = String(route.query.q || '')
  reload()
}, { immediate: true })
let machineRefreshTimer
function refreshVisibleMachines(){if(active && props.tab==='machines' && !document.hidden && !loading.value)loadMachines()}
onMounted(()=>{machineRefreshTimer=setInterval(refreshVisibleMachines,30000);document.addEventListener('visibilitychange',refreshVisibleMachines);window.addEventListener('online',refreshVisibleMachines)})
onUnmounted(() => { active = false; usersRequest++; machinesRequest++;clearInterval(machineRefreshTimer);document.removeEventListener('visibilitychange',refreshVisibleMachines);window.removeEventListener('online',refreshVisibleMachines) })
</script>

<style scoped>
.bulk-users,.batch-result{margin:10px 12px;padding:12px;display:grid;gap:12px}.bulk-selection,.bulk-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.bulk-selection{justify-content:space-between;font-size:12px}.bulk-selection label{display:flex;align-items:center;gap:8px}.bulk-users input,.user-select{width:20px;height:20px;accent-color:var(--primary);flex:none}.user-select{margin:8px 0}.bulk-users p,.batch-result p{font-size:12px;line-height:1.6;margin:0;overflow-wrap:anywhere}.bulk-controls .log-sel{flex:1 1 150px}.batch-result b{font-size:13px}.occupant-link{border:0;background:transparent;color:#93c5fd;padding:4px;font:inherit;text-decoration:underline;cursor:pointer}
.request-error{margin:12px;padding:12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:10px;color:#fca5a5;font-size:12px;overflow-wrap:anywhere;display:flex;gap:10px;justify-content:space-between;align-items:center}.user-dorm{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--text-dim)}.user-dorm select{min-height:34px;max-width:130px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;color-scheme:dark}.op:disabled{opacity:.5;cursor:default}.st-unknown{background:#64748b}.st-text.st-unknown{color:#94a3b8}@media(max-width:420px){.toolbar{flex-wrap:wrap}.toolbar .q{min-width:180px}.row-ops{gap:9px}.row-ops .op{min-height:32px;padding:4px 8px}}
.adm { width: 100%; min-width: 0; padding-bottom: 24px; }
.admin-detail-content { width: 100%; max-width: 1200px; min-width: 0; margin: 0 auto; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 12px; }
.toolbar .q { min-width: 0; flex: 1 1 160px; }
.toolbar :deep(.van-button) { flex-shrink: 0; }
@media (min-width: 720px) { .admin-detail-content { padding: 0 20px 24px; } }
.q {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #eaf2fb;
  font-size: 13px;
  outline: none;
}
.hint { padding: 0 14px 8px; font-size: 12px; }

/* ---------- 操作日志 ---------- */
.log-filters { display: flex; gap: 8px; padding: 0 12px 8px; }
.log-sel {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #eaf2fb;
  font-size: 12px;
  outline: none;
  /* 原生下拉在深色页面里默认是白底白字（看不清），
     color-scheme 让浏览器直接渲染深色弹层，option 再兜一层 */
  color-scheme: dark;
  appearance: none;
  -webkit-appearance: none;
  padding-right: 22px;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath fill='%2394a3b8' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
}
.log-sel option {
  background: #131a26;
  color: #eaf2fb;
}
.log-search { display: flex; gap: 8px; padding: 0 12px 8px; }
.log-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #eaf2fb;
  font-size: 13px;
  outline: none;
}
.log-row { border-left: 3px solid transparent; }
.log-row.lv-warn { border-left-color: #f59e0b; }
.log-row.lv-error { border-left-color: #ef4444; background: rgba(239, 68, 68, 0.06); }
.log-type {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(125, 211, 252, 0.16);
  color: #9fd7ff;
  font-weight: 500;
}
.log-action { font-size: 13px; }
.log-detail {
  font-size: 11px;
  color: #8fa2b8;
  margin-top: 4px;
  line-height: 1.5;
  word-break: break-all;
}
.row { display: flex; align-items: flex-start; gap: 10px; margin: 8px 12px; padding: 10px 12px; }
.row-main { flex: 1; min-width: 0; }
.row-title { font-size: 14px; font-weight: 600; color: #eaf2fb; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dim-id { font-size: 11px; color: #7d8ea3; font-weight: 400; }
.row-sub { font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
.row-text { font-size: 13px; color: #cdd8e5; margin-top: 4px; word-break: break-word; }
.row-ops { display: flex; flex-direction: column; gap: 6px; flex: none; }
.op {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid rgba(125, 211, 252, 0.4);
  background: rgba(125, 211, 252, 0.12);
  color: #9fd7ff;
  cursor: pointer;
  white-space: nowrap;
}
.op.warn { border-color: rgba(251, 146, 60, 0.5); background: rgba(251, 146, 60, 0.14); color: #ffc08a; }
.op.danger { border-color: rgba(239, 68, 68, 0.5); background: rgba(239, 68, 68, 0.14); color: #ffb0b0; }
.ok { color: #22c55e; }
.off { color: #7d8ea3; }
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: #a8bdd2;
  font-weight: 400;
}
.state-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; }
.state-dot.st-idle { background: #22c55e; }
.state-dot.st-occupied { background: #f59e0b; }
.state-dot.st-faulty { background: #ef4444; }
.st-text { font-size: 12px; font-weight: 400; }
.st-text.st-idle { color: #22c55e; }
.st-text.st-occupied { color: #f59e0b; }
.st-text.st-faulty { color: #ef4444; }
.st-text.st-faulty { color: #ef4444; }
.stats-mini { display: flex; gap: 10px; padding: 0 12px 8px; }
.stats-mini > div {
  flex: 1;
  text-align: center;
  padding: 8px 0;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
}
.stats-mini b { display: block; font-size: 18px; color: #eaf2fb; }
.stats-mini span { font-size: 11px; color: #8fa3b8; }
.photos { display: flex; gap: 6px; margin-top: 6px; }
.photo-wrap { padding: 16px; }
.photo-img { width: 100%; border-radius: 10px; display: block; }
.photo-close { margin-top: 12px; }
.empty { padding: 28px 16px; text-align: center; font-size: 13px; }
</style>
