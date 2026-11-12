<template>
  <div class="page task">
    <van-nav-bar title="我的洗衣">
      <template #right><button class="dorm-switch" @click="dorm.showPicker = true">{{ dorm.name || '选择住宿楼' }} ▾</button></template>
    </van-nav-bar>

    <div class="task-links"><van-button class="friend-link" size="small" plain to="/social">朋友与代取</van-button><van-button class="assistant-link" size="small" plain to="/assistant">洗衣助手</van-button></div>
    <!-- 登记表单 -->
    <div class="form card">
      <div class="field-label">选择机器</div>
      <van-cell :title="selectedName || (machines.length ? '选台机器' : '暂无可选机器')" is-link @click="openMachinePicker" />
      <div v-if="machineError" class="form-tip">机器数据加载失败，<button @click="loadMachines(true)">重试</button></div>
      <p v-if="selectedMachine?.availabilityLabel" class="form-tip">{{ selectedMachine.availabilityLabel }}</p>
      <p v-else-if="['occupied','abnormal'].includes(selectedMachine?.state)" class="form-tip">运行中，程序未提供；登记提醒不会改变机器远端状态。</p>

      <!-- 默认跟着机器剩余时间；机器空闲时才需要自己选时长 -->
      <template v-if="mode === 'machine'">
        <div class="field-label">提醒时间</div>
        <div class="mode-row">
          <span class="mode on">{{ machineLeft == null ? '结束时间待确认' : machineLeft > 0 ? `按机器剩余 ${machineLeft} 分钟提醒` : '即将完成' }}</span>
          <span class="mode" @click="mode = 'duration'">自己选</span>
        </div>
      </template>
      <template v-else>
        <div class="field-label">预计时长（分钟）</div>
        <div v-if="isDryer" class="dry-duration">
          <van-stepper v-model="minutes" min="10" max="180" integer input-width="64px" />
          <span class="form-tip">10–180 分钟，默认 60 分钟</span>
        </div>
        <div v-else class="quick">
          <van-button
            v-for="q in DURATIONS"
            :key="q.minutes"
            size="small"
            :type="minutes === q.minutes && programLabel === q.label ? 'primary' : 'default'"
            :disabled="submitting"
            @click="selectProgram(q)"
          >{{ q.label }}</van-button>
        </div>
        <label v-if="!isDryer" class="custom-duration">自定义分钟 <input v-model.number="minutes" type="number" min="1" max="180" step="1" inputmode="numeric" :disabled="submitting" @input="clearProgram" />（1–180 整数）</label>
        <div v-if="machineLeft" class="mode-row">
          <span class="mode" @click="mode = 'machine'">改成按机器剩余 {{ machineLeft }} 分钟</span>
        </div>
      </template>
      <p v-if="selectedMachine?.estimated" class="form-tip">剩余时间为系统估算，请自己确认程序；估算到点不表示机器已结束。</p>

      <TaskDetailsForm v-model:note="note" v-model:use-disinfectant="useDisinfectant" v-model:self-cleaned="selfCleaned" :show-disinfectant="!isDryer" :disabled="submitting" />
      <van-button type="primary" block :loading="submitting" :disabled="!selectedMachine" @click="submit">{{ isDryer ? '登记烘干' : '登记洗衣' }}</van-button>
    </div>

    <!-- 任务列表 -->
    <div class="tasks">
      <div v-if="loading && !tasks.length" class="empty text-dim">加载中…</div>
      <div v-else-if="!activeTasks.length" class="empty text-dim">暂无近期洗衣登记</div>
      <div v-for="t in activeTasks" :key="t.id" class="task-item card" :class="{ done: t.done }">
        <div class="ti-main">
          <div class="ti-name">{{ t.machineName || t.machineId }}</div>
          <div class="ti-time" :class="stateClass(t)">{{ stateTextOf(t) }}</div>
          <p v-if="t.mode || t.program" class="task-details">{{ reminderSource(t) }}</p>
          <p v-if="t.note" class="task-note">备注：{{ t.note }}</p>
          <div v-if="t.kind !== 'dryer'" class="task-details">消毒液：{{ t.useDisinfectant ? '使用' : '未使用' }} · 自清洁：{{ t.selfCleaned ? '已记录' : '未记录' }}</div>
        </div>
        <div class="ti-ops">
          <van-button
            v-if="canTake(t)"
            size="small"
            type="primary"
            :loading="takingId === t.id"
            @click="take(t)"
          >我已取衣</van-button>
          <van-button v-if="!t.done" class="pickup-button" size="small" plain @click="router.push({path:'/social',query:{task:t.id}})">请TA代取</van-button>
          <van-button size="small" type="danger" plain @click="remove(t)">删除</van-button>
        </div>
      </div>
    </div>

    <section v-if="pickups.length" class="tasks"><h2>朋友请我代取</h2><div v-for="p in pickups" :key="p.id" class="task-item card"><div><strong>{{ p.task?.machineName || p.task?.machineId }}</strong><p>{{ p.task?.done ? '已确认取衣' : p.task?.leftMin == null ? '结束时间待确认' : p.task.leftMin > 0 ? `剩余 ${p.task.leftMin} 分钟` : '即将完成，请等机器结束后取衣' }}</p></div><van-button size="small" to="/social">处理</van-button></div></section>
    <section class="tasks history-tasks" aria-labelledby="history-title">
      <h2 id="history-title">历史洗衣记录</h2>
      <p class="form-tip">登记满 72 小时自动归档，满 336 小时自动清除。</p>
      <p v-if="!taskHistory.length" class="form-tip">暂无历史记录</p>
      <article v-for="t in taskHistory" :key="t.id" class="task-item card history-item">
        <div class="ti-main"><strong>{{ t.machineName || t.machineId }}</strong><p class="task-details">{{ formatTime(t.createdAt || t.startAt) }} · {{ t.done ? '已取衣' : '已归档 · 取衣情况未确认' }}</p><p v-if="t.note" class="task-note">备注：{{ t.note }}</p><p v-if="t.kind !== 'dryer'" class="task-details">消毒液：{{ t.useDisinfectant ? '使用' : '未使用' }} · 自清洁：{{ t.selfCleaned ? '已记录' : '未记录' }}</p></div>
        <van-button size="small" type="danger" plain @click="remove(t)">删除</van-button>
      </article>
    </section>
    <!-- 机器选择弹窗 -->
    <van-popup v-model:show="showPicker" position="bottom" round>
      <van-picker
        :columns="machineColumns"
        @confirm="onPick"
        @cancel="showPicker = false"
        show-toolbar
        title="选择机器"
      />
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api, NEED_LOGIN } from '../api'
import { useUserStore } from '../stores/user'
import { useDormStore } from '../stores/dorm'
import { loadBoard, filterDormFloors } from '../boardQuery'
import TaskDetailsForm from '../components/TaskDetailsForm.vue'
import { WASHER_PROGRAMS, machineRemainingMinutes, registrationSnapshot, registrationDescription, registrationBody, createUserActionConfirmation } from '../taskRegistration'
import '../userActionConfirm.css'
import { splitTaskHistory } from '../../../packages/core/task-retention.js'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const dorm = useDormStore()

