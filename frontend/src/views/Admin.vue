<template>
  <div class="page admin">
    <van-nav-bar title="管理" left-text="返回" left-arrow @click-left="goBack">
      <template #right>
        <div v-if="authed" class="nav-right">
          <span class="conn">
            <i class="dot" :class="syncOk ? 'ok' : 'bad'" />
            {{ syncOk ? '已连接' : '同步卡住了' }}
          </span>
          <span v-if="sessionLeftMin !== null" class="session-left" :class="{ low: sessionLeftMin <= 30 }">
            {{ sessionLeftMin > 0 ? `${sessionLeftMin} 分钟后失效` : '即将失效' }}
          </span>
          <span class="logout-mini" @click="lock">退出</span>
        </div>
      </template>
    </van-nav-bar>

    <!-- 未验证口令 -->
    <div v-if="!authed" class="gate">
      <div class="gate-card card">
        <div class="gate-icon"><van-icon name="shield-o" /></div>
        <h2>管理口令</h2>
        <p class="text-dim gate-desc">
          口令只用来换一张 <b>12 小时</b> 的通行证，不会存在这台设备上。到期需要重新输入。
        </p>
        <input
          v-model="tokenInput"
          class="gate-input"
          type="password"
          placeholder="口令"
          autocomplete="current-password"
          @keyup.enter="unlock"
        />
        <van-button type="primary" block :loading="unlocking" @click="unlock">进入</van-button>
        <van-button block plain @click="useAccount">使用当前钉钉账号管理</van-button>
        <p v-if="gateError" class="gate-err">{{ gateError }}</p>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-else-if="!status" class="loading text-dim"><template v-if="gateError">{{ gateError }}<van-button size="small" @click="load">重试</van-button></template><template v-else>读取中…</template></div>

    <!-- 已登录 -->
    <template v-else>
      <section class="hero card">
        <div class="hero-top">
          <span class="badge" :class="status.mode === 'real' ? 'live' : 'mock'">
            {{ status.mode === 'real' ? '实时' : '模拟' }}
          </span>
          <span class="hero-building">{{ status.building.name || status.building.id }}</span>
        </div>
        <div class="hero-sub text-dim">
          {{ status.haier.base || '还没填接口地址' }}
          <template v-if="status.haier.positionId"> · 点位 {{ status.haier.positionId }}</template>
        </div>
        <div class="hero-sync">
          <i class="dot" :class="syncOk ? 'ok' : 'bad'" />
          <span>{{ syncHeadline }}</span>
        </div>
        <div v-if="status.sync && status.sync.lastError" class="hero-err">{{ status.sync.lastError }}</div>
      </section>

      <section class="block card">
        <header><h3>住宿楼概览</h3><span class="text-dim">按真实设备归属统计</span></header>
        <div class="dorm-tabs"><button :class="{ active: !selectedDorm }" @click="selectedDorm = ''">全部</button><button v-for="b in status.dormBuildings || []" :key="b.code" :class="{ active: selectedDorm === b.code }" @click="selectedDorm = b.code">{{ b.name }} · {{ b.total }}</button></div>
        <div class="actions"><van-button size="small" @click="go('/admin/machines')">查看机器</van-button><van-button size="small" @click="go('/admin/users')">管理住宿楼用户</van-button></div>
      </section>
      <div class="stats">
        <div class="stat">
          <b>{{ summaryBoard?.total ?? '—' }}</b><span>总设备</span>
        </div>
        <div class="stat idle">
          <b>{{ summaryBoard?.idle ?? '—' }}</b><span>空闲</span>
        </div>
        <div class="stat occ">
          <b>{{ summaryBoard?.occupied ?? '—' }}</b><span>占用</span>
        </div>
        <div class="stat fal">
          <b>{{ summaryBoard?.faulty ?? '—' }}</b><span>故障</span>
        </div>
      </div>

      <section class="block card">
        <header>
          <h3>全校各层情况</h3>
          <span class="text-dim">空闲 · 占用 · 故障</span>
        </header>
        <div v-for="f in floors" :key="f.code" class="floor-row">
          <div class="floor-label">
            <span>{{ f.code }} 层</span>
            <em>{{ f.total }} 台</em>
          </div>
          <div class="bar">
            <i class="seg idle" :style="{ width: pct(f.idle, f.total) }" />
            <i class="seg occ" :style="{ width: pct(f.occupied, f.total) }" />
            <i class="seg fal" :style="{ width: pct(f.faulty, f.total) }" />
          </div>
          <div class="floor-legend">
            <span class="state-idle">{{ f.idle }}</span>
            <span class="state-occupied">{{ f.occupied }}</span>
            <span class="state-faulty">{{ f.faulty }}</span>
          </div>
        </div>
        <div v-if="!floors.length" class="empty-line text-dim">还没拿到设备数据</div>
      </section>

      <section class="block card">
        <header><h3>同步</h3></header>
        <div class="actions">
          <van-button type="primary" block :loading="syncing" @click="triggerSync">立即同步</van-button>
          <van-button block class="btn-ghost" :loading="loading" @click="refresh">刷新</van-button>
        </div>
        <div class="kv"><span>上次同步</span><b>{{ lastSyncText }}</b></div>
        <div class="kv">
          <span>连续失败</span>
          <b :class="{ 'state-faulty': failCount > 0 }">{{ failCount }}</b>
        </div>
        <div class="kv"><span>数据更新于</span><b>{{ boardTimeText }}</b></div>
      </section>

      <section class="block card">
        <header>
          <h3>桂园现场机位绑定</h3>
          <span class="text-dim">已绑 {{ boundCount }}/{{ SLOTS.length }}</span>
        </header>
        <div class="slot-hint text-dim">按现场设备 ID 人工核对。设备名称中的机号不代表现场机位。</div>
        <p v-if="mapDirty" class="map-note">有未保存的修改，刷新和同步会保留草稿。</p>
        <p v-if="mappingConflict" class="map-warning">服务器绑定已变化；请对照最新配置后再保存草稿。</p>
        <p v-for="issue in mappingIssues" :key="issue" class="map-warning">{{ issue }}</p>
        <div
          v-for="s in SLOTS"
          :key="s.key"
          class="slot-row"
          @click="openPicker(s.key)"
        >
          <span class="slot-name">{{ s.label }}</span>
          <span class="slot-dev" :class="{ none: !draft[s.key] }">
            {{ deviceText(draft[s.key]) || '未绑定' }}
          </span>
          <van-icon name="arrow" class="slot-arrow" />
        </div>
        <div class="actions slot-actions">
          <van-button block class="btn-ghost" :disabled="!mapDirty || savingMap" @click="resetMapping">恢复已保存</van-button>
          <van-button block type="primary" :loading="savingMap" :disabled="!mapDirty || mappingIssues.length > 0" @click="saveMapping">保存绑定</van-button>
        </div>
      </section>

      <section class="block card">
        <header>
          <h3>钉钉</h3>
          <span class="badge sm" :class="dingReady ? 'live' : 'mock'">{{ dingReady ? '已配置' : '未配置' }}</span>
        </header>
        <div class="chips">
          <span class="chip" :class="{ on: status.dingtalk.configured }">应用</span>
          <span class="chip" :class="{ on: status.dingtalk.robot }">机器人</span>
          <span class="chip" :class="{ on: status.dingtalk.callback }">回调</span>
          <span class="chip" :class="{ on: status.dingtalk.webhook }">群通道（仅手动测试）</span>
        </div>
        <div class="bind">
          <div class="bind-note text-dim">
            群内自动播报已停止。洗完提醒、催取衣与异常提醒通过私聊发送。用户统一从「钉钉登录」进入，登录后自动关联身份。
          </div>
          <van-button block @click="go('/login')">打开钉钉登录入口</van-button>
        </div>
      </section>

      <AdminSite /><AdminPermissions /><AdminBuildingGroups /><AdminModeration />
      <AdminTelemetry />
      <AdminOperations />
      <AdminAnnouncements />
      <AdminAI />

      <section class="block card">
        <header>
          <h3>管理</h3>
          <span class="text-dim">点进去看详情</span>
        </header>
        <div class="nav-list">
          <div class="nav-item" @click="go('/admin/users')">
            <span class="nav-name">用户管理</span>
            <span class="nav-meta text-dim">{{ status.counts.users }} 人</span>
            <van-icon name="arrow" />
          </div>
          <div class="nav-item" @click="go('/admin/messages')">
            <span class="nav-name">留言板管理</span>
            <span class="nav-meta text-dim">{{ status.counts.messages }} 条</span>
            <van-icon name="arrow" />
          </div>
          <div class="nav-item" @click="go('/admin/machines')">
            <span class="nav-name">机器 / 状态</span>
            <span class="nav-meta text-dim">{{ status.board ? status.board.total : 0 }} 台</span>
            <van-icon name="arrow" />
          </div>
          <div class="nav-item" @click="go('/admin/audits')">
            <span class="nav-name">上报事件审计</span>
            <span class="nav-meta text-dim">手机号查看留档</span>
            <van-icon name="arrow" />
          </div>
          <div class="nav-item" @click="go('/admin/logs')">
            <span class="nav-name">操作日志</span>
            <span class="nav-meta text-dim">登录 / 登记 / 催取 / 通知</span>
            <van-icon name="arrow" />
          </div>
        </div>
      </section>

      <!-- 发消息测试：直接发一条真实的取衣通知卡片，用来确认通道有没有通 -->
      <section class="card sec">
        <header class="sec-head">
          <h2>发消息测试</h2>
          <span class="text-dim">发一条真实的取衣提醒卡片</span>
        </header>
        <div class="sec-notify">
          <van-button
            size="small"
            type="primary"
            :loading="notifyTesting === 'dm'"
            @click="sendTestMsg('dm')"
          >
            发到我的钉钉
          </van-button>
          <van-button
            size="small"
            :loading="notifyTesting === 'group'"
            :disabled="!notifyState.group.ready"
            @click="sendTestMsg('group')"
          >
            手动群测试（会发消息）
          </van-button>
        </div>
        <div v-if="notifyResult" class="notify-result" :class="{ bad: !notifyResult.ok }">
          {{ notifyResult.text }}
        </div>
        <div class="notify-channels text-dim">
          自动群播报已停用 · 私聊 {{ notifyState.dm.ready ? '就绪' : '未就绪' }} · 手动群测试
          {{ notifyState.group.ready ? `就绪（${notifyState.group.via}）` : '未就绪' }}
        </div>
      </section>

      <!-- 同步心跳：提醒是同步时发的，没人开页面就不会同步 -->
      <section class="card sec">
        <header class="sec-head">
          <h2>同步心跳</h2>
          <span class="text-dim">CloudBase 每 5 分钟触发</span>
        </header>
        <div class="sec-notify">
          <van-button size="small" :loading="syncUrlLoading" @click="loadSyncUrl">获取手动地址</van-button>
          <van-button size="small" v-if="syncUrl" @click="copySyncUrl">复制</van-button>
          <van-button size="small" v-if="syncUrl" :loading="syncNowLoading" @click="runSyncNow">立即同步</van-button>
        </div>
        <div v-if="syncUrl" class="sync-url">{{ syncUrl }}</div>
        <div class="notify-channels text-dim">
          定时同步由 CloudBase 云函数 <b>weshirt-sync-ping</b> 托管（定时触发器
          <b>0 */5 * * * * *</b>，每 5 分钟）。上面的地址只是手动排查用，只有「触发同步」权限。
        </div>
        <div v-if="syncHint" class="notify-result" :class="{ bad: syncHint.bad }">{{ syncHint.text }}</div>
      </section>

      <!-- 上游账号池：多账号轮询，被限流自动切换 -->
      <section v-if="status && status.haier" class="card sec">
        <header class="sec-head">
          <h2>上游账号池</h2>
          <span class="text-dim">{{ status.haier.poolSize }} 个账号</span>
        </header>
        <div class="notify-channels text-dim">
          <template v-if="status.haier.poolSize > 1">
            当前第 <b>{{ status.haier.poolCurrent }}</b> 个；每次同步自动换下一个。
            <template v-if="status.haier.poolCooling.length">
              冷却中：
              <b>{{ status.haier.poolCooling.map((c) => `#${c.account}（${Math.ceil(c.secondsLeft / 60)} 分钟）`).join('、') }}</b>
            </template>
            <template v-else>没有账号在冷却。</template>
          </template>
          <template v-else>
            只配了 1 个账号。再加几个（<code>HAIER_ACCOUNTS</code>）可以分摊上游请求，
            某个被限流时自动切换。
          </template>
        </div>

        <!-- token 列表：过期时间比「同步失败」更早知道问题 -->
        <div class="acct-list">
          <div class="acct-head">
            <span class="text-dim">
              共 {{ accounts.length }} 个号{{ probedAt ? `，上次检测 ${probedAt.slice(11, 16)}` : '' }}
            </span>
            <van-button size="mini" :loading="probing" @click="probeAccounts">检测存活</van-button>
          </div>
          <div v-for="a in accounts" :key="a.index" class="acct-row">
            <div class="acct-main">
              <i class="acct-dot" :class="a.alive === null ? 'unk' : a.alive ? 'ok' : 'bad'" />
              <span class="acct-idx">#{{ a.index }}</span>
              <span class="acct-label">{{ a.label }}</span>
              <span class="acct-exp" :class="{ warn: a.expired || (a.daysLeft !== null && a.daysLeft <= 3) }">
                {{ a.expired ? '已过期' : a.daysLeft === null ? '过期时间未知' : `剩 ${a.daysLeft} 天` }}
              </span>
              <span v-if="a.coolingSec" class="acct-cool">冷却 {{ Math.ceil(a.coolingSec / 60) }} 分钟</span>
              <span v-if="a.alive === false" class="acct-bad">{{ a.probeHint }}</span>
            </div>
            <van-button size="mini" plain @click="startEdit(a)">换 token</van-button>
          </div>
          <div v-if="!accounts.length" class="text-dim">还没有读到账号池。</div>
        </div>

        <div v-if="editIndex" class="acct-edit">
          <div class="text-dim">更新 #{{ editIndex }} 的 token（存 KV，立即生效，不用重新部署）</div>
          <van-field v-model="editLabel" label="备注" placeholder="可选，比如「我的号」" maxlength="16" />
          <van-field
            v-model="editToken"
            rows="3"
            autosize
            type="textarea"
            label="token"
            placeholder="粘贴 Bearer xxx 或裸 JWT"
          />
          <div class="acct-actions">
            <van-button size="small" type="primary" :loading="savingToken" @click="saveToken">保存</van-button>
            <van-button size="small" plain @click="cancelEdit">取消</van-button>
          </div>
        </div>
        <div v-if="acctHint" class="notify-result" :class="{ bad: acctHint.bad }">{{ acctHint.text }}</div>

        <!-- 短信登录：验证码由本人接收，服务端只做两次转发 -->
        <div class="acct-edit">
          <div class="text-dim">
            短信登录（验证码自己收，填进来即可；需要先在环境变量配好 <code>HAIER_LOGIN</code>）
          </div>
          <van-field v-model="smsPhone" label="手机号" placeholder="11 位手机号" maxlength="11" type="tel" />
          <div class="acct-actions">
            <van-button
              size="small"
              :loading="sendingSms"
              :disabled="smsCountdown > 0"
              @click="sendSms"
            >
              {{ smsCountdown > 0 ? `${smsCountdown}s 后重发` : '发送验证码' }}
            </van-button>
          </div>
          <van-field v-model="smsCode" label="验证码" placeholder="短信里的数字" maxlength="8" type="digit" />
          <div class="acct-actions">
            <van-button size="small" type="primary" :loading="loggingIn" @click="smsLogin">登录并写入账号</van-button>
          </div>
        </div>
        <div v-if="smsHint" class="notify-result" :class="{ bad: smsHint.bad }">{{ smsHint.text }}</div>

        <!-- 批量导入：一行一个 token，最省事 -->
        <div class="acct-edit">
          <div class="text-dim">
            批量导入（一行一个，支持 <code>标签, Bearer xxx</code>；导入后以这批为准，最多 20 个）
          </div>
          <van-field
            v-model="importText"
            rows="4"
            autosize
            type="textarea"
            placeholder="我, Bearer eyJ...&#10;室友, Bearer eyJ..."
          />
          <div class="acct-actions">
            <van-button size="small" type="primary" :loading="importing" @click="importAccounts">导入</van-button>
          </div>
        </div>
        <div v-if="importHint" class="notify-result" :class="{ bad: importHint.bad }">{{ importHint.text }}</div>
      </section>

      <div class="exit">
        <button class="exit-btn" @click="lock">退出</button>
      </div>
      <p class="foot text-dim">口令只存在这台设备上。</p>
    </template>

    <van-popup v-model:show="pickerShow" position="bottom" round>
      <div class="picker-filters"><h3>{{ pickerSlot }} 号位 · 人工选择设备</h3><input v-model="pickerSearch" placeholder="搜索设备名 / ID" /><select v-model="pickerDorm"><option value="">全部住宿楼</option><option v-for="b in DORM_BUILDINGS" :key="b.code" :value="b.code">{{ b.name }}</option></select><p class="text-dim">已在其他机位使用的设备不可重复绑定。</p></div>
      <van-picker
        :columns="pickerColumns"
        :model-value="[pickerValue || '']"
        show-toolbar
        title="选择真实设备"
        @confirm="onPickSlot"
        @cancel="pickerShow = false"
      />
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api, getAdminSession, setAdminSession, clearAdminSession } from '../api'
import { useUserStore } from '../stores/user'
import AdminSite from '../components/AdminSite.vue'
import AdminBuildingGroups from '../components/AdminBuildingGroups.vue'
import AdminModeration from '../components/AdminModeration.vue'
import AdminPermissions from '../components/AdminPermissions.vue'
import AdminTelemetry from '../components/AdminTelemetry.vue'
import AdminOperations from '../components/AdminOperations.vue'
import AdminAnnouncements from '../components/AdminAnnouncements.vue'
import AdminAI from '../components/AdminAI.vue'
import { DORM_BUILDINGS } from '../../../packages/core/buildings.js'

