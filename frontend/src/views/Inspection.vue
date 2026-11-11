<template>
  <main class="page inspection">
    <van-nav-bar title="楼栋巡检" left-arrow @click-left="$router.back()" />
    <div class="inspection-content">
      <p class="dim">一次检查本楼全部机器，只勾选发现异常的机器；没有勾选表示本轮全部正常。异常记录会尝试通知本楼指定群，设备状态仍以数据源与复核结果为准。</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="loading && !data" class="dim">正在读取巡检权限…</p>
      <template v-if="data">
        <div class="identity">{{ data.identity.label }}<span>{{ data.buildings.map(b => b.name).join('、') }}</span></div>
        <form class="card inspection-form" @submit.prevent="submit">
          <label>巡检楼栋<select v-model="building" :disabled="saving"><option v-for="b in data.buildings" :key="b.code" :value="b.code">{{ b.name }}</option></select></label>
          <div class="round-summary"><strong>本轮检查 {{ machines.length }} 台</strong><span>{{ selectedIssues.length ? `${selectedIssues.length} 台异常` : '未勾选异常机器' }}</span></div>
          <p class="dim">逐台确认现场情况后，勾选需要上报的异常机器。</p>
          <p v-if="!machines.length" class="dim">本楼暂无可巡检机器。</p>
          <fieldset v-for="machine in machines" :key="machine.id" class="machine-check" :class="{ selected: selections[machine.id] }" :disabled="saving">
            <label class="machine-toggle"><input type="checkbox" :checked="Boolean(selections[machine.id])" @change="toggleMachine(machine.id, $event.target.checked)" /><span>{{ machine.name }}</span><small>{{ selections[machine.id] ? '异常' : '未标记异常' }}</small></label>
            <div v-if="selections[machine.id]" class="issue-details">
              <div class="reasons" role="group" :aria-label="machine.name + '的异常情况'">
                <label v-for="(label, reason) in reasons" :key="reason"><input v-model="selections[machine.id].reasons" type="checkbox" :value="reason" />{{ label }}</label>
              </div>
              <label>异常说明（选填）<textarea v-model="selections[machine.id].note" rows="2" maxlength="500" placeholder="补充现场情况和处理建议" /></label>
            </div>
          </fieldset>
          <label>本轮备注（选填）<textarea v-model="note" rows="2" maxlength="500" :disabled="saving" placeholder="可记录清洁情况、处理结果等" /></label>
          <label class="photo-picker">{{ processing ? '正在处理全景照片…' : photoData ? '更换洗衣房全景照片（选填）' : '添加洗衣房全景照片（选填）' }}<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" :disabled="processing || saving" @change="choosePhoto" /></label>
          <div v-if="photoData" class="photo-preview"><img :src="photoData" alt="本轮洗衣房全景照片预览" /><button type="button" :disabled="saving" @click="photoData = ''">移除照片</button></div>
          <p class="dim">照片不是必填项。拍摄时尽量覆盖洗衣房全景，避免拍到他人的面部和个人物品。</p>
          <p v-if="missingReasons" class="error">请为每台已勾选的机器选择至少一项具体异常。</p>
          <van-button type="primary" native-type="submit" block :loading="saving" :disabled="!machines.length || missingReasons || processing">{{ selectedIssues.length ? `提交全检 · ${selectedIssues.length} 台异常` : '提交全检 · 全部正常' }}</van-button>
        </form>
        <div class="history-title"><h2>本楼巡检记录</h2><button :disabled="saving || loading" @click="load">刷新</button></div>
        <p v-if="!history.length" class="dim">还没有巡检记录。</p>
        <article v-for="item in history" :key="item.id" class="card history">
          <div class="history-heading"><b>{{ item.type === 'round' ? '整轮巡检' : item.machineName }}</b><span :class="item.status === 'issue' ? 'issue' : 'normal'">{{ item.status === 'issue' ? `${item.issueCount || 1} 台异常` : '全部正常' }}</span></div>
          <p v-if="item.type === 'round'" class="dim">检查 {{ item.inspectedMachineCount }} 台 · 正常 {{ item.inspectedMachineCount - item.issueCount }} 台</p>
          <ul v-if="item.issues?.length" class="history-issues"><li v-for="issue in item.issues" :key="issue.machineId"><strong>{{ issue.machineName }}</strong><span>{{ issue.reasons.map(reason => reasons[reason] || '其他异常').join('、') }}</span><p v-if="issue.note">{{ issue.note }}</p></li></ul>
          <p v-if="item.note">{{ item.note }}</p>
          <small>{{ clock(item.at) }} · {{ item.inspector?.nick || '管理人员' }}</small>
          <p class="delivery">{{ delivery(item.notification) }}</p>
          <button v-if="item.hasPhoto" @click="showPhoto(item)">{{ item.type === 'round' ? '查看全景照片' : '查看现场照片' }}</button>
        </article>
      </template>
      <van-button v-else-if="!loading" size="small" @click="load">重试</van-button>
    </div>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { showImagePreview, showToast, showConfirmDialog } from 'vant'