const tasks = ref([])
const pickups = ref([])
const board = ref(null)
const machines = computed(() => filterDormFloors(board.value, dorm.code, dorm.buildings).flatMap((f) => (f.machines || []).map((m) => ({ ...m, floorCode: m.floorCode || f.code }))))
const machineError = ref('')
const selected = ref('')
const minutes = ref(42)
const program = ref('')
const programLabel = ref('加强洗 42分钟')
const note = ref('')
const useDisinfectant = ref(false)
const selfCleaned = ref(false)
const mode = ref('machine')
const showPicker = ref(false)
const submitting = ref(false)
const loading = ref(false)
const takingId = ref('')
let timer = null
let clockTimer = null
const now = ref(Date.now())
let clockOffset = 0
const partition = computed(() => splitTaskHistory(tasks.value, now.value))
const activeTasks = computed(() => partition.value.activeTasks)
const taskHistory = computed(() => partition.value.history)
function formatTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '登记时间未知' }
let tasksPending = null
let machinesPending = null
let disposed = false

// 洗衣机时长白名单（与后端一致）
const DURATIONS = WASHER_PROGRAMS
const confirmAction = createUserActionConfirmation(showConfirmDialog)
function selectProgram(value) { minutes.value = value.minutes; program.value = value.minutes === 6 ? 'self_clean' : ''; programLabel.value = value.label }
function clearProgram() { program.value = ''; programLabel.value = '' }

const selectedMachine = computed(() => machines.value.find((m) => String(m.id) === String(selected.value)) || null)
const selectedName = computed(() => selectedMachine.value?.displayName || selectedMachine.value?.name || '')
const isDryer = computed(() => selectedMachine.value?.kind === 'dryer')
const machineLeft = computed(() => {
  return machineRemainingMinutes(selectedMachine.value, now.value)
})