const router = useRouter()
const userStore = useUserStore()

const tokenInput = ref('')
const adminToken = ref('')
const accountMode = ref(false)
let accessRevision = 0
const authed = ref(false)
const unlocking = ref(false)
const gateError = ref('')
const sessionExpAt = ref(0)
let tickTimer = null

// 会话剩余时间（每分钟刷新一次，到点自动回到口令页）
const nowTick = ref(Date.now())
const sessionLeftMin = computed(() => {
  if (!sessionExpAt.value) return null
  return Math.max(0, Math.round((sessionExpAt.value - nowTick.value) / 60000))
})

const status = ref(null)
const loading = ref(false)
const syncing = ref(false)
const selectedDorm = ref('')
const summaryBoard = computed(() => selectedDorm.value ? status.value?.dormBuildings?.find((b) => b.code === selectedDorm.value) : status.value?.board)

// 3D 场景固定机位（与 Room3D.vue 的 SLOTS 一致，按现场从门口往里排）
const SLOTS = [
  { key: 'D1', label: 'D1 烘干位' },
  { key: '1', label: '1 号机位' },
  { key: '2', label: '2 号机位' },
  { key: '3', label: '3 号机位' },
  { key: '4', label: '4 号机位' },
  { key: 'D2', label: 'D2 烘干位' },
  { key: '7', label: '7 号机位' },
  { key: '6', label: '6 号机位' },
  { key: '5', label: '5 号机位' }
]
const devices = ref([])
const draft = ref({})
const savedMapping = ref({})
const mappingLoaded = ref(false)
const mappingConflict = ref(false)
let mapRevision = 0
const mapSignature = (mapping) => JSON.stringify(SLOTS.map((s) => [s.key, String(mapping?.[s.key] || '')]))
const mapDirty = computed(() => mapSignature(draft.value) !== mapSignature(savedMapping.value))
const savingMap = ref(false)
const pickerShow = ref(false)
const pickerSlot = ref('')
const pickerValue = ref('')
const pickerSearch = ref('')
const pickerDorm = ref('')