import { api } from '../api'
import { useDormStore } from '../stores/dorm'
import { createUserActionConfirmation } from '../taskRegistration'
import '../userActionConfirm.css'

const confirmAction = createUserActionConfirmation(showConfirmDialog)
const dorm = useDormStore()
const data = ref(null), building = ref(''), selections = ref({}), note = ref(''), photoData = ref('')
const processing = ref(false), saving = ref(false), loading = ref(false), error = ref('')
const reasons = { offline: '离线', damaged: '损坏', power_off: '断电', abnormal_occupation: '异常占用', other: '其他异常' }
const machines = computed(() => (data.value?.machines || []).filter(m => m.dormBuilding === building.value))
const history = computed(() => (data.value?.inspections || []).filter(i => i.dormBuilding === building.value))
const selectedIssues = computed(() => machines.value.filter(m => selections.value[m.id]).map(m => ({ machineId: m.id, machineName: m.name, reasons: [...selections.value[m.id].reasons].sort(), note: selections.value[m.id].note.trim() })))
const missingReasons = computed(() => selectedIssues.value.some(issue => !issue.reasons.length))
let generation = 0, disposed = false
watch(building, () => { selections.value = {}; photoData.value = ''; note.value = '' })
watch(machines, list => { const present = new Set(list.map(m => m.id)); selections.value = Object.fromEntries(Object.entries(selections.value).filter(([id]) => present.has(id))) })
function toggleMachine(id, checked) { if (checked) selections.value[id] = { reasons: [], note: '' }; else delete selections.value[id] }
function clock(value) { return new Date(value).toLocaleString('zh-CN') }
function delivery(n) { return ({ not_required: '正常巡检，无需群通知', sending: '正在通知本楼群，巡检已保存', sent: '本楼群通知已送达', failed: '本楼群通知未确认送达，后台已记录', cooldown: '相同异常短时间内已尝试通知，本次不重复发送', unconfigured: '本楼尚未指定通知群，巡检已保存' })[n?.status] || '巡检已保存' }
async function load() {
  if (loading.value) return
  const request = ++generation
  loading.value = true; error.value = ''
  try {
    const result = await api('/api/inspections')
    if (disposed || request !== generation) return
    data.value = result
    if (!result.buildings.some(b => b.code === building.value)) building.value = result.buildings.find(b => b.code === dorm.code)?.code || result.buildings[0]?.code || ''
  } catch (e) { if (!disposed) error.value = e.message || '巡检记录读取失败' }
  finally { if (!disposed) loading.value = false }
}
async function choosePhoto(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) { showToast('请选择20MB以内的照片'); return }
  processing.value = true
  const scope = building.value
  let objectUrl
  try {
    objectUrl = URL.createObjectURL(file)
    const img = new Image(); img.src = objectUrl; await img.decode()
    const scale = Math.min(1, 2048 / Math.max(img.width, img.height), Math.sqrt(3800000 / (img.width * img.height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    let compressed = ''
    for (const quality of [.82, .65, .45, .3]) { compressed = canvas.toDataURL('image/jpeg', quality); if (compressed.length < 600000) break }
    if (compressed.length >= 600000) throw new Error('照片较大，请缩小尺寸后重试')
    if (!disposed && building.value === scope) photoData.value = compressed
  } catch (e) { showToast(e.message || '照片读取失败') }
  finally { if (objectUrl) URL.revokeObjectURL(objectUrl); processing.value = false }
}
async function submit() {
  if (saving.value || !machines.value.length || missingReasons.value || processing.value) return
  saving.value = true; error.value = ''
  try {
    const outcome = await confirmAction({
      read: () => ({ building: building.value, buildingName: data.value?.buildings.find(b => b.code === building.value)?.name || '所选楼栋', machineIds: machines.value.map(m => m.id), issues: selectedIssues.value, note: note.value.trim(), photoData: photoData.value, disposed }),
      describe: s => ({ title: '确认提交整轮巡检', message: `${s.buildingName} · 检查 ${s.machineIds.length} 台\n${s.issues.length ? s.issues.map(issue => `${issue.machineName}：${issue.reasons.map(reason => reasons[reason]).join('、')}`).join('\n') : '未勾选任何异常机器，将记录本轮全部正常。'}\n${s.note ? `本轮备注：${s.note}\n` : ''}全景照片：${s.photoData ? '已选择1张' : '未上传（选填）'}\n${s.issues.length ? '异常报告可能通知本楼指定群，请确认现场情况。' : '请确认已逐台检查现场情况。'}` }),
      execute: s => api('/api/inspections', { method: 'POST', body: { dormBuilding: s.building, issues: s.issues.map(({ machineId, reasons, note }) => ({ machineId, reasons, note })), note: s.note, ...(s.photoData ? { photoData: s.photoData } : {}) }, timeout: 20000 }),
      onChanged: () => showToast('楼栋、机器或巡检内容已变化，请重新确认'),
    })
    if (outcome.status !== 'submitted' || disposed) return
    selections.value = {}; note.value = ''; photoData.value = ''
    showToast({ message: delivery(outcome.value.inspection?.notification), className: 'user-action-feedback' })
    await load()
  } catch (e) { error.value = e.message || '上报失败，所选机器、照片和备注已保留' }
  finally { saving.value = false }
}
async function showPhoto(item) {
  try { const result = await api('/api/inspections/' + encodeURIComponent(item.id) + '/photo'); if (!disposed) showImagePreview({ images: [result.photoData], closeable: true, showIndex: false }) }
  catch (e) { showToast(e.message || '照片读取失败') }
}
onMounted(load)
onUnmounted(() => { disposed = true; generation++ })
</script>

<style scoped>
.inspection-content{max-width:720px;margin:auto;padding:12px 14px 40px}.dim{font-size:12px;color:var(--text-dim);line-height:1.7}.identity{font-size:13px;color:var(--primary);margin:14px 0}.identity span{font-size:11px;color:var(--text-dim);margin-left:10px}.inspection-form{padding:16px;display:grid;gap:14px}.inspection label{display:grid;gap:7px;font-size:13px}.inspection select,.inspection textarea{width:100%;min-width:0;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font:inherit}.round-summary,.history-heading{display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap}.round-summary{font-size:13px}.round-summary span{color:var(--text-dim)}.machine-check{margin:0;min-width:0;padding:0;border:1px solid var(--border);border-radius:12px}.machine-check.selected{border-color:#d97706}.inspection .machine-toggle{display:flex;align-items:center;gap:10px;min-height:52px;padding:12px;cursor:pointer}.machine-toggle span{flex:1;overflow-wrap:anywhere}.machine-toggle small{font-size:11px;color:var(--text-dim)}.inspection input[type=checkbox]{width:20px;height:20px;flex-shrink:0;accent-color:var(--primary)}.issue-details{padding:0 12px 12px;display:grid;gap:12px}.reasons{display:flex;flex-wrap:wrap;gap:8px 16px}.inspection .reasons label{display:flex;align-items:center;gap:6px;min-height:40px}.photo-picker{padding:14px;border:1px dashed var(--border);border-radius:10px;text-align:center;color:var(--primary);cursor:pointer}.photo-picker input{width:100%;min-width:0;font-size:11px}.photo-preview img{width:100%;max-height:260px;object-fit:contain;border-radius:8px}.photo-preview button{display:block;margin-left:auto}.history-title{display:flex;justify-content:space-between;align-items:center;margin-top:22px}.history-title h2{font-size:17px}.inspection button:not(.van-button){background:transparent;color:var(--primary);border:0;padding:10px;min-height:40px;font-size:12px}.history{padding:14px;margin:10px 0}.history p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.history small,.history .delivery{font-size:11px;color:var(--text-dim)}.history-issues{list-style:none;padding:0;margin:12px 0}.history-issues li{display:grid;gap:5px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px}.history-issues span{color:var(--text-dim)}.history-issues p{margin:0}.issue,.error{color:var(--danger,#e6495b)}.normal{color:var(--success,#1b9b62)}.error{font-size:12px;overflow-wrap:anywhere}
</style>