// 选了机器就重置成「跟着机器」（有剩余时间才跟得上）
function syncMode() {
  mode.value = machineLeft.value > 0 ? 'machine' : 'duration'
  minutes.value = isDryer.value ? 60 : 42
  program.value = ''
  programLabel.value = isDryer.value ? '' : '加强洗 42分钟'
}
watch(selected, syncMode)
watch(machines, (list) => {
  if (!list.some((m) => String(m.id) === String(selected.value))) selected.value = ''
})
watch(() => selectedMachine.value?.kind, (kind, old) => {
  if (kind !== old) minutes.value = kind === 'dryer' ? 60 : 42
})

function openMachinePicker() {
  if (!dorm.code) { dorm.showPicker = true; return }
  if (!machines.value.length) { showToast(machineError.value || '这栋楼暂无机器数据'); return }
  showPicker.value = true
}

const machineColumns = computed(() =>
  machines.value.map((m) => ({
    text: `${m.displayName || m.name || m.id}（${stateText(m.state)}）`,
    value: String(m.id),
  }))
)

function stateText(s) {
  return ({ idle: '空闲', occupied: '占用', faulty: '故障', unknown: '未知' })[s] || '未知'
}

// 服务端给的 leftMin 是「还剩几分钟」，overdueMin 是「已经过了几分钟」。
// 旧版只用 leftMin 并把负数夹成 0，所以三天前的任务也显示「即将完成」。
function stateTextOf(t) {
  if (t.takeState === 'taken' || t.done) return '已取'
  const end = t.endAt ? new Date(t.endAt).getTime() : NaN
  if (t.completionConfirmed === true) return '平台已确认完成 · 等待取衣'
  if (t.takeState === 'pending' || (t.timingSource !== 'upstream' && Number.isFinite(end) && end <= now.value)) {
    const over = Number.isFinite(end) ? Math.max(0, Math.floor((now.value - end) / 60000)) : Number(t.overdueMin) || 0
    return over > 0 ? `登记计时结束${agoText(over)} · 请确认机器和衣物` : '登记计时已到 · 请现场确认'
  }
  if (Number.isFinite(end)) { const left = Math.max(0, Math.ceil((end - now.value) / 60000)); return left > 0 ? `${t.timingSource === 'upstream' ? '平台' : '预计'}剩余 ${left} 分` : '即将完成' }
  const left = Number(t.leftMin)
  if (Number.isFinite(left) && left > 0) return `登记计时剩余 ${left} 分`
  return '结束时间待确认'
}

function reminderSource(task) {
  if (task.timingSource === 'upstream') return '按最新平台时间同步' + (task.timeOffsetMinutes ? ` · 校准 ${task.timeOffsetMinutes > 0 ? '+' : ''}${task.timeOffsetMinutes} 分钟` : '')
  if (task.mode === 'machine') return task.estimated ? '按估算时间提醒；请核对现场状态' : '按机器时间提醒 · 程序未提供'
  if (task.program === 'self_clean') return '自行选择桶自洁 · 6分钟提醒'
  return `自行设置${task.minutes ? ' ' + task.minutes + ' 分钟' : ''}提醒；不代表机器远端状态`
}

function canTake(t) {
  if (t.archived || t.done || t.takeState === 'taken') return false
  const end = t.endAt ? new Date(t.endAt).getTime() : NaN
  return t.completionConfirmed === true || t.takeState === 'pending' || (t.timingSource !== 'upstream' && Number.isFinite(end) && end <= now.value)
}

function stateClass(t) {
  if (t.done || t.takeState === 'taken') return 'state-idle'
  return canTake(t) ? 'state-done' : 'state-occupied'
}