const pickerColumns = computed(() => [
  { text: '不绑定', value: '' },
  ...devices.value.filter((d) => (!pickerDorm.value || d.dormBuilding === pickerDorm.value) && `${d.name} ${d.id}`.toLowerCase().includes(pickerSearch.value.trim().toLowerCase()))
    .map((d) => ({ text: `${d.name} · ${d.id}`, value: String(d.id), disabled: SLOTS.some((s) => s.key !== pickerSlot.value && String(draft.value[s.key] || '') === String(d.id)) }))
])
const boundCount = computed(() => SLOTS.filter((s) => draft.value[s.key]).length)
const mappingIssues = computed(() => {
  const issues = []
  const assigned = new Map()
  for (const slot of SLOTS) {
    const id = draft.value[slot.key]
    if (!id) continue
    if (mappingLoaded.value && !deviceById(id)) issues.push(`${slot.key}：设备 ${id} 不在最新看板中，请重新选择或解除绑定`)
    if (assigned.has(String(id))) issues.push(`${slot.key} 与 ${assigned.get(String(id))} 重复使用设备 ${id}`)
    assigned.set(String(id), slot.key)
  }
  return issues
})

function deviceById(id) {
  if (!id) return null
  return devices.value.find((d) => String(d.id) === String(id)) || null
}
function deviceText(id) {
  if (!id) return ''
  const d = deviceById(id)
  return d ? `${d.name} · ${d.id}` : `设备失效 / 未查到 · ${id}`
}
function openPicker(key) {
  pickerSlot.value = key
  pickerValue.value = draft.value[key] || ''
  pickerSearch.value = ''
  pickerDorm.value = ''
  pickerShow.value = true
}
function onPickSlot({ selectedOptions }) {
  const opt = selectedOptions && selectedOptions[0]
  if (opt?.disabled) return
  if (opt?.value && SLOTS.some((s) => s.key !== pickerSlot.value && String(draft.value[s.key] || '') === String(opt.value))) { showToast('这台设备已经绑定其他机位'); return }
  const next = { ...draft.value }
  if (opt && opt.value) next[pickerSlot.value] = String(opt.value)
  else delete next[pickerSlot.value]
  draft.value = next
  mapRevision++
  pickerShow.value = false
}

async function resetMapping() {
  try { await showConfirmDialog({ title: '放弃未保存的绑定？', message: '恢复最近一次读取到的服务器配置。' }) } catch { return }
  draft.value = { ...savedMapping.value }
  mapRevision++
  mappingConflict.value = false
}

async function saveMapping() {
  if (savingMap.value || !mapDirty.value) return
  if (mappingIssues.value.length) { showToast(mappingIssues.value[0]); return }
  if (mappingConflict.value) {
    try { await showConfirmDialog({ title: '覆盖服务器绑定？', message: '服务器绑定在你编辑期间发生变化，请确认草稿仍与现场一致。' }) } catch { return }
  }
  savingMap.value = true
  try {
    const requestRevision = mapRevision
    const requestToken = adminToken.value
    const requestAccess = accessRevision
    const payload = {}
    for (const s of SLOTS) payload[s.key] = draft.value[s.key] || null
    const r = await api('/api/mapping?building=b1', {
      method: 'POST',
      auth: 'optional',
      headers: { 'X-Admin-Token': adminToken.value },
      body: { mapping: payload }
    })
    if (requestToken !== adminToken.value || requestAccess !== accessRevision) return
    const remote = { ...(r.mapping || {}) }
    if (requestRevision === mapRevision) draft.value = { ...remote }
    savedMapping.value = remote
    mappingConflict.value = false
    showToast('绑定已保存')
  } catch (e) {
    showToast((e && e.message) || '保存失败')
  } finally {
    savingMap.value = false
  }
}

const bindCode = ref('')
const codeLeft = ref(0)
const codeLoading = ref(false)
let codeTimer = null

const floors = computed(() => (status.value && status.value.board ? status.value.board.floors || [] : []))
const failCount = computed(() => (status.value && status.value.sync ? status.value.sync.failCount || 0 : 0))
const syncOk = computed(() => {
  const s = status.value && status.value.sync
  if (!s || !s.lastFetchAt) return false
  if ((s.failCount || 0) > 0) return false
  const age = Date.now() - new Date(s.lastFetchAt).getTime()
  return age >= 0 && age < 5 * 60 * 1000
})
const dingReady = computed(() => {
  const d = status.value && status.value.dingtalk
  return Boolean(d && d.configured)
})

const syncHeadline = computed(() => {
  const s = status.value && status.value.sync
  if (!s || !s.lastFetchAt) return '还没同步成功过'
  return syncOk.value ? '数据正常' : '同步卡住了'
})

function relTime(iso) {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  if (d < 30) return d + ' 天前'
  return new Date(t).toLocaleDateString()
}