function agoText(min) {
  const m = Math.max(1, Math.round(min))
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function onPick({ selectedValues }) {
  selected.value = selectedValues[0]
  showPicker.value = false
}

// 登记洗衣（契约 POST /api/tasks）
async function submit() {
  if (submitting.value) return
  if (!selectedMachine.value) {
    showToast('先选台机器')
    return
  }
  if (mode.value !== 'machine') {
    const n = Number(minutes.value)
    if (!Number.isInteger(n) || n < (isDryer.value ? 10 : 1) || n > 180) {
      showToast(isDryer.value ? '烘干时长请填 10–180 的整数' : '洗衣时长请填1–180的整数')
      return
    }
  }
  if (mode.value === 'machine' && !machineLeft.value) {
    showToast('这台机器没有剩余时间，请自己选时长')
    mode.value = 'duration'
    return
  }
  submitting.value = true
  try {
    await userStore.ensureAuth()
    const result = await confirmAction({
      read: () => ({ ...registrationSnapshot(selectedMachine.value, { mode: mode.value, minutes: minutes.value, program: program.value, programLabel: programLabel.value, note: note.value, useDisinfectant: useDisinfectant.value, selfCleaned: selfCleaned.value }), userId: userStore.user?.id || '', dorm: dorm.code, disposed }),
      describe: registrationDescription,
      execute: (snapshot) => api('/api/tasks', { method: 'POST', body: registrationBody(snapshot) }),
      onChanged: () => showToast('机器或填写内容已变化，请检查后重新确认'),
    })
    if (result.status !== 'submitted') return
    showToast({ message: '已登记，提醒计时已保存', className: 'user-action-feedback' })
    note.value = ''
    useDisinfectant.value = false
    selfCleaned.value = false
    await loadTasks()
  } catch (e) {
    if (e?.message === NEED_LOGIN) router.push({ path: '/login', query: { to: '/task' } })
    else showToast(e?.message || '登记失败')
  } finally {
    submitting.value = false
  }
}

// 我已取衣：标记完成（不是删除，留一条记录）
async function take(t) {
  if (takingId.value) return
  takingId.value = t.id
  try {
    const result = await confirmAction({
      read: () => ({ id: t.id, name: t.machineName, done: t.done, userId: userStore.user?.id || '', disposed }),
      describe: (snapshot) => ({ title: '确认已取衣', message: `${snapshot.name || '这台机器'}\n确认已取走自己的衣物后，将结束这条登记并释放登记占用。` }),
      execute: (snapshot) => api(`/api/tasks/${snapshot.id}/take`, { method: 'POST' }),
      onChanged: () => showToast('登记状态已变化，请刷新后重新确认'),
    })
    if (result.status !== 'submitted') return
    t.done = true
    t.takenAt = new Date().toISOString()
    const source = tasks.value.find(item => item.id === t.id)
    if (source) Object.assign(source, { done: true, takenAt: t.takenAt, takeState: 'taken' })
    showToast('已标记完成')
  } catch (e) {
    showToast(e?.message || '操作失败')
  } finally {
    takingId.value = ''
  }
}

// 删除任务（契约 DELETE /api/tasks/:id）
async function remove(t) {
  try {
    await userStore.ensureAuth()
    const result = await confirmAction({
      read: () => ({ id: t.id, name: t.machineName, userId: userStore.user?.id || '', disposed }),
      describe: (snapshot) => ({ title: '删除登记', message: `${snapshot.name || '这台机器'}\n删除这条登记记录，并释放它对应的登记占用？机器远端状态不会随登记删除而变化。` }),
      execute: (snapshot) => api('/api/tasks/' + snapshot.id, { method: 'DELETE' }),
      onChanged: () => showToast('登记状态已变化，请重新确认'),
    })
    if (result.status !== 'submitted') return
    tasks.value = tasks.value.filter((x) => x.id !== t.id)
    showToast('已删除')
  } catch (e) {
    showToast(e?.message || '删除失败')
  }
}

// 拉取机器列表（用于选择）—— 公开数据，不带 auth 以便走缓存
async function loadMachines(force = false) {
  const code = dorm.code
  if (!code) return
  if (machinesPending?.code === code) return machinesPending.job
  const job = (async () => {
  try {
    const data = await loadBoard({ force, dorm: code })
    if (disposed || dorm.code !== code) return
    board.value = data.board
    const server = Date.parse(data.freshness?.serverNow || '')
    if (Number.isFinite(server)) clockOffset = server - Date.now()
    now.value = Date.now() + clockOffset
    machineError.value = ''
  } catch (e) {
    machineError.value = e?.message || '请稍后再试'
  }
  })()
  machinesPending = { code, job }
  try { return await job } finally { if (machinesPending?.job === job) machinesPending = null }
}

// 拉取我的任务（契约 GET /api/tasks）
async function loadTasks() {
  if (tasksPending) return tasksPending
  tasksPending = (async () => {
  loading.value = true
  try {
    await userStore.ensureAuth()
    const data = await api('/api/tasks')
    if (disposed) return
    tasks.value = data.tasks || []
    const server = Date.parse(data.serverNow || '')
    if (Number.isFinite(server)) clockOffset = server - Date.now()
    now.value = Date.now() + clockOffset
  } catch (e) {
    if (disposed) return
    if (e?.message === NEED_LOGIN) router.replace({ path: '/login', query: { to: '/task' } })
    else showToast(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
  })()
  try { return await tasksPending } finally { tasksPending = null }
}

watch(() => dorm.code, () => { board.value = null; selected.value = ''; machineError.value = ''; loadMachines() })

async function loadPickups() { try { const d = await api('/api/social/pickups'); if (!disposed) pickups.value = (d.received || d.pickups || []).filter((p)=>['pending','accepted'].includes(p.state)) } catch {} }
function refresh() { return Promise.all([loadMachines(), loadTasks(), loadPickups()]) }
function startPoll() { stopPoll(); if (document.visibilityState === 'visible') timer = setInterval(refresh, 30000) }
function stopPoll() { if (timer) clearInterval(timer); timer = null }
function onVis() { if (document.visibilityState === 'visible') { now.value = Date.now() + clockOffset; refresh(); startPoll() } else stopPoll() }

onMounted(async () => {
  await refresh()
  if (disposed) return
  if (route.query.machine && machines.value.some((m) => String(m.id) === String(route.query.machine))) {
    selected.value = String(route.query.machine)
    syncMode()
  }
  startPoll()
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('online', onVis)
  window.addEventListener('pageshow', onVis)
  clockTimer = setInterval(() => { now.value = Date.now() + clockOffset }, 1000)
})
onUnmounted(() => {
  disposed = true
  stopPoll()
  document.removeEventListener('visibilitychange', onVis)
  window.removeEventListener('online', onVis)
  window.removeEventListener('pageshow', onVis)
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
.task-note{font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;color:var(--text)}.task-details{font-size:11px;color:var(--text-dim);margin-top:5px}
.task-links{display:flex;gap:10px;padding:12px 12px 0}.ti-ops{flex-wrap:wrap;max-width:185px}.tasks h2{font-size:18px}.history-tasks{margin-top:28px;padding-bottom:28px}.history-tasks h2,.history-tasks p{margin:0}.history-item{align-items:flex-start}
.task-links .friend-link,.ti-ops .pickup-button{color:#bbf7d0;background:#17352c;border-color:#3f7657}.task-links .assistant-link{color:#bae6fd;background:#123348;border-color:#3c718d}
.dorm-switch { border: 0; background: transparent; color: var(--primary); cursor: pointer; }
.form-tip { font-size: 12px; color: var(--text-dim); }
.form-tip button { border: 0; background: transparent; color: var(--primary); cursor: pointer; }
.dry-duration { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0; }
.custom-duration{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--text-dim);margin:12px 0}.custom-duration input{width:78px;padding:7px;border:1px solid var(--border);border-radius:7px;color:var(--text);background:var(--bg);font:inherit;color-scheme:dark}
.page { padding-bottom: 12px; }
.form { margin: 12px; padding: 12px; }
.field-label { font-size: 13px; color: var(--text-dim); margin: 12px 0 6px; }
.field-label:first-child { margin-top: 0; }
.quick { display: flex; gap: 8px; margin: 10px 0; }
.quick .van-button { flex: 1; }
.mode-row { display: flex; gap: 8px; margin: 10px 0; }
.mode {
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #b6c2d2;
  cursor: pointer;
}
.mode.on { border-color: #3b82f6; color: #93c5fd; background: rgba(59, 130, 246, 0.14); }
.tasks { padding: 0 12px; display: flex; flex-direction: column; gap: 10px; }
.task-item { padding: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.task-item.done { opacity: 0.62; }
.ti-main { min-width: 0; }
.ti-name { font-weight: 600; }
.ti-time { font-size: 13px; margin-top: 4px; }
.state-occupied { color: #93c5fd; }
.state-done { color: #f59e0b; }
.state-idle { color: #22c55e; }
.state-faulty { color: #ef4444; }
.ti-ops { display: flex; flex: none; gap: 6px; }
@media(max-width:480px){.task-item{align-items:stretch;flex-direction:column}.ti-ops{max-width:none;justify-content:flex-end}.history-item>.van-button{align-self:flex-end}.quick{flex-wrap:wrap}.quick .van-button{flex:1 0 40%;min-height:44px}}
</style>