const lastSyncText = computed(() => {
  const s = status.value && status.value.sync
  if (!s || !s.lastFetchAt) return '—'
  return relTime(s.lastFetchAt)
})
const boardTimeText = computed(() => {
  const b = status.value && status.value.board
  if (!b || !b.updatedAt) return '—'
  return relTime(b.updatedAt)
})

function pct(n, total) {
  if (!total) return '0%'
  return ((n / total) * 100).toFixed(2) + '%'
}

async function load() {
  if (!adminToken.value && !accountMode.value) return
  if (loading.value) return
  const requestToken = adminToken.value
    const requestAccess = accessRevision
  loading.value = true
  try {
    const [data, machinesData] = await Promise.all([
      api('/api/admin/status', {
        auth: 'optional',
        headers: { 'X-Admin-Token': adminToken.value }
      }),
      api('/api/admin/machines', { auth: 'optional', headers: { 'X-Admin-Token': requestToken } }),
    ])
    if (requestToken !== adminToken.value || requestAccess !== accessRevision) return
    status.value = data
    authed.value = true
    gateError.value = ''

    const remote = { ...(machinesData.mapping?.mapping || {}) }
    const wasDirty = mapDirty.value
    if (!mappingLoaded.value || !wasDirty) draft.value = { ...remote }
    else if (mapSignature(remote) !== mapSignature(savedMapping.value)) mappingConflict.value = true
    savedMapping.value = remote
    devices.value = (machinesData.rows || []).map((m) => ({ ...m, id: String(m.id) }))
    mappingLoaded.value = true
  } catch (e) {
    const msg = (e && e.message) || '读取失败'
    if (/40[13]|后台登录已过期/.test(msg)) {
      authed.value = false
      status.value = null
      adminToken.value = ''
      clearAdminSession()
      gateError.value = '后台登录已过期，请重新输入口令'
    } else {
      gateError.value = msg
      if (authed.value) showToast(msg)
    }
  } finally {
    loading.value = false
  }
}

// ---------- 同步心跳 ----------
const syncUrl = ref('')
const syncUrlLoading = ref(false)
const syncNowLoading = ref(false)
const syncHint = ref(null)

async function loadSyncUrl() {
  syncUrlLoading.value = true
  syncHint.value = null
  try {
    const d = await api('/api/admin/sync-url')
    syncUrl.value = d.url || ''
    if (!syncUrl.value) syncHint.value = { bad: true, text: '没拿到地址，检查 AUTH_SECRET 是否已配置' }
  } catch (e) {
    syncHint.value = { bad: true, text: e?.message || '获取失败' }
  } finally {
    syncUrlLoading.value = false
  }
}

async function copySyncUrl() {
  try {
    await navigator.clipboard.writeText(syncUrl.value)
    showToast('已复制')
  } catch {
    showToast('复制失败，长按选择复制')
  }
}

async function runSyncNow() {
  if (syncNowLoading.value) return
  syncNowLoading.value = true
  syncHint.value = null
  try {
    const r = await fetch(syncUrl.value, { method: 'POST' })
    const d = await r.json().catch(() => null)
    if (!r.ok) throw new Error(d?.error?.message || '同步失败（' + r.status + '）')
    syncHint.value = {
      text: `已同步：拉到 ${d?.fetched ?? 0} 台，本次发出提醒 ${d?.notified ?? 0} 条`,
    }
    await load() // 刷新看板数字
  } catch (e) {
    syncHint.value = { bad: true, text: e?.message || '同步失败' }
  } finally {
    syncNowLoading.value = false
  }
}

// ---------- 账号池 token ----------
const accounts = ref([])
const editIndex = ref(0)
const editToken = ref('')
const editLabel = ref('')
const savingToken = ref(false)
const acctHint = ref(null)
const probing = ref(false)
const probedAt = ref('')

async function probeAccounts() {
  if (probing.value) return
  probing.value = true
  acctHint.value = null
  try {
    const d = await api('/api/admin/accounts/probe', { method: 'POST', body: {} })
    accounts.value = d.results.map((r, i) => ({ ...(accounts.value[i] || {}), ...r, probedAt: d.at }))
    probedAt.value = d.at
    // 重新拉一次拿到剩余天数等字段
    await loadAccounts()
    acctHint.value = { text: `${d.alive}/${d.total} 个账号可用`, bad: d.alive === 0 }
  } catch (e) {
    acctHint.value = { bad: true, text: e?.message || '检测失败' }
  } finally {
    probing.value = false
  }
}

async function loadAccounts() {
  try {
    const d = await api('/api/admin/accounts')
    accounts.value = d.accounts || []
    if (d.probedAt) probedAt.value = d.probedAt
  } catch (e) {
    acctHint.value = { bad: true, text: e?.message || '账号池读取失败' }
  }
}

function startEdit(a) {
  editIndex.value = a.index
  editLabel.value = a.label || ''
  editToken.value = ''
  acctHint.value = null
}

function cancelEdit() {
  editIndex.value = 0
  editToken.value = ''
  editLabel.value = ''
}

async function saveToken() {
  if (!editToken.value.trim()) {
    acctHint.value = { bad: true, text: '先粘贴 token' }
    return
  }
  savingToken.value = true
  acctHint.value = null
  try {
    const d = await api('/api/admin/accounts', {
      method: 'PUT',
      body: { index: editIndex.value, token: editToken.value.trim(), label: editLabel.value.trim() },
    })
    accounts.value = d.accounts || []
    acctHint.value = { text: '已更新，下次同步就用新 token' }
    cancelEdit()
    showToast('已保存')
  } catch (e) {
    acctHint.value = { bad: true, text: e?.message || '保存失败' }
  } finally {
    savingToken.value = false
  }
}

// ---------- 短信登录 ----------
const smsPhone = ref('')
const smsCode = ref('')
const sendingSms = ref(false)
const loggingIn = ref(false)
const smsCountdown = ref(0)
const smsHint = ref(null)
let smsTimer = null

function startSmsCountdown(sec) {
  smsCountdown.value = sec
  if (smsTimer) clearInterval(smsTimer)
  smsTimer = setInterval(() => {
    smsCountdown.value -= 1
    if (smsCountdown.value <= 0) {
      clearInterval(smsTimer)
      smsTimer = null
    }
  }, 1000)
}

async function sendSms() {
  if (!/^1\d{10}$/.test(smsPhone.value)) {
    smsHint.value = { bad: true, text: '手机号要 11 位' }
    return
  }
  sendingSms.value = true
  smsHint.value = null
  try {
    const d = await api('/api/admin/accounts/send-code', { method: 'POST', body: { phone: smsPhone.value } })
    smsHint.value = { text: '已发送，查收短信' }
    startSmsCountdown(Number(d.waitSec) || 60)
  } catch (e) {
    smsHint.value = { bad: true, text: e?.message || '发送失败' }
  } finally {
    sendingSms.value = false
  }
}

async function smsLogin() {
  if (!smsCode.value.trim()) {
    smsHint.value = { bad: true, text: '先填验证码' }
    return
  }
  loggingIn.value = true
  smsHint.value = null
  try {
    const d = await api('/api/admin/accounts/login', {
      method: 'POST',
      body: { phone: smsPhone.value, code: smsCode.value.trim(), index: editIndex.value || 1 },
    })
    accounts.value = d.accounts || []
    smsHint.value = { text: '登录成功，token 已写入账号池' }
    smsCode.value = ''
    showToast('已登录')
  } catch (e) {
    smsHint.value = { bad: true, text: e?.message || '登录失败' }
  } finally {
    loggingIn.value = false
  }
}

// ---------- 批量导入 ----------
const importText = ref('')
const importing = ref(false)
const importHint = ref(null)

async function importAccounts() {
  if (!importText.value.trim()) {
    importHint.value = { bad: true, text: '先粘贴 token' }
    return
  }
  importing.value = true
  importHint.value = null
  try {
    const d = await api('/api/admin/accounts/import', { method: 'POST', body: { text: importText.value } })
    accounts.value = d.accounts || []
    const skip = (d.skipped || []).length ? `，跳过过期 ${d.skipped.join('、')}` : ''
    importHint.value = { text: `已导入 ${d.imported} 个${skip}` }
    importText.value = ''
    showToast('导入成功')
  } catch (e) {
    importHint.value = { bad: true, text: e?.message || '导入失败' }
  } finally {
    importing.value = false
  }
}

async function useAccount() {
  if (loading.value || unlocking.value) return
  if (!userStore.isLoggedIn) { gateError.value = '请先使用钉钉登录'; return }
  accessRevision++
  clearAdminSession()
  adminToken.value = ''
  sessionExpAt.value = 0
  accountMode.value = true
  gateError.value = ''
  await load()
  if (authed.value) await loadNotifyState()
  else { accountMode.value = false; gateError.value ||= '当前账号没有管理权限或登录已过期' }
}

async function unlock() {
  const t = tokenInput.value.trim()
  if (!t) {
    gateError.value = '先输口令'
    return
  }
  unlocking.value = true
  gateError.value = ''
  try {
    // 口令只用来换票据，页面不再保存口令本身
    const d = await api('/api/admin/login', { auth: false, method: 'POST', body: { token: t } })
    accessRevision++
    accountMode.value = false
    setAdminSession(d.session, d.expAt)
    adminToken.value = d.session
    sessionExpAt.value = d.expAt
    nowTick.value = Date.now()
    tokenInput.value = ''
    // 四个请求都只依赖票据，全部并发：以前是「状态 → load()」串行，
    // 首屏要多等一个来回。
    await Promise.all([
      load(),
      loadNotifyState(),
      loadAccounts(),
    ])
  } catch (e) {
    adminToken.value = ''
    const msg = (e && e.message) || '验证失败'
    // 服务端口令校验失败返回 401（不是 403），两种都判一下
    gateError.value = /40[13]/.test(msg) ? '口令不对' : msg
  } finally {
    unlocking.value = false
  }
}

function lock() {
  accessRevision++
  accountMode.value = false
  authed.value = false
  status.value = null
  adminToken.value = ''
  sessionExpAt.value = 0
  bindCode.value = ''
  mappingLoaded.value = false
  draft.value = {}
  savedMapping.value = {}
  clearAdminSession()
  showToast('已退出')
}

async function refresh() {
  await load()
}

async function triggerSync() {
  if (!adminToken.value && !accountMode.value) return
  syncing.value = true
  try {
    const r = await api('/api/cron/sync', {
      auth: 'optional',
      headers: { 'X-Admin-Token': adminToken.value },
    })
    if (r && r.error) {
      showToast('同步失败：' + r.error)
    } else {
      showToast('同步完成 · ' + ((r && r.fetched) || 0) + ' 台')
    }
    await load()
  } catch (e) {
    showToast((e && e.message) || '同步失败')
  } finally {
    syncing.value = false
  }
}

async function genCode() {
  codeLoading.value = true
  try {
    await userStore.ensureAuth()
    const data = await api('/api/bindcode', { method: 'POST' })
    bindCode.value = data.code
    startCountdown(data.expiresAt)
  } catch (e) {
    showToast((e && e.message) || '生成失败')
  } finally {
    codeLoading.value = false
  }
}

function startCountdown(expiresAt) {
  if (codeTimer) clearInterval(codeTimer)
  const tick = () => {
    const left = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000))
    codeLeft.value = left
    if (left <= 0) {
      clearInterval(codeTimer)
      codeTimer = null
      bindCode.value = ''
    }
  }
  tick()
  codeTimer = setInterval(tick, 1000)
}

function go(path) { router.push({ path, query: selectedDorm.value && ['/admin/users', '/admin/machines'].includes(path) ? { dorm: selectedDorm.value } : {} }) }
function goBack() {
  router.back()
}

// ---------- 发消息测试 ----------
const notifyTesting = ref('')
const notifyResult = ref(null)
const notifyState = ref({ dm: { ready: false }, group: { ready: false, via: '' } })

async function loadNotifyState() {
  try {
    const d = await api('/api/admin/notify-check')
    notifyState.value = d?.channels || { dm: { ready: false }, group: { ready: false, via: '' } }
  } catch {
    /* 读不到就按未就绪显示 */
  }
}

// 发一条**真实取衣通知卡片**（markdown），不是干巴巴的「测试消息」
async function sendTestMsg(target) {
  if (notifyTesting.value) return
  if (target === 'group') {
    try { await showConfirmDialog({ title: '发送群测试消息？', message: '此操作会立即向已配置的真实群发送一条测试消息。' }) } catch { return }
  }
  notifyTesting.value = target
  notifyResult.value = null
  try {
    const q = target === 'group' ? 'to=group' : 'to=self'
    const d = await api(`/api/admin/notify-test?${q}&sample=take`, { method: 'POST' })
    const part = target === 'group' ? d?.group : d?.dm
    notifyResult.value = {
      ok: Boolean(part?.ok),
      text: part?.ok ? '已发出，去钉钉看看收到了没' : `发送失败：${part?.err || '未知原因'}`,
    }
    showToast(part?.ok ? '已发送' : '发送失败')
  } catch (e) {
    notifyResult.value = { ok: false, text: e?.message || '发送失败' }
    showToast(e?.message || '发送失败')
  } finally {
    notifyTesting.value = ''
  }
}

onMounted(async () => {
  // 每分钟刷一次「剩余有效期」，到点自动收起后台
  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
    if (authed.value && sessionExpAt.value && Date.now() >= sessionExpAt.value) {
      lock()
    }
  }, 60000)

  // 有未过期的会话票据就直接进（票据本身 12 小时到期，过期当作没登录）
  const s = getAdminSession()
  if (!s) return
  adminToken.value = s.session
  sessionExpAt.value = s.expAt
  try {
    await Promise.all([load(), loadNotifyState(), loadAccounts()])
  } catch (e) {
    // 票据失效（换了 AUTH_SECRET / 过期）：清掉，回到口令页
    clearAdminSession()
    adminToken.value = ''
  }
})

onUnmounted(() => {
  if (codeTimer) clearInterval(codeTimer)
  if (tickTimer) clearInterval(tickTimer)
})

onBeforeRouteLeave(async () => {
  if (!mapDirty.value) return true
  try { await showConfirmDialog({ title: '绑定尚未保存', message: '离开会丢失机位绑定草稿，确定离开？' }); return true }
  catch { return false }
})
</script>

<style scoped>
.dorm-tabs { display:flex;flex-wrap:wrap;gap:8px;padding:0 12px 12px; }.dorm-tabs button { min-height:36px;border:1px solid var(--border);border-radius:8px;padding:4px 12px;background:var(--bg);color:var(--text);cursor:pointer; }.dorm-tabs button.active { color:#93c5fd;border-color:#3b82f6;background:rgba(59,130,246,.12); }.map-note,.map-warning { font-size:12px;padding:0 12px;overflow-wrap:anywhere; }.map-note{color:#93c5fd}.map-warning{color:#fbbf24}.picker-filters{padding:16px;background:var(--bg-card)}.picker-filters h3{margin:0 0 12px;font-size:16px}.picker-filters input,.picker-filters select{min-height:40px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);padding:8px;width:100%;margin-bottom:8px;color-scheme:dark}.picker-filters p{font-size:12px;margin:0}.hero-err{overflow-wrap:anywhere}@media(max-width:400px){.nav-right{gap:6px}.conn{display:none}.slot-name{min-width:75px}.actions{flex-wrap:wrap}}
.admin { padding-bottom: 24px; }

/* ── 自适应：手机全宽，PC 居中限宽并按两列排卡片 ── */
@media (min-width: 720px) {
  .admin {
    max-width: 1040px;
    margin: 0 auto;
    padding: 0 20px 32px;
  }
  .admin .gate { padding: 60px 0; }
  .admin .gate-card { max-width: 420px; margin: 0 auto; }
  /* 宽屏下表格类区域左右留白更舒服 */
  .admin .acct-list,
  .admin .notify-channels { padding-left: 16px; padding-right: 16px; }
}

/* 顶部右侧：连接态 + 剩余有效期 + 退出 */
.nav-right { display: flex; align-items: center; gap: 10px; }
.session-left { font-size: 11px; color: var(--text-dim); }
.session-left.low { color: #f59e0b; }
.logout-mini {
  font-size: 12px; color: #93c5fd; padding: 2px 8px; border-radius: 999px;
  border: 1px solid rgba(147, 197, 253, 0.35); cursor: pointer;
}
.logout-mini:active { background: rgba(147, 197, 253, 0.16); }

/* 顶部连接态 */
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--st-unknown); }
.dot.ok { background: var(--st-idle); box-shadow: 0 0 6px rgba(34, 197, 94, 0.7); }
.dot.bad { background: var(--st-faulty); box-shadow: 0 0 6px rgba(239, 68, 68, 0.7); }

/* 口令闸门 */
.gate {
  min-height: calc(100vh - 46px);
  display: flex; flex-direction: column; justify-content: center;
  padding: 0 20px 60px;
}
.gate-card { padding: 28px 20px 20px; text-align: center; }
.gate-icon {
  width: 56px; height: 56px; margin: 0 auto 14px; border-radius: 16px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(59, 130, 246, 0.12); color: var(--primary); font-size: 28px;
}
.gate-card h2 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.gate-desc { margin: 0 0 18px; font-size: 12px; line-height: 1.6; }
.gate-desc code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  background: rgba(148, 163, 184, 0.14); padding: 1px 5px; border-radius: 4px;
}
.gate-input {
  width: 100%; height: 44px; margin-bottom: 12px; padding: 0 14px;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-elev); color: var(--text);
  font-size: 15px; letter-spacing: 2px; outline: none;
}
.gate-input::placeholder { letter-spacing: 0; color: var(--text-dim); }
.gate-input:focus { border-color: var(--primary); }
.gate-err { margin: 12px 0 0; font-size: 12px; color: var(--st-faulty); }

.loading { padding: 60px 20px; text-align: center; font-size: 13px; }

/* 概览 */
.hero { margin: 12px; padding: 16px; }
.hero-top { display: flex; align-items: center; gap: 10px; }
.hero-building { font-size: 15px; font-weight: 600; }
.badge {
  font-size: 11px; padding: 3px 8px; border-radius: 999px;
  border: 1px solid transparent; white-space: nowrap;
}
.badge.live { color: #86efac; background: rgba(34, 197, 94, 0.14); border-color: rgba(34, 197, 94, 0.35); }
.badge.mock { color: #fcd34d; background: rgba(245, 158, 11, 0.14); border-color: rgba(245, 158, 11, 0.35); }
.badge.sm { font-size: 10px; padding: 2px 7px; }
.hero-sub { margin-top: 8px; font-size: 11px; word-break: break-all; }
.hero-sync { margin-top: 12px; display: flex; align-items: center; gap: 8px; font-size: 12px; }
.hero-err {
  margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 11px; line-height: 1.5;
  color: #fca5a5; background: rgba(239, 68, 68, 0.1); word-break: break-all;
}

/* 统计 */
.stats { display: flex; gap: 8px; margin: 0 12px; }
.stat {
  flex: 1; padding: 12px 8px; text-align: center;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
}
.stat b { display: block; font-size: 22px; line-height: 1.2; font-weight: 600; }
.stat span { font-size: 11px; color: var(--text-dim); }
.stat.idle b { color: var(--st-idle); }
.stat.occ b { color: var(--st-occupied); }
.stat.fal b { color: var(--st-faulty); }

/* 区块 */
.block { margin: 12px; padding: 14px 16px 16px; }
.block header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.block h3 { margin: 0; font-size: 14px; font-weight: 600; }
.block header .text-dim { font-size: 10px; }

/* 楼层条 */
.floor-row { margin-bottom: 12px; }
.floor-row:last-child { margin-bottom: 0; }
.floor-label { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; }
.floor-label em { font-style: normal; color: var(--text-dim); }
.floor-legend { display: flex; gap: 12px; font-size: 11px; margin-top: 4px; }
.bar {
  display: flex; height: 8px; border-radius: 999px; overflow: hidden;
  background: rgba(148, 163, 184, 0.14);
}
.seg { display: block; height: 100%; }
.seg.idle { background: var(--st-idle); }
.seg.occ { background: var(--st-occupied); }
.seg.fal { background: var(--st-faulty); }
.empty-line { font-size: 12px; padding: 4px 0; }

/* 操作 */
.actions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.btn-ghost {
  background: transparent !important;
  border: 1px solid var(--border) !important;
  color: var(--text) !important;
}
.kv {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 7px 0; font-size: 12px; border-top: 1px solid rgba(35, 49, 73, 0.7);
}
.kv span { color: var(--text-dim); }
.kv b { font-weight: 500; }

/* 机位绑定 */
.slot-hint { font-size: 11px; margin: -4px 0 8px; }
.slot-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 0; border-top: 1px solid rgba(35, 49, 73, 0.7);
  cursor: pointer;
}
.slot-name { width: 76px; flex: none; font-size: 12px; color: var(--text-dim); }
.slot-dev { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot-dev.none { color: var(--text-dim); opacity: 0.6; }
.slot-arrow { color: var(--text-dim); font-size: 12px; }
.slot-actions { margin: 14px 0 0; }

/* 钉钉 */
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.chip {
  font-size: 11px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--text-dim); background: var(--bg-elev);
}
.chip.on { color: #86efac; border-color: rgba(34, 197, 94, 0.4); background: rgba(34, 197, 94, 0.1); }
.bind-box { margin-top: 12px; text-align: center; }
.bind-code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 26px; letter-spacing: 6px; color: var(--primary); font-weight: 600;
}
.bind-tip { font-size: 11px; margin-top: 4px; }
.bind-note { font-size: 12px; line-height: 1.6; margin-bottom: 10px; }

.exit { margin: 20px 12px 0; }
.sec-notify { display: flex; gap: 8px; padding: 0 12px 8px; flex-wrap: wrap; }
.notify-result { padding: 0 12px 8px; font-size: 12px; color: #b7f0c4; }
.notify-result.bad { color: #ffb0b0; }
.notify-channels { padding: 0 12px 10px; font-size: 11px; }
.sync-url {
  margin: 0 12px 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  font: 11px/1.5 ui-monospace, monospace;
  color: #9fd7ff;
  word-break: break-all;
}
.acct-list { padding: 4px 12px 8px; display: flex; flex-direction: column; gap: 8px; }
.acct-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; gap: 8px; }

/* Vant 按钮默认是浅色主题：plain=白底、disabled=灰底，在深色卡片里会变成
   「一块白/灰方块、字看不见」。这里统一覆盖成深色玻璃感。 */
.admin :deep(.van-button--default),
.admin :deep(.van-button--plain) {
  background: rgba(148, 163, 184, 0.14);
  border-color: rgba(148, 163, 184, 0.32);
  color: #dbe6f5;
}
.admin :deep(.van-button--default:active),
.admin :deep(.van-button--plain:active) {
  background: rgba(148, 163, 184, 0.24);
}
.admin :deep(.van-button--disabled),
.admin :deep(.van-button--default.van-button--disabled),
.admin :deep(.van-button--primary.van-button--disabled) {
  opacity: 1;
  background: rgba(148, 163, 184, 0.08);
  border-color: rgba(148, 163, 184, 0.16);
  color: #7b8a9d;
}

/* 表单行：窄屏正常，宽屏不要把标签和输入框拉成天涯两隔 */
.acct-edit :deep(.van-field) {
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
}
.acct-edit :deep(.van-field__label) {
  width: 56px;
  margin-right: 8px;
  color: #94a3b8;
  font-size: 12px;
}
.acct-edit :deep(.van-field__control) {
  color: #eaf2fb;
  font-size: 13px;
}
.acct-edit :deep(.van-field__control::placeholder) {
  color: #64748b;
}
.acct-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.acct-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #64748b; }
.acct-dot.ok { background: #22c55e; box-shadow: 0 0 6px rgba(34, 197, 94, 0.6); }
.acct-dot.bad { background: #ef4444; box-shadow: 0 0 6px rgba(239, 68, 68, 0.6); }
.acct-dot.unk { background: #475569; }
.acct-bad { font-size: 11px; color: #f87171; }
.acct-main { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
.acct-idx { color: #64748b; font: 11px ui-monospace, monospace; }
.acct-label { color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acct-exp { font-size: 11px; color: #94a3b8; }
.acct-exp.warn { color: #f59e0b; }
.acct-cool { font-size: 11px; color: #f87171; }
.acct-edit { padding: 4px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
.acct-actions { display: flex; gap: 8px; }
.acct-edit code { font: 11px ui-monospace, monospace; color: #9fd7ff; }
.nav-list { display: flex; flex-direction: column; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
}
.nav-item:last-child { border-bottom: none; }
.nav-name { flex: 1; font-size: 14px; color: #eaf2fb; }
.nav-meta { font-size: 12px; }
.exit-btn {
  width: 100%; padding: 12px; border-radius: 10px; cursor: pointer;
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); font-size: 14px;
}
.exit-btn:active { background: rgba(148, 163, 184, 0.08); }
.foot { padding: 12px 20px 0; font-size: 11px; line-height: 1.6; text-align: center; }
</style>
