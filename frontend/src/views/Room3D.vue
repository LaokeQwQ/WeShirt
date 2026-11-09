<template>
  <div class="room-page">
    <van-nav-bar>
      <template #title><button class="dorm-switch" @click="dorm.showPicker = true">{{ dorm.name || '选择住宿楼' }} · 3D 洗衣房 ▾</button></template>
      <template #right>
        <div class="nav-actions">
          <button class="switch-2d" @click="goList">2D</button>
          <button class="room-home" aria-label="回到全景" title="回到全景" @click="resetCamera"><van-icon name="replay" size="18" /></button>
        </div>
      </template>
    </van-nav-bar>

    <div ref="stageRef" class="stage" :class="{ 'has-panel': selected || facility }" tabindex="0" role="region" aria-label="3D洗衣房，数字1到7选择洗衣机，D后按1或2选择烘干机，左右箭头切换，Escape回全景" @keydown="onStageKeydown">
      <div v-if="loading" class="stage-mask"><span class="spin"></span>加载中…</div>
      <div v-else-if="error" class="stage-mask">
        <p class="err-text">{{ error }}</p>
        <van-button size="small" type="primary" @click="bootstrap">重试</van-button>
        <van-button size="small" plain @click="fallbackToList">使用2D看板</van-button>
      </div>

      <div class="legend">
        <span><i class="dot idle"></i>空闲</span>
        <span><i class="dot occ"></i>占用</span>
        <span><i class="dot abn"></i>异常占用</span>
        <span><i class="dot fal"></i>故障</span>
      </div>

      <!-- 上游抓取失败时看板会停在旧数据，不提示就会让人白跑一趟 -->
      <div v-if="staleMin !== null" class="stale-chip">
        数据是 {{ staleMin }} 分钟前的，可能不是最新
      </div>

      <div class="orientation">站在门口向里看 · 右手边 D1·1–4 · 左手边 开水机·D2·5–7</div>
      <label class="quality-control">画质
        <select v-model="qualityPreference" aria-label="3D画质" @change="changeQuality">
          <option value="auto">自动 · {{ qualityName }}</option>
          <option value="low">省电</option><option value="mid">均衡</option><option value="high">清晰</option>
        </select>
      </label>
      <div class="machine-shortcuts" aria-label="快速选择机位">
        <button v-for="slot in SLOTS" :key="slot.no" :aria-label="`${slot.no}号${slot.kind === 'dryer' ? '烘干机' : '洗衣机'}`" :aria-pressed="selected?.no === slot.no" @click="selectSlot(slot.no)">{{ slot.no }}</button>
      </div>
    </div>

    <!-- 机器悬浮面板：点中某台机器后跟随其上方悬浮（90% 不透明） -->
    <transition name="sheet">
      <div
        v-if="selected || facility"
        ref="panelRef"
        class="machine-panel"
        role="region"
        aria-label="机位详情"
        :style="isWide ? { left: panelPos.x + 'px', top: panelPos.y + 'px' } : {}"
      >
        <template v-if="facility === 'boiler'">
          <div class="mp-head">
            <div class="mp-no boiler-no">水</div>
            <div class="mp-meta">
              <div class="mp-name">开水机</div>
              <div class="mp-state">使用须知</div>
            </div>
            <van-icon name="cross" class="mp-close" @click="clearSelection" />
          </div>
          <ul class="mp-rules">
            <li v-for="line in FACILITY_RULES.boiler" :key="line">{{ line }}</li>
          </ul>
        </template>
        <template v-else-if="facility === 'washer' || facility === 'dryer'">
          <div class="mp-head">
            <div class="mp-no boiler-no">须</div>
            <div class="mp-meta">
              <div class="mp-name">{{ facility === 'washer' ? '洗衣机' : '烘干机' }}使用须知</div>
              <div class="mp-state">放大查看</div>
            </div>
            <van-icon name="cross" class="mp-close" @click="clearSelection" />
          </div>
          <ul class="mp-rules">
            <li v-for="line in FACILITY_RULES[facility]" :key="line">{{ line }}</li>
          </ul>
        </template>
        <template v-else>
        <div class="mp-head">
          <button class="mp-nav" aria-label="上一台机器" @click="switchMachine(-1)">‹</button>
          <div class="mp-no" :style="{ borderColor: cssColor(selected.state) }">{{ selected.no }}</div>
          <div class="mp-meta">
            <div class="mp-name">{{ selected.rawName || selected.name }}</div>
            <div class="mp-state" :style="{ color: cssColor(selected.state) }">
              {{ selected.availabilityLabel || stateText(selected.state) }}
              <template v-if="selected.state === 'occupied' && selected.leftMin != null">
                · {{ selected.leftMin > 0 ? (selected.estimated ? '估算剩余 ' : '剩余 ') + selected.leftMin + ' 分钟' : '结束时间待确认' }}
              </template>
            </div>
            <div v-if="!selected.registrationPending && ['occupied','abnormal'].includes(selected.state)" class="mp-hint-dim">运行中，程序未提供</div>
            <!-- 对不上设备时说清楚原因：多半是后台机位绑了别的楼栋/已下线的机器 -->
            <div v-if="selected.state === 'unknown'" class="mp-dev">
              没对上设备（后台给这个机位绑的机器不在看板里）
            </div>
            <div v-else-if="selected.machineId" class="mp-dev">
              设备 {{ selected.machineId
              }}<template v-if="selected.rawState !== undefined && selected.rawState !== null">
                · 上游状态码 {{ selected.rawState }}</template
              >
            </div>
          </div>
          <button class="mp-nav" aria-label="下一台机器" @click="switchMachine(1)">›</button>
          <button class="mp-close" aria-label="关闭机位详情" @click="clearSelection"><van-icon name="cross" /></button>
        </div>

        <!-- 占用者：头像 + 昵称（打码）+ 几分钟前登记 -->
        <div v-if="selectedOccupier" class="mp-occupier">
          <Avatar
            :name="selectedOccupier.nick || '匿名'"
            :src="selectedOccupier.avatarUrl"
            :size="26"
            class="mp-occ-avatar"
          />
          <span class="mp-occ-text">{{ selectedOccupier.nick }} 于 {{ selectedOccupier.startMin }} 分钟前登记洗衣</span>
        </div>
        <CareRecord :record="selectedOccupier?.care" />
        <!-- 异常占用：可以催 TA（后端发钉钉 DING，5 分钟/台限频） -->
        <van-button
          v-if="selected.state === 'abnormal'"
          block
          size="small"
          type="warning"
          class="mp-urge"
          :loading="urgeSending"
          @click="urgeOccupier"
        >
          催 TA 一下（钉钉提醒）
        </van-button>

        <!-- 查看手机号前必须先交凭证：确认周围无空桶 + 两张照片，后台留档并通知管理员 -->
        <div v-if="proofFor && proofFor === selected.machineId" class="mp-proof">
          <div class="mp-proof-title">要看对方手机号，需先上传凭证</div>
          <label class="mp-proof-line">
            <input v-model="proofConfirm" type="checkbox" />
            我确认洗衣机<b>周围没有空桶</b>可以放衣物
          </label>
          <div class="mp-proof-photos">
            <button type="button" class="mp-proof-btn" @click="pickProof('occ')">
              {{ proofOcc ? '✅ 衣物占用照' : '📷 拍衣物占用' }}
            </button>
            <button type="button" class="mp-proof-btn" @click="pickProof('around')">
              {{ proofAround ? '✅ 机器周围照' : '📷 拍机器周围' }}
            </button>
          </div>
          <input ref="occInput" type="file" accept="image/*" class="mp-file" @change="onProofPick($event, 'occ')" />
          <input ref="aroundInput" type="file" accept="image/*" class="mp-file" @change="onProofPick($event, 'around')" />
          <div v-if="proofSize" class="mp-proof-size">{{ proofSize }}</div>
          <van-button
            block
            size="small"
            type="danger"
            :loading="proofSending"
            :disabled="!proofConfirm || !proofOcc || !proofAround"
            @click="submitProof"
          >
            提交凭证并查看手机号
          </van-button>
          <div class="mp-proof-tip">提交会记录你的账号 ID 与两张照片，并通知管理员，仅用于纠纷追溯。</div>
        </div>

        <div class="mp-modes">
          <button v-if="machineLeftMin" type="button" :class="{on:registrationMode==='machine'}" :disabled="submitting" @click="registrationMode='machine'">按机器剩余 {{ machineLeftMin }} 分钟提醒</button>
          <button type="button" :class="{on:registrationMode==='duration'}" :disabled="submitting" @click="registrationMode='duration'">自己选{{ selected.kind === 'dryer' ? '时长' : '程序' }}</button>
        </div>
        <p v-if="selected.estimated" class="mp-hint-dim">剩余时间为系统估算，请自己确认程序；估算到点不表示机器已结束。</p>
        <!-- 烘干机专用面板：烘干时间（带加减） + 登记烘干 -->
        <!-- 故障/未知也允许登记：面板状态可能滞后，前端还有二次确认，
             强行拦住反而把人挡在门外。登记后按「使用中」算。 -->
        <template v-if="selected.kind === 'dryer'">
          <div v-if="stuckMinFor(selected.machineId) >= 8" class="mp-dry-warn">
            <div>剩余 {{ selected.leftMin }} 分钟</div>
            <div>已经 {{ stuckMinFor(selected.machineId) }} 分钟时间未变化</div>
            <div class="mp-dry-warn-sub">可能跳闸，注意确认</div>
          </div>
          <div class="mp-dry">
            <div v-if="registrationMode === 'duration'" class="mp-dry-row">
              <span class="mp-dry-label">烘干时间</span>
              <button type="button" class="mp-step" @click="stepDry(-10)">−</button>
              <input
                v-model.number="dryMinutes"
                type="number"
                inputmode="numeric"
                class="mp-dry-input"
                min="10"
                max="180"
                step="1"
                @blur="clampDry"
              />
              <button type="button" class="mp-step" @click="stepDry(10)">＋</button>
              <span class="mp-dry-unit">分钟</span>
            </div>
            <TaskDetailsForm v-model:note="noteText" :show-disinfectant="false" :disabled="submitting" />
            <van-button
              block
              type="primary"
              size="small"
              :loading="submitting"
              :disabled="!selected.machineId"
              @click="quickStartDryer"
            >
              登记烘干（{{ registrationMode === 'machine' ? '按机器余时' : dryMinutes + ' 分钟' }}）
            </van-button>
          </div>
          <div class="mp-queue">
            <van-button
              size="small"
              :type="myQueueEntry ? 'warning' : 'default'"
              :loading="queueSubmitting"
              :disabled="!selected.machineId"
              @click="toggleQueue"
            >
              {{ myQueueEntry ? '取消排队' : '排队等这台' }}
            </van-button>
            <span v-if="selectedQueueCount" class="mp-queue-n">
              排 {{ selectedQueueCount }} 人<template v-if="myQueueEntry && myQueueEntry.position">
                · 你第 {{ myQueueEntry.position }} 位</template
              >
            </span>
          </div>
        </template>

        <template v-if="selected.state !== 'faulty' && selected.kind !== 'dryer'">
          <div v-if="registrationMode === 'duration'" class="mp-durations">
            <button
              v-for="d in DURATIONS"
              :key="d.minutes"
              type="button"
              class="mp-dur"
              :class="{ on: chosenMinutes === d.minutes && programLabel === d.label }"
              :disabled="submitting"
              @click="selectWashProgram(d)"
              >{{ d.label }}</button
            >
          </div>
          <label v-if="registrationMode === 'duration'" class="mp-custom-duration">自定义分钟 <input v-model.number="chosenMinutes" type="number" min="1" max="180" step="1" inputmode="numeric" :disabled="submitting" @input="clearWashProgram" />（1–180 整数）</label>
          <TaskDetailsForm v-model:note="noteText" v-model:use-disinfectant="useDisinfectant" v-model:self-cleaned="selfCleaned" :disabled="submitting" />
          <van-button
            block
            type="primary"
            size="small"
            :loading="submitting"
              :disabled="!selected.machineId"
            @click="quickStart"
          >
            登记洗衣（{{ registrationMode === 'machine' ? '按机器余时' : chosenMinutes + ' 分钟' }}，{{ previewEndText }} 提醒）
          </van-button>
          <div class="mp-queue">
            <van-button
              size="small"
              :type="myQueueEntry ? 'warning' : 'default'"
              :loading="queueSubmitting"
              :disabled="!selected.machineId"
              @click="toggleQueue"
            >
              {{ myQueueEntry ? '取消排队' : '排队等这台' }}
            </van-button>
            <span v-if="selectedQueueCount" class="mp-queue-n">
              排 {{ selectedQueueCount }} 人<template v-if="myQueueEntry && myQueueEntry.position">
                · 你第 {{ myQueueEntry.position }} 位</template
              >
            </span>
          </div>
        </template>
        <!-- 故障面板必须自己判断，不能挂 v-else：
             它跟的是「洗衣机 && 非故障」那个 v-if，烘干机永远进不去那个分支，
             结果正常的烘干机也会多出一块「这台显示故障 / 恢复正常」，
             误点还会把它标成已修复、之后真故障反而显示空闲。 -->
        <div v-if="selected.state === 'faulty'" class="mp-fault">
          <div class="mp-fault-hint">这台显示故障。现场确认修好后，点下面按钮。</div>
          <van-button
            block
            size="small"
            type="primary"
            :loading="recovering"
            @click="recoverFault"
          >
            恢复正常
          </van-button>
        </div>

        <!-- 这台机器的留言板 -->
        <div class="mp-msgs">
          <div class="mp-msgs-title">本机留言</div>
          <div v-if="!machineMessages.length" class="mp-msg-empty">还没有留言</div>
          <div v-for="msg in machineMessages" :key="msg.id" class="mp-msg">
            <span class="mp-msg-nick">{{ msg.nick }}</span>
            <span class="mp-msg-text">{{ msg.text }}</span>
          </div>
          <div class="mp-msg-post">
            <input
              v-model="msgText"
              class="mp-note"
              maxlength="50"
              placeholder="给这台机器留言…"
              @keyup.enter="postMachineMessage"
            />
            <span class="mp-send" @click="postMachineMessage">发送</span>
          </div>
        </div>
        </template>
      </div>
    </transition>
    <!-- 昵称/头像默认由钉钉资料生成（钉钉昵称 + 「同学」、钉钉头像），
         不再在开屏弹「起个名字、选个头像」——多一步就会被跳过，
         而且跳过之后昵称还是随机的，反而更乱。要改去设置页。 -->
  </div>
</template>

<script setup>
// ─────────────────────────────────────────────────────────────
// 3D 洗衣房：6 台机器的空间编号约定（与现场物理位置一致）
//
//   视角：用户站在洗衣房门口，面向房间内部（相机朝 -Z 看）
//   右手边（+X）从近到远：1、2、3
//   左手边（-X）从近到远：4、5、6
//
//   靠近门口 = +Z，靠近里墙 = -Z
//   机器正面朝向中间走道：右排朝 -X，左排朝 +X
// ─────────────────────────────────────────────────────────────
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import Avatar from '../components/Avatar.vue'
import TaskDetailsForm from '../components/TaskDetailsForm.vue'
import CareRecord from '../components/CareRecord.vue'
import { loadBoard } from '../boardQuery'
import { useDormStore } from '../stores/dorm'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { api } from '../api'
import { useUserStore } from '../stores/user'
import { track } from '../telemetry'
import { normalizeQualityPreference, chooseInitialQuality, renderInterval, labelSignature, createPointerGesture } from '../room/strategy'
import { mergeStaticEnvironment, disposeObjectResources } from '../room/resources'
import { createCompatibleRenderer, signalRoomFailure } from '../room/compatibility'
import { WASHER_PROGRAMS, machineRemainingMinutes, machineActionName, registrationSnapshot, registrationDescription, registrationBody, createUserActionConfirmation } from '../taskRegistration'
import '../userActionConfirm.css'

const userStore = useUserStore()
const dorm = useDormStore()

const router = useRouter()
const route = useRoute()
const stageRef = ref(null)
const panelRef = ref(null)
const loading = ref(true)
const error = ref('')
const staleMin = ref(null) // 看板数据过期多少分钟（≥3 才提示）
const clockNow = ref(Date.now())
let lastBoardUpdated = 0
let disposed = false
let contextFailed = false
let conservativeRenderer = false
let readyAt = 0
const startedAt = performance.now()
let performanceWindow = { at: 0, frames: 0 }
function roomTrack(name, fields) { try { track(name, fields)?.catch?.(() => {}) } catch { /* 统计失败不影响交互 */ } }
function readQualityPreference() { try { return normalizeQualityPreference(localStorage.getItem('ws_room_quality')) } catch { return 'auto' } }
const qualityPreference = ref(readQualityPreference())
const activeQuality = ref('mid')
const qualityName = computed(() => ({ low: '省电', mid: '均衡', high: '清晰' })[activeQuality.value])
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
let reducedMotion = motionQuery.matches
const selected = ref(null)
const facility = ref(null)
const FACILITY_RULES = {
  boiler: ['刷卡后接水，接满即关', '暖瓶放进接水区，不要手持对嘴', '开水很烫，接水时站在侧面', '接完把接水盘的水沥干'],
  washer: ['先在这台机器上登记，再按启动', '洗完及时取衣，超时会标成异常占用', '故障先看现场，再在机器上留言', '地面有水先拖干，再开始下一筒'],
  dryer: ['衣物先脱水，再放进烘干机', '到时及时取出，避免回潮', '滤网有毛絮就清掉', '烘干中途开门，先等滚筒停稳']
}
const submitting = ref(false)
const DURATIONS = WASHER_PROGRAMS
const chosenMinutes = ref(30)
const registrationMode = ref('duration')
const program = ref('')
const programLabel = ref('标准洗 30分钟')
const confirmAction = createUserActionConfirmation(showConfirmDialog)
const machineLeftMin = computed(() => machineRemainingMinutes(selected.value, clockNow.value))
function selectWashProgram(value) { chosenMinutes.value = value.minutes; program.value = value.minutes === 6 ? 'self_clean' : ''; programLabel.value = value.label }
function clearWashProgram() { program.value = ''; programLabel.value = '' }
function registrationState(kind) {
  return { ...registrationSnapshot(selected.value, { mode: registrationMode.value, minutes: kind === 'dryer' ? dryMinutes.value : chosenMinutes.value, program: program.value, programLabel: programLabel.value, note: noteText.value, useDisinfectant: useDisinfectant.value, selfCleaned: selfCleaned.value }), userId: userStore.user?.id || '', dorm: dorm.code, disposed }
}

// 每个任务的预计提醒时间（展示用，和真正下发的口径一致）
const previewEndText = computed(() => {
  const t = registrationMode.value === 'machine' ? Date.parse(selected.value?.finishAt || '') || clockNow.value + machineLeftMin.value * 60000 : clockNow.value + chosenMinutes.value * 60000
  return new Date(t).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
})

function resetRegisterMode() {
  registrationMode.value = machineRemainingMinutes(selected.value) > 0 ? 'machine' : 'duration'
  chosenMinutes.value = 30; program.value = ''; programLabel.value = '标准洗 30分钟'
  dryMinutes.value = 60
  noteText.value = ''; useDisinfectant.value = false; selfCleaned.value = false
}

// 烘干机专用：10~180 整数分钟；快捷按钮步进 10。
const dryMinutes = ref(60)
function clampDry() {
  const n = Number(dryMinutes.value)
  const v = Number.isFinite(n) ? Math.round(n) : 60
  dryMinutes.value = Math.min(180, Math.max(10, v || 60))
}
function stepDry(delta) {
  clampDry()
  dryMinutes.value = Math.min(180, Math.max(10, dryMinutes.value + delta))
}
// 查看手机号的凭证流程：衣物占用照 + 机器周围照，前端强压缩
const proofFor = ref('')
const proofConfirm = ref(false)
const proofOcc = ref('')
const proofAround = ref('')
const proofSize = ref('')
const proofSending = ref(false)
const occInput = ref(null)
const aroundInput = ref(null)

function pickProof(kind) {
  ;(kind === 'occ' ? occInput : aroundInput).value?.click()
}

/**
 * 前端压缩：等比缩到最长边 max，再按质量 q 编码。
 * 若仍然超过 budget 字节，自动降质量重试（0.72 → 0.5 → 0.35），最后再降尺寸。
 * 这样用户拿手机直出 4000px 的原图也能稳定压到 ~100KB 以内，不用手动重拍。
 */
function compressImage(file, { max = 1280, budget = 150000 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const draw = (side) => {
        const scale = Math.min(1, side / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.width * scale))
        c.height = Math.max(1, Math.round(img.height * scale))
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#fff' // 透明 PNG 转 JPEG 会变黑底，先铺白
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.drawImage(img, 0, 0, c.width, c.height)
        return c
      }
      try {
        let side = max
        let out = ''
        for (let round = 0; round < 3; round++) {
          const canvas = draw(side)
          for (const q of [0.72, 0.55, 0.4, 0.3]) {
            out = canvas.toDataURL('image/jpeg', q)
            // dataURL 是 base64，实际字节 ≈ 长度 * 3/4
            if (out.length * 0.75 <= budget) return resolve(out)
          }
          side = Math.round(side * 0.75) // 质量降到底还超，就降尺寸再来一轮
        }
        resolve(out) // 兜底：交给后端长度校验
      } catch (e) {
        reject(new Error('图片处理失败，换一张试试'))
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败，换一张试试'))
    }
    img.src = url
  })
}

async function onProofPick(e, kind) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    proofSize.value = '正在压缩…'
    const dataUrl = await compressImage(f)
    const kb = Math.round((dataUrl.length * 0.75) / 1024)
    proofSize.value = `已压缩到约 ${kb} KB`
    if (kind === 'occ') proofOcc.value = dataUrl
    else proofAround.value = dataUrl
  } catch (err) {
    proofSize.value = ''
    showToast(err?.message || '照片处理失败')
  }
}

async function submitProof() {
  if (proofSending.value || !proofConfirm.value || !proofOcc.value || !proofAround.value) return
  proofSending.value = true
  try {
    const result = await confirmAction({
      read: () => ({ machineId: proofFor.value, selectedMachineId: selected.value?.machineId, name: machineActionName(selected.value), confirmEmpty: proofConfirm.value, photoOccupied: proofOcc.value, photoAround: proofAround.value, userId: userStore.user?.id || '', disposed }),
      describe: (snapshot) => ({ title: '确认提交现场凭证', message: `${snapshot.name}\n已确认周围无空桶；已选择衣物占用照和机器周围照，共2张。\n提交后会留档并通知管理员，仅用于此次占用处理。` }),
      execute: (snapshot) => api('/api/urge/reveal', { method: 'POST', body: { machineId: snapshot.machineId, confirmEmpty: snapshot.confirmEmpty, photoOccupied: snapshot.photoOccupied, photoAround: snapshot.photoAround } }),
      onChanged: () => showToast('机位或凭证内容已变化，请重新确认'),
    })
    if (result.status !== 'submitted') return
    const r = result.value
    await showConfirmDialog({
      title: '已留档',
      message:
        (r?.phone
          ? `对方手机号：${r.phone}\n`
          : '对方没有留手机号，可以先在留言板留个言。\n') +
        `\n凭证编号：${r?.auditId || '-'}` +
        (r?.adminNotified ? '\n管理员已收到通知' : ''),
      confirmButtonText: '知道了',
      showCancelButton: false,
    })
    proofFor.value = ''
    proofConfirm.value = false
    proofOcc.value = ''
    proofAround.value = ''
    proofSize.value = ''
  } catch (e) {
    showToast(e?.message || '提交失败')
  } finally {
    proofSending.value = false
  }
}

// 烘干机「卡住」检测：剩余分钟数长时间不变 = 很可能跳闸/断电。
// 只针对当前打开面板的机器（面板上才有意义），每 30 秒采样一次。
// 注意用 leftMin：这是 buildBoard 由 finishAt 算出来的剩余分钟，
// 机器对象上**没有** remainMin 这个字段。
const stuckState = ref({ id: '', remain: null, at: 0, min: 0 })
const stuckTimer = setInterval(() => {
  const s = selected.value
  if (!s || s.kind !== 'dryer' || s.state === 'idle' || s.state === 'faulty') {
    if (stuckState.value.id) stuckState.value = { id: '', remain: null, at: 0, min: 0 }
    return
  }
  const now = Date.now()
  const st = stuckState.value
  const left = s.leftMin
  // 剩余时间读不到（null/undefined）就不要当成「没变化」，否则会误报
  if (left == null) {
    if (stuckState.value.id) stuckState.value = { id: '', remain: null, at: 0, min: 0 }
    return
  }
  if (st.id !== s.machineId || st.remain !== left) {
    stuckState.value = { id: s.machineId, remain: left, at: now, min: 0 }
  } else {
    const min = Math.floor((now - st.at) / 60000)
    stuckState.value = { ...st, min }
    // 通知由**服务端 sync** 负责（不依赖有没有人开着页面）。
    // 这里只负责界面提示，不再自己发请求，避免同一件事被通知两次。
  }
}, 30000)
function stuckMinFor(id) {
  return stuckState.value.id === id ? stuckState.value.min : 0
}
// 组件卸载必须清掉轮询，否则每次进出 3D 页都会多一个常驻定时器
onUnmounted(() => clearInterval(stuckTimer))

async function quickStartDryer() {
  return submitRegistration('dryer')
}

async function submitRegistration(kind) {
  if (submitting.value) return
  if (kind === 'dryer' && registrationMode.value === 'duration') clampDry()
  if (!selected.value?.machineId) { showToast('机位尚未绑定，请联系管理员'); return }
  submitting.value = true
  try {
    registrationBody(registrationState(kind))
    const result = await confirmAction({
      read: () => registrationState(kind),
      describe: registrationDescription,
      execute: (snapshot) => api('/api/tasks', { method: 'POST', body: registrationBody(snapshot) }),
      onChanged: () => showToast('机器或填写内容已变化，请检查后重新确认'),
    })
    if (result.status !== 'submitted') return
    showToast({ message: '已登记，提醒计时已保存', className: 'user-action-feedback' })
    noteText.value = ''
    useDisinfectant.value = false; selfCleaned.value = false
    await syncData()
  } catch (e) {
    showToast(e?.message || '登记失败')
  } finally {
    submitting.value = false
  }
}
const noteText = ref('')
const useDisinfectant = ref(false)
const selfCleaned = ref(false)
const msgText = ref('')
const allMessages = ref([]) // 全楼留言（含 machineId 标记）
const panelPos = ref({ x: 0, y: 0 }) // 悬浮面板的屏幕坐标（每帧投影更新）
const queueList = ref([]) // 排队列表（每条 { machineId, nick, at, mine }）
const queueSubmitting = ref(false)
const occupancyMap = ref({}) // machineId → { nick(打码), avatar, startMin }
const urgeSending = ref(false)
const recovering = ref(false)

// 当前选中机器的占用者（谁、几分钟前登记的）
const selectedOccupier = computed(() => {
  if (!selected.value?.machineId) return null
  return occupancyMap.value[selected.value.machineId] || null
})

// 提醒取衣：每台 5 分钟可点一次；累计第 3 次会返回对方手机号
async function urgeOccupier() {
  if (!selected.value?.machineId || urgeSending.value) return
  urgeSending.value = true
  try {
    const result = await confirmAction({
      read: () => ({ machineId: selected.value?.machineId || '', name: machineActionName(selected.value), state: selected.value?.state, userId: userStore.user?.id || '', disposed }),
      describe: (snapshot) => ({ title: '确认提醒取衣', message: `${snapshot.name}\n请先现场确认机器已结束且衣物仍在。确认后将向登记人发送一次取衣提醒。` }),
      execute: (snapshot) => api('/api/urge', { method: 'POST', body: { machineId: snapshot.machineId } }),
      onChanged: () => showToast('所选机器已变化，请重新确认'),
    })
    if (result.status !== 'submitted') return
    const r = result.value
    if (r?.needProof) {
      proofFor.value = selected.value.machineId
      showToast('已提醒 3 次，查看手机号需要上传凭证')
    } else {
      showToast(`已提醒（第 ${r?.count || 1} 次）${r?.dmSent ? '·钉钉已送达' : ''}`)
    }
    await syncData()
  } catch (e) {
    showToast(e?.message || '提醒失败')
  } finally {
    urgeSending.value = false
  }
}

// 故障机：二次确认后才视为已恢复，并重新允许上报（登记洗衣）
async function recoverFault() {
  if (!selected.value?.machineId || recovering.value) return
  recovering.value = true
  try {
    const result = await confirmAction({
      read: () => ({ machineId: selected.value?.machineId || '', name: machineActionName(selected.value), state: selected.value?.state, userId: userStore.user?.id || '', disposed }),
      describe: (snapshot) => ({ title: '确认上报已恢复', message: `${snapshot.name}\n请确认已在现场检查并恢复正常。此次仅记录恢复报告，机器是否空闲仍须核对远端和现场状态。` }),
      execute: (snapshot) => api('/api/faults/recover', { method: 'POST', body: { machineId: snapshot.machineId } }),
      onChanged: () => showToast('所选机器已变化，请重新确认'),
    })
    if (result.status !== 'submitted') return
    showToast({ message: '恢复报告已提交，请核对机器状态', className: 'user-action-feedback' })
    await syncData()
  } catch (e) {
    showToast(e?.message || '恢复失败')
  } finally {
    recovering.value = false
  }
}

// 宽屏（平板/桌面）面板跟随机器悬浮；窄屏（手机）固定在底部成卡片
const widthQuery = window.matchMedia('(min-width: 720px)')
const isWide = ref(widthQuery.matches)
const onWidthChange = (event) => { isWide.value = event.matches }
widthQuery.addEventListener('change', onWidthChange)

// 场景编号 → 空间坐标（x 正为右，z 正为近）
// 机器直放、略微靠墙（墙面 x=±2.05，机身背面距墙约 0.32m，背后留投放装置/水管空间）
// 现场布局：右手边从近到远 = D1、1、2、3、4；左手边 = 开水机、D2、7、6、5
const SLOTS = [
  { no: 'D1', kind: 'dryer', x: 1.42, z: 2.7 },
  { no: 1, kind: 'washer', x: 1.42, z: 1.65 },
  { no: 2, kind: 'washer', x: 1.42, z: 0.6 },
  { no: 3, kind: 'washer', x: 1.42, z: -0.45 },
  { no: 4, kind: 'washer', x: 1.42, z: -1.5 },
  { no: 'D2', kind: 'dryer', x: -1.42, z: 2.7 },
  { no: 7, kind: 'washer', x: -1.42, z: 1.65 },
  { no: 6, kind: 'washer', x: -1.42, z: 0.6 },
  { no: 5, kind: 'washer', x: -1.42, z: -0.45 }
]

const STATE_HEX = {
  idle: 0x22c55e,
  occupied: 0xf59e0b,
  abnormal: 0xf97316, // 异常占用（有人上报"洗完未取"）：橙色
  faulty: 0xef4444,
  unknown: 0x6b7280
}
const STATE_CSS = {
  idle: '#22c55e',
  occupied: '#f59e0b',
  abnormal: '#f97316',
  faulty: '#ef4444',
  unknown: '#6b7280'
}
const STATE_TEXT = {
  idle: '空闲',
  occupied: '使用中',
  abnormal: '异常占用',
  faulty: '故障',
  unknown: '未知'
}

const cssColor = (s) => STATE_CSS[s] || STATE_CSS.unknown
const stateText = (s) => STATE_TEXT[s] || STATE_TEXT.unknown

// Three.js 运行时句柄（用普通变量，避免被 Vue 响应式代理）
let renderer = null
let scene = null
let camera = null
let controls = null
let rafId = 0
let resizeHandler = null
let visHandler = null
let clickTargets = [] // 可拾取的 mesh 列表
const windowSashes = [] // 可推开的窗扇 { group, closedRot, openRot, targetRot }
let faucetStream = null // 空水龙头的水流（点开时可见）
let faucetOn = false
const machines = [] // { no, slot, group, ringMat, label, data }
const pointerGesture = createPointerGesture()
const pointerNdc = new THREE.Vector2()
const pointerRay = new THREE.Raycaster()
const pointerHits = []
const panelAnchor = new THREE.Vector3()
let environmentTarget = null
let resizeObserver = null
let interacting = false
let lastInteractionAt = 0
let timer = null
let flicker = 0
let prevT = 0

function goBack() {
  router.push('/list')
}

function fallbackToList() {
  roomTrack('room_interaction', { action: 'fallback' })
  router.replace('/list')
}

function goList() {
  router.push('/list')
}

// ─────────────────────────────────────────────────────────────
// 共享几何 / 材质缓存（性能：8 台机器复用同一批 geometry）
// ─────────────────────────────────────────────────────────────
const GEO = {
  body: new THREE.BoxGeometry(0.62, 0.95, 0.66),
  bodyDryer: new THREE.BoxGeometry(0.62, 1.02, 0.66),
  top: new THREE.BoxGeometry(0.66, 0.045, 0.7),
  panel: new THREE.BoxGeometry(0.016, 0.12, 0.52),
  glass: new THREE.SphereGeometry(0.31, 24, 8, 0, Math.PI * 2, 0, 0.52), // 微凸舷窗穹面（半径≈0.155）
  glassDryer: new THREE.SphereGeometry(0.36, 24, 8, 0, Math.PI * 2, 0, 0.52), // 半径≈0.18
  bezel: new THREE.RingGeometry(0.155, 0.237, 48), // 实心门框盘（让门读起来是"门"而不是光圈）
  bezelDryer: new THREE.RingGeometry(0.18, 0.262, 48),
  ring: new THREE.TorusGeometry(0.238, 0.022, 12, 48),
  ringDryer: new THREE.TorusGeometry(0.263, 0.022, 12, 48),
  base: new THREE.BoxGeometry(0.72, 0.035, 0.76),
  drumBase: new THREE.CylinderGeometry(0.19, 0.19, 0.012, 32),
  drumBaseDryer: new THREE.CylinderGeometry(0.214, 0.214, 0.012, 32),
  drumLip: new THREE.TorusGeometry(0.164, 0.01, 8, 32),
  drumLipDryer: new THREE.TorusGeometry(0.184, 0.01, 8, 32),
  xBar: new THREE.BoxGeometry(0.018, 0.31, 0.018),
  strip: new THREE.BoxGeometry(0.34, 0.018, 0.03),
  vent: new THREE.BoxGeometry(0.34, 0.012, 0.03),
  boot: new THREE.CylinderGeometry(0.225, 0.225, 0.07, 36, 1, true),
  bootDryer: new THREE.CylinderGeometry(0.25, 0.25, 0.07, 36, 1, true),
  waterDisc: new THREE.CircleGeometry(0.17, 24),
  waterFront: null, // 延迟到 makeWaterFrontGeo 定义后填充
  waterFrontDryer: null,
  hit: new THREE.CircleGeometry(0.34, 16), // 隐形拾取盘（舱门中心，加大容错）
  hitDryer: new THREE.CircleGeometry(0.37, 16)
}

// 布团：细分球 + 多倍频顶点位移 + 随机压扁，揉出"皱成一团衣物"的感觉
// 墙装水龙头：圆法兰贴墙、横管探出、鹅颈下弯、扁嘴朝下，侧面十字把手
// axis 'x' 用于左右墙，'z' 用于后墙；sign 是从墙指向房间的方向
function makeFaucet({ axis = 'x', sign = 1, clickable = false } = {}) {
  const g = new THREE.Group()
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd7e0e8, roughness: 0.16, metalness: 0.94 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x5d6874, roughness: 0.4, metalness: 0.7 })
  const mark = (mesh) => {
    if (clickable) {
      mesh.userData.faucet = true
      clickTargets.push(mesh)
    }
    return mesh
  }
  const along = (x, y, z) => (axis === 'z' ? new THREE.Vector3(z, y, x) : new THREE.Vector3(x, y, z))
  const addBox = (sx, sy, sz, x, y, z, mat = chrome) => {
    const p = along(x * sign, y, z)
    const m = mark(new THREE.Mesh(new THREE.BoxGeometry(axis === 'z' ? sz : sx, sy, axis === 'z' ? sx : sz), mat))
    m.position.copy(p)
    g.add(m)
    return m
  }
  const addCyl = (rTop, rBot, h, x, y, z, rotAxis) => {
    const m = mark(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, 12), chrome))
    m.position.copy(along(x * sign, y, z))
    if (rotAxis === 'z') m.rotation.z = Math.PI / 2
    if (rotAxis === 'x') m.rotation.x = Math.PI / 2
    g.add(m)
    return m
  }
  addCyl(0.034, 0.034, 0.012, 0.006, 0, 0, axis === 'z' ? 'x' : 'z')
  addCyl(0.015, 0.015, 0.055, 0.034, 0, 0, axis === 'z' ? 'x' : 'z')
  addCyl(0.013, 0.013, 0.07, 0.062, -0.03, 0)
  addBox(0.03, 0.012, 0.02, 0.07, -0.066, 0)
  addCyl(0.011, 0.011, 0.03, 0.046, 0.02, 0)
  addBox(0.006, 0.034, 0.006, 0.046, 0.038, 0, dark)
  addBox(0.006, 0.006, 0.034, 0.046, 0.038, 0, dark)
  return g
}

function makeClothPiece(radius, material) {
  const fold = 0.35 + Math.random() * 0.45
  const geo = new THREE.PlaneGeometry(radius * 2.4, radius * 1.55, 7, 5)
  const pos = geo.attributes.position
  const v = new THREE.Vector3()
  const p1 = Math.random() * 6.28
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const wave = Math.sin((v.x / radius) * 2.2 + p1) * Math.cos((v.y / radius) * 1.6) * radius * 0.22
    const crease = Math.abs(v.y) < radius * 0.12 ? -radius * fold : 0
    pos.setXYZ(i, v.x, v.y + crease * 0.15, wave + crease)
  }
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, material)
  mesh.rotation.set(Math.random() * 0.8, Math.random() * 6.28, (Math.random() - 0.5) * 0.6)
  return mesh
}

// 桶内水面（半透明水盘，顶点做轻微波浪；水位只盖下半部）
function makeWaterSurface() {  const geo = GEO.waterDisc.clone()
  const pos = geo.attributes.position
  const base = new Float32Array(pos.array) // 原始顶点（xy 平面）
  const mat = new THREE.MeshStandardMaterial({
    color: 0x66b3e8,
    transparent: true,
    opacity: 0.5,
    roughness: 0.15,
    metalness: 0.35,
    emissive: new THREE.Color(0x16344d), // 暗桶里也能看清"这是水"
    emissiveIntensity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2 // 转到水平
  mesh.userData.base = base
  return mesh
}

// 水面波动：在原始顶点上叠加低频正弦，每帧只改 y（≈50 顶点，开销极小）
function animateWater(mesh, t) {
  const pos = mesh.geometry.attributes.position
  const base = mesh.userData.base
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3]
    const y = base[i * 3 + 1]
    const wave = Math.sin(x * 9 + t * 2.6) * 0.012 + Math.cos(y * 7 + t * 1.9) * 0.01
    pos.setXYZ(i, x, y, wave) // 圆盘已旋转到水平，z 是起伏方向
  }
  pos.needsUpdate = true
}

// 鼓形水线截面（正对舱门的圆形切片 + 底部水位弦）：让人隔着玻璃一眼看到"有水"
// 真实滚筒机从侧面看水是一汪平面，但从正前方只能看到水位线 —— 这块竖直的弦面就是那条线
function makeWaterFrontGeo(radius) {
  const R = radius
  const level = -R * 0.28 // 水位线高度（圆心往下 28% 处）
  const half = Math.sqrt(R * R - level * level)
  const shape = new THREE.Shape()
  shape.moveTo(-half, level)
  shape.lineTo(half, level)
  // 沿下半圆弧扫回起点
  const a0 = Math.atan2(level, half)
  shape.absarc(0, 0, R, a0, Math.PI - a0, true)
  return new THREE.ShapeGeometry(shape, 24)
}

const WATER_FRONT_MAT = new THREE.MeshStandardMaterial({
  color: 0x5aa9e6,
  transparent: true,
  opacity: 0.45,
  roughness: 0.2,
  metalness: 0.2,
  emissive: new THREE.Color(0x1d4361),
  emissiveIntensity: 0.7,
  side: THREE.DoubleSide,
  depthWrite: false
})

// 填充共享的水线截面几何（洗衣机 / 烘干机两种桶径）
GEO.waterFront = makeWaterFrontGeo(0.19)
GEO.waterFrontDryer = makeWaterFrontGeo(0.214)

// 圆角矩形路径
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// 机器上方的编号牌（CanvasTexture → Sprite）
// 分辨率从 256×140 提到 512×280：手机上编号牌原来明显发虚，
// 是因为贴图只有 256px 宽、又被拉到近景。提高一档 + 各向异性 8 就清楚了。
function createLabel(no) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 280
  const ctx = canvas.getContext('2d')
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  // 尺寸按世界坐标定：0.40×0.219（原来是 0.46×0.251）。
  // 缩小 13% 后，近处的 D1/D2 牌子不会顶到屏幕左侧之外，也不和 1/2 号牌压在一起。
  sprite.scale.set(0.4, 0.219, 1)
  return { canvas, ctx, tex, sprite }
}

// 通用小文字牌（开水机 / 电闸等设施标注）
function makeFacilityTag(text, { w = 0.52, h = 0.24, color = '#cfe6ff', border = '#2a4a66' } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 118
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(8,13,23,0.85)'
  roundRect(ctx, 6, 6, 244, 106, 24)
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = border
  ctx.stroke()
  ctx.fillStyle = color
  ctx.font = '600 54px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 60)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.92 })
  )
  sprite.scale.set(w, h, 1)
  return sprite
}

function perforatedMetalTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 256, 256)
  g.addColorStop(0, '#f4f7fa')
  g.addColorStop(0.45, '#b7c3ce')
  g.addColorStop(1, '#8ea0af')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  ctx.fillStyle = '#1c242e'
  for (let y = 10; y < 256; y += 18) {
    const shift = Math.floor(y / 18) % 2 ? 9 : 0
    for (let x = shift; x < 256; x += 18) {
      ctx.beginPath()
      ctx.arc(x, y, 3.1, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(2, 2)
  return tex
}

const DRUM_MATS = {
  // 不锈钢滚筒：亮银，不再用深灰/黑色桶底
  base: new THREE.MeshStandardMaterial({ color: 0xc5ced6, roughness: 0.28, metalness: 0.92 }),
  lip: new THREE.MeshStandardMaterial({ color: 0xe4ebf1, roughness: 0.18, metalness: 0.95 }),
  x: new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0xef4444,
    emissiveIntensity: 1.3,
    roughness: 0.4
  }),
  cloth: [0xf4f7fb, 0x2f4f86, 0xb4232c, 0x8d97a3, 0xd7c4a1].map(
    (c) =>
      new THREE.MeshStandardMaterial({
        color: c,
        roughness: 0.94,
        metalness: 0,
        side: THREE.DoubleSide
      })
  )
}

// 桶内可视化：空桶（绿）/ 衣物翻滚（黄）/ 故障 X（红）/ 占用时桶内有水面
// 门腔较浅（机身正面 0.31 → 玻璃背面约 0.36），所有内容物都收在这个范围内
function buildDrumInterior(group, facing, doorR, isDryer) {
  const drum = new THREE.Group()
  drum.position.set(facing * 0.3, 0.53, 0) // 桶内容物整体放进凸出的门圈里

  // 桶底（门腔的"后壁"，深色金属圆盘；材质逐机克隆，空闲提亮才互不影响）
  const base = new THREE.Mesh(isDryer ? GEO.drumBaseDryer : GEO.drumBase, DRUM_MATS.base.clone())
  base.rotation.z = Math.PI / 2
  base.position.x = facing * 0.02
  drum.add(base)

  // 内壁高光细环
  const lip = new THREE.Mesh(isDryer ? GEO.drumLipDryer : GEO.drumLip, DRUM_MATS.lip)
  lip.rotation.y = Math.PI / 2
  lip.position.x = facing * 0.026
  drum.add(lip)

  // 后壁和筒壁都贴穿孔不锈钢，三条提衣筋沿筒深方向凸起
  const perf = perforatedMetalTexture()
  base.material.map = perf
  base.material.color.set(0xffffff)
  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(doorR * 0.9, doorR * 0.9, 0.07, 32, 1, true),
    new THREE.MeshStandardMaterial({
      map: perf,
      color: 0xffffff,
      roughness: 0.34,
      metalness: 0.86,
      side: THREE.DoubleSide
    })
  )
  shell.rotation.z = Math.PI / 2
  shell.position.x = facing * 0.01
  drum.add(shell)
  const lifterMat = new THREE.MeshStandardMaterial({ color: 0xd5dee6, roughness: 0.35, metalness: 0.75 })
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4
    const lifter = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.016, 0.03), lifterMat)
    lifter.position.set(facing * 0.012, Math.sin(a) * doorR * 0.78, Math.cos(a) * doorR * 0.78)
    lifter.rotation.x = a
    drum.add(lifter)
  }

  // 衣物堆在筒底、泡在水位线下，不绕着筒壁转
  const clothGroup = new THREE.Group()
  const n = 7
  for (let i = 0; i < n; i++) {
    const c = makeClothPiece(0.062 + (i % 3) * 0.01, DRUM_MATS.cloth[i % DRUM_MATS.cloth.length])
    c.position.set(facing * 0.012, -doorR * 0.46 + (i % 4) * 0.016, -doorR * 0.22 + (i % 5) * doorR * 0.1)
    clothGroup.add(c)
  }
  clothGroup.position.x = facing * 0.005 // 最深处 0.305、最浅处约 0.34，低于内凸玻璃面
  clothGroup.visible = false
  drum.add(clothGroup)

  // 烘干机没有水：跳过水面，只保留衣物翻滚
  let water = null
  let waterGroup = null
  if (!isDryer) {
    // 水面两层表现：① pivot 里向玻璃倾斜的水平水面（斜视可见波动）② 正对玻璃的水位弦面（正视一眼看到"有水"）
    waterGroup = new THREE.Group()
    const waterPivot = new THREE.Group()
    waterPivot.rotation.z = -facing * 0.42 // 靠玻璃一侧下沉
    waterPivot.position.set(facing * 0.028, -doorR * 0.24, 0)
    water = makeWaterSurface()
    water.scale.x = 0.22 // 圆盘已转到水平，x 是桶深方向：0.17*0.22≈±0.037
    waterPivot.add(water)
    waterGroup.add(waterPivot)

    // 水位弦面：竖直贴在桶腔前段，部分衣物"泡"在水里
    const waterFront = new THREE.Mesh(GEO.waterFront, WATER_FRONT_MAT)
    waterFront.rotation.y = (facing * Math.PI) / 2 // ShapeGeometry 面向 ±x（朝玻璃）
    waterFront.position.x = facing * 0.045
    waterGroup.add(waterFront)
    waterGroup.visible = false
    drum.add(waterGroup)
  }

  // 故障 X（共享几何）
  const xMark = new THREE.Group()
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    const bar = new THREE.Mesh(GEO.xBar, DRUM_MATS.x)
    bar.rotation.x = rot
    xMark.add(bar)
  }
  xMark.position.x = facing * 0.045
  xMark.visible = false
  drum.add(xMark)

  group.add(drum)
  return { drumBase: base, clothGroup, water, waterGroup, xMark }
}

function drawLabel(m) {
  const { canvas, ctx, tex } = m.label
  const state = m.data?.state || 'unknown'
  const signature = labelSignature({ no: m.no, ...m.data, state })
  if (m.label.signature === signature) return
  m.label.signature = signature
  const color = cssColor(state)
  // 画布实际是 512×280，但下面的坐标都按 256×140 的设计稿写，
  // 统一缩放到整数倍，避免每个数字都手改
  const k = canvas.width / 256
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(k, 0, 0, k, 0, 0)

  // 底板
  roundRect(ctx, 7, 7, 242, 126, 28)
  ctx.fillStyle = 'rgba(8,13,23,0.88)'
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = color
  ctx.stroke()

  // 大号编号
  ctx.fillStyle = '#e8f0fb'
  ctx.font = '700 74px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(m.no), 128, 58)

  // 状态/剩余时间
  const sub =
    state === 'occupied' && m.data?.leftMin != null ? `${m.data.estimated ? '约 ' : ''}${m.data.leftMin} 分钟` : stateText(state)
  ctx.font = '600 24px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif'
  ctx.fillStyle = color
  ctx.fillText(sub, 128, 112)

  tex.needsUpdate = true
}

// 造一台机器：washer 洗衣机 / dryer 烘干机
function buildMachine(slot) {
  const group = new THREE.Group()
  group.position.set(slot.x, 0, slot.z)
  // 正面朝走道，机身摆正（不倾斜）
  const facing = slot.x > 0 ? -1 : 1
  const isDryer = slot.kind === 'dryer'
  const bodyH = isDryer ? 1.02 : 0.95

  // 机身：烘干机略高、金属感更强、颜色略浅
  const bodyMat = new THREE.MeshStandardMaterial({
    color: isDryer ? 0x3b4757 : 0x27313f,
    roughness: isDryer ? 0.5 : 0.72,
    metalness: isDryer ? 0.38 : 0.18
  })
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, bodyH, 0.66), bodyMat)
  body.position.y = bodyH / 2
  body.castShadow = true
  body.receiveShadow = true
  body.userData.machineNo = slot.no
  clickTargets.push(body)
  group.add(body)

  // 顶盖
  const topMat = new THREE.MeshStandardMaterial({
    color: isDryer ? 0x475464 : 0x35404f,
    roughness: 0.4,
    metalness: 0.35
  })
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.045, 0.7), topMat)
  top.position.y = bodyH + 0.022
  top.castShadow = true
  group.add(top)

  // 烘干机顶部排气格栅（三条细缝）
  if (isDryer) {
    const ventMat = new THREE.MeshStandardMaterial({ color: 0x111821, roughness: 0.8 })
    for (let i = 0; i < 3; i++) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.012, 0.03), ventMat)
      vent.position.set(0, bodyH + 0.048, -0.16 + i * 0.06)
      group.add(vent)
    }
  }

  // 控制面板（正面顶部一条深色）
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x141b25, roughness: 0.5 })
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.12, 0.52), panelMat)
  panel.position.set(facing * 0.315, bodyH - 0.11, 0)
  group.add(panel)

  // 舱门：真实门腔结构 —— 门圈（凸出的门框壳）+ 透明玻璃 + 内部桶底/衣物/水面
  const doorR = isDryer ? 0.23 : 0.205

  // 门圈：从机身正面凸出的短圆筒（不锈钢筒壁，隔着玻璃看到的是银色而不是黑洞）
  const bootMat = new THREE.MeshStandardMaterial({
    color: 0xc5ced6,
    roughness: 0.28,
    metalness: 0.9,
    side: THREE.DoubleSide
  })
  const boot = new THREE.Mesh(
    isDryer ? GEO.bootDryer : GEO.boot,
    bootMat
  )
  boot.rotation.z = Math.PI / 2
  boot.position.set(facing * 0.345, 0.53, 0) // 跨越 0.31(机身正面) → 0.38，轻微凸出即可
  group.add(boot)

  // 舱门：铰链门。门板 = 实心门框盘(bezel) + 微凸舷窗玻璃 + 细状态环 + 把手
  // 铰链统一在"用户看过去"的左侧（右排 -z / 左排 +z），且外移到门圈之外，避免和门体穿模
  const hingeZ = facing * (doorR + 0.07)
  const doorPivot = new THREE.Group()
  doorPivot.position.set(facing * 0.38, 0.53, hingeZ)
  group.add(doorPivot)

  // 铰链柱（固定在门圈侧面，不随门转）
  const hinge = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, doorR * 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a3542, roughness: 0.4, metalness: 0.6 })
  )
  hinge.position.set(facing * 0.345, 0.53, hingeZ)
  group.add(hinge)

  // 实心门框盘（门板主体，深色金属；双面，开门时背面也可见）
  const bezelMat = new THREE.MeshStandardMaterial({
    color: 0x303a47,
    roughness: 0.38,
    metalness: 0.55,
    side: THREE.DoubleSide
  })
  const bezel = new THREE.Mesh(isDryer ? GEO.bezelDryer : GEO.bezel, bezelMat)
  bezel.rotation.y = Math.PI / 2
  bezel.position.set(facing * -0.002, 0, -hingeZ) // 世界 x≈facing*0.378，贴着门圈口
  bezel.userData.machineNo = slot.no
  doorPivot.add(bezel)

  // 舷窗玻璃：微凸穹面（半球冠），顶点朝桶内凸（真实滚筒机舷窗方向），能透出桶内衣物与水面
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x2a3d52,
    transparent: true,
    opacity: 0.32,
    roughness: 0.08,
    metalness: 0.25,
    depthWrite: false
  })
  const domeR = isDryer ? 0.36 : 0.31
  const glass = new THREE.Mesh(isDryer ? GEO.glassDryer : GEO.glass, glassMat)
  glass.rotation.z = (facing * Math.PI) / 2 // 穹面顶点朝桶内（-facing 方向）
  // 球心原点放在机体内，穹缘平面落在世界 x≈facing*0.36，顶点内凸到 ≈facing*0.319
  glass.position.set(facing * (domeR * Math.cos(0.52) - 0.02), 0, -hingeZ)
  doorPivot.add(glass)

  // 状态光环（贴在门框盘外沿，跟随开合）
  const ringMat = new THREE.MeshStandardMaterial({
    color: STATE_HEX.unknown,
    emissive: new THREE.Color(STATE_HEX.unknown),
    emissiveIntensity: 0.9,
    roughness: 0.4,
    metalness: 0.1
  })
  const ring = new THREE.Mesh(isDryer ? GEO.ringDryer : GEO.ring, ringMat)
  ring.rotation.y = Math.PI / 2
  ring.position.set(facing * 0.002, 0, -hingeZ)
  doorPivot.add(ring)

  // 门把手（铰链对侧的小扣手）
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.024, 0.07, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x1d2632, roughness: 0.5, metalness: 0.4 })
  )
  handle.position.set(facing * 0.006, 0, -hingeZ - facing * doorR * 0.95)
  doorPivot.add(handle)

  // 底座垫
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x0d131c, roughness: 0.9 })
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.035, 0.76), baseMat)
  base.position.y = 0.017
  base.receiveShadow = true
  group.add(base)

  // 桶内结构（空桶 / 衣物 / 水面 / 故障 X）
  const drum = buildDrumInterior(group, facing, doorR, isDryer)

  // 顶部状态灯带（任何角度都能看到状态色）
  const stripMat = new THREE.MeshStandardMaterial({
    color: STATE_HEX.unknown,
    emissive: new THREE.Color(STATE_HEX.unknown),
    emissiveIntensity: 1.4,
    roughness: 0.4
  })
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.018, 0.03), stripMat)
  strip.position.set(facing * 0.06, bodyH + 0.052, 0.26)
  group.add(strip)

  // 机器后方配套：洗衣机 = 投放装置+液体盒+水龙头+水管+插座+空开；烘干机 = 只有空开
  buildBackUtility(group, facing, bodyH, isDryer)

  // 编号牌：向走道内侧偏移（facing 指向走道），抬高到机器顶部之上；点它也能选中该机
  // 高度从 bodyH+0.42 降到 +0.36：牌子离机器更近，一眼知道是哪台，也不容易撞到天花线
  const label = createLabel(slot.no)
  label.sprite.position.set(facing * 0.5, bodyH + 0.36, 0)
  label.sprite.userData.machineNo = slot.no
  clickTargets.push(label.sprite)
  group.add(label.sprite)

  // 拾取：只在舱门中心放一个隐形圆盘（手机上防止误触边缘/邻机）
  const hitDisc = new THREE.Mesh(
    isDryer ? GEO.hitDryer : GEO.hit,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
  )
  hitDisc.rotation.y = (facing * Math.PI) / 2
  hitDisc.position.set(facing * 0.42, 0.53, 0)
  hitDisc.userData.machineNo = slot.no
  group.add(hitDisc)
  clickTargets.push(hitDisc)

  // 排队桶组（有几个人排队，就在机器前放几个待洗桶）
  const queueGroup = new THREE.Group()
  group.add(queueGroup)

  scene.add(group)
  const m = {
    no: slot.no,
    slot,
    kind: slot.kind || 'washer',
    slotFacing: facing,
    group,
    ringMat,
    label,
    drumBase: drum.drumBase,
    clothGroup: drum.clothGroup,
    water: drum.water,
    waterGroup: drum.waterGroup,
    doorPivot,
    doorOpenAngle: -1.72, // 空闲时门绕铰链敞开的角度（铰链在左，向走道方向开）
    doorTarget: 0, // 当前动画目标角度（默认关门）
    xMark: drum.xMark,
    stripMat,
    data: null
  }
  machines.push(m)
  drawLabel(m)
  return m
}

// 瓷砖纹理（Canvas 程序化生成：灰缝 + 每片砖轻微色差）
function makeTileTexture({ tiles = 4, base = [126, 134, 146], grout = '#1c222c', vary = 9 } = {}) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  ctx.fillStyle = grout
  ctx.fillRect(0, 0, 256, 256)
  const t = 256 / tiles
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const v = Math.round((Math.random() - 0.5) * 2 * vary)
      ctx.fillStyle = `rgb(${base[0] + v},${base[1] + v},${base[2] + v})`
      ctx.fillRect(i * t + 1.5, j * t + 1.5, t - 3, t - 3)
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// 房间：严格按实际尺寸（x±2.05，z 后墙 -2.1 → 门墙 +4.35），两侧不外延、没有多余空房间
function buildRoom() {
  const roomW = 4.1 // x 方向净宽
  const roomD = 6.52 // z 方向：-2.1 → 4.42
  const roomZ = 1.16 // 中心
  const roomH = 2.6

  // 瓷砖地板（0.5m 砖，土黄色，微反光，与灰色墙面砖区分）
  const floorTex = makeTileTexture({ tiles: 4, base: [172, 150, 110], grout: '#3a3026', vary: 9 })
  floorTex.repeat.set(roomW / 2, roomD / 2) // 每片纹理 4 砖 → 每砖 ≈0.5m
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.32, metalness: 0.06 })
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomD), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, roomZ)
  floor.receiveShadow = true
  scene.add(floor)

  // 瓷砖墙（0.3m 砖，土黄色系）
  const wallTex = makeTileTexture({ tiles: 4, base: [188, 172, 136], grout: '#4a4234', vary: 8 })
  wallTex.repeat.set(roomD / 1.2, roomH / 1.2)
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex,
    roughness: 0.55,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.38, // 左右墙半透明：不彻底挡视线，转到外侧也能看见房间内部
    depthWrite: false
  })

  // 后墙改由 buildWindows 拼装（带四个窗洞，窗外景色才透得进来），这里不再整面封死

  // 左右墙（只覆盖房间进深，不再向外延伸）
  const left = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat)
  left.rotation.y = Math.PI / 2
  left.position.set(-2.05, roomH / 2, roomZ)
  scene.add(left)

  const right = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat)
  right.rotation.y = -Math.PI / 2
  right.position.set(2.05, roomH / 2, roomZ)
  scene.add(right)

  // 天花板（铝扣板：浅暖灰方格，不再是死黑/死灰一片）
  const ceilTex = makeTileTexture({ tiles: 4, base: [74, 78, 86], grout: '#2c313a', vary: 4 })
  ceilTex.repeat.set(roomW / 2.4, roomD / 2.4) // 每块扣板约 0.6m
  const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.85 })
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomD), ceilMat)
  ceil.rotation.x = Math.PI / 2
  ceil.position.set(0, 2.7, roomZ)
  scene.add(ceil)

  // 顶部两组格栅灯盘（暖白灯管 + 深色边框，吊装感）
  const lampFrameMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.4 })
  const lampGlowMat = new THREE.MeshStandardMaterial({
    color: 0xfff4e2,
    emissive: new THREE.Color(0xffeecf),
    emissiveIntensity: 1.9,
    roughness: 1
  })
  for (const x of [-0.85, 0.85]) {
    const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 1.3), lampFrameMat)
    fixture.position.set(x, 2.63, 0.6)
    scene.add(fixture)
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.02, 1.2), lampGlowMat)
    diffuser.position.set(x, 2.595, 0.6)
    scene.add(diffuser)
  }

  // 门口地面提示线（镜头脚下）
  const doorMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.45 })
  const doorLine = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.08), doorMat)
  doorLine.rotation.x = -Math.PI / 2
  doorLine.position.set(0, 0.01, 4.3)
  scene.add(doorLine)
}

// 自然下垂的软管（CatmullRom 曲线 + TubeGeometry）
function makeHose(points, radius = 0.011, color = 0x7c8b9c) {
  const v3 = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
  const curve = new THREE.CatmullRomCurve3(v3, false, 'catmullrom', 0.4)
  const geo = new THREE.TubeGeometry(curve, 40, radius, 8, false)
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  return mesh
}

// 空开（带防水外壳）：灰白塑料盒 + 半透明翻盖，透过盖子能看到里面的白色本体和黑拨杆
function makeBreaker(back, w, y, z) {
  const g = new THREE.Group()
  // 防水外壳（半埋进墙）
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.13, 0.08),
    new THREE.MeshStandardMaterial({ color: 0xc9d2dc, roughness: 0.55, metalness: 0.1 })
  )
  box.position.set(back * (w - 0.045), y, z)
  g.add(box)
  // 内部空开本体 + 拨杆
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, 0.09, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.5 })
  )
  body.position.set(back * (w - 0.05), y, z)
  g.add(body)
  const lever = new THREE.Mesh(
    new THREE.BoxGeometry(0.014, 0.035, 0.016),
    new THREE.MeshStandardMaterial({ color: 0x242e3a, roughness: 0.6 })
  )
  lever.position.set(back * (w - 0.068), y + 0.008, z)
  g.add(lever)
  // 半透明防水翻盖（罩在正面）
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(0.026, 0.115, 0.07),
    new THREE.MeshStandardMaterial({
      color: 0xdde6ef,
      transparent: true,
      opacity: 0.32,
      roughness: 0.15,
      metalness: 0.05,
      depthWrite: false
    })
  )
  lid.position.set(back * (w - 0.08), y, z)
  g.add(lid)
  return g
}

// 五孔防水插座：86 面板（微凸边框）+ 标准五孔布局 + 电源指示灯 + 掀开的半透明防溅翻盖
function makeSocket(back, w, y, z) {
  const g = new THREE.Group()
  // 底盒 + 面板（微凸出墙面）
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.028, 0.108, 0.108),
    new THREE.MeshStandardMaterial({ color: 0xe8edf3, roughness: 0.38, metalness: 0.05 })
  )
  plate.position.set(back * (w - 0.02), y, z)
  g.add(plate)
  // 面板内圈凹槽（细节层次）
  const inset = new THREE.Mesh(
    new THREE.BoxGeometry(0.006, 0.088, 0.088),
    new THREE.MeshStandardMaterial({ color: 0xd3dae2, roughness: 0.5 })
  )
  inset.position.set(back * (w - 0.036), y, z)
  g.add(inset)

  const holeMat = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.85 })
  const hx = back * (w - 0.041)
  // 上两孔：扁长竖孔（国标两极）
  for (const dz of [-0.018, 0.018]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.022, 0.005), holeMat)
    h.position.set(hx, y + 0.024, z + dz)
    g.add(h)
  }
  // 下三孔：中间横地线，两侧斜孔（国标五孔）
  const h0 = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.005, 0.02), holeMat)
  h0.position.set(hx, y - 0.006, z)
  g.add(h0)
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.005), holeMat)
    h.position.set(hx, y - 0.028, z + s * 0.016)
    h.rotation.x = s * 0.55
    g.add(h)
  }
  // 红色电源指示灯
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.004, 6, 6),
    new THREE.MeshStandardMaterial({ color: 0xff5a4a, emissive: 0xff5a4a, emissiveIntensity: 1.4 })
  )
  dot.position.set(hx, y + 0.042, z)
  g.add(dot)

  // 防溅翻盖：上沿铰链，几乎完全掀起，不挡五孔
  const lidPivot = new THREE.Group()
  lidPivot.position.set(back * (w - 0.046), y + 0.054, z)
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(0.008, 0.096, 0.096),
    new THREE.MeshStandardMaterial({
      color: 0xeef3f8,
      transparent: true,
      opacity: 0.55,
      roughness: 0.18,
      depthWrite: false
    })
  )
  lid.position.y = -0.048
  lidPivot.add(lid)
  lidPivot.rotation.z = -1.45 * back
  g.add(lidPivot)
  return g
}

// 机器后方配套（坐标均为相对机器中心，w = 机器中心到墙面距离）：
// 洗衣机：投放装置 + 洗衣液/除菌液 + 水龙头 + 两根水管 + 插座 + 空开
// 烘干机：只有空开（不接水、不用投放洗衣液）
function buildBackUtility(group, facing, bodyH, isDryer) {
  const back = -facing // 指向墙面的方向
  const w = 2.05 - Math.abs(group.position.x) // 机器中心到墙面的距离
  const util = new THREE.Group()

  // 烘干机：空开 + 插座（电源线插在插座上，不接水、不用投放洗衣液）
  if (isDryer) {
    util.add(makeBreaker(back, w, 1.42, 0.14))
    util.add(makeSocket(back, w, 1.44, -0.06))
    util.add(
      makeHose(
        [
          [back * 0.32, bodyH * 0.82, -0.04],
          [back * (w * 0.55), bodyH * 0.7, -0.05],
          [back * (w - 0.14), 1.24, -0.06],
          [back * (w - 0.045), 1.4, -0.06]
        ],
        0.008,
        0x16191f
      )
    )
    group.add(util)
    return util
  }

  // ① 投放装置：黑色长条盒，挂墙
  const dispMat = new THREE.MeshStandardMaterial({
    color: 0x14181f,
    roughness: 0.55,
    metalness: 0.35
  })
  const disp = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.17, 0.38), dispMat)
  disp.position.set(back * (w - 0.1), 1.52, 0) // 抬高到机器顶之上，走道里就能看到
  disp.castShadow = true
  util.add(disp)

  // 投放装置指示灯
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.009, 6, 6),
    new THREE.MeshStandardMaterial({ color: 0x4ade80, emissive: 0x4ade80, emissiveIntensity: 1.5 })
  )
  led.position.set(back * (w - 0.18), 1.55, 0.12)
  util.add(led)

  // ② 两大盒液体：紧贴投放装置正下方，左右并列（沿 Z 方向）
  const dispBottom = 1.52 - 0.085 // 投放装置底面 1.435
  const bottleH = 0.3
  const bottleY = dispBottom - bottleH / 2
  const bottles = [
    { color: 0x3f8fd2, z: -0.078 }, // 洗衣液
    { color: 0x3fae86, z: 0.078 } // 除菌液
  ]
  for (const b of bottles) {
    const mat = new THREE.MeshStandardMaterial({
      color: b.color,
      transparent: true,
      opacity: 0.75,
      roughness: 0.25,
      metalness: 0.08
    })
    const bottle = new THREE.Mesh(new THREE.BoxGeometry(0.15, bottleH, 0.145), mat)
    bottle.position.set(back * (w - 0.1), bottleY, b.z)
    bottle.castShadow = true
    util.add(bottle)

    // 白色瓶盖（顶端紧贴投放装置）
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(0.085, 0.045, 0.085),
      new THREE.MeshStandardMaterial({ color: 0xe8eef5, roughness: 0.5 })
    )
    cap.position.set(back * (w - 0.1), dispBottom - 0.022, b.z)
    util.add(cap)
  }

  // 液体盒下方的金属托架
  const trayMat = new THREE.MeshStandardMaterial({
    color: 0x8b98a6,
    roughness: 0.35,
    metalness: 0.7
  })
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.018, 0.33), trayMat)
  tray.position.set(back * (w - 0.1), bottleY - bottleH / 2 - 0.012, 0)
  util.add(tray)

  // ③ 墙面水龙头：法兰贴墙，鹅颈探进房间，不埋进墙里
  const tap = makeFaucet({ axis: 'x', sign: back > 0 ? 1 : -1 })
  tap.position.set(back * (w - 0.012), 1.34, -0.2)
  util.add(tap)

  // ④ 水管一：水龙头 → 贴墙垂直下落到机器背后 → 干净地拐进进水口
  util.add(
    makeHose(
      [
        [back * (w - 0.04), 1.3, -0.2],
        [back * (w - 0.06), 0.98, -0.2],
        [back * (w - 0.06), 0.68, -0.19],
        [back * 0.5, 0.62, -0.17],
        [back * 0.36, 0.78, -0.15],
        [back * 0.35, 0.9, -0.14]
      ],
      0.012,
      0x7c8b9c
    )
  )

  // ⑤ 水管二：投放装置底部 → 垂直下落到机器顶面后方 → 平直进入顶部
  util.add(
    makeHose(
      [
        [back * (w - 0.12), 1.42, 0.02],
        [back * (w - 0.13), 1.14, 0.02],
        [back * (w - 0.16), 1.0, 0.02],
        [back * 0.42, bodyH + 0.02, 0.02],
        [back * 0.34, bodyH + 0.03, 0.02]
      ],
      0.011,
      0x9aa8b8
    )
  )

  // ⑥ 投放装置旁边：五孔插座 + 空开（并排挂在墙上）
  util.add(makeSocket(back, w, 1.44, 0.34))
  util.add(makeBreaker(back, w, 1.44, 0.46))

  // ⑦ 电源线：机背 → 沿墙垂落 → 插进插座
  util.add(
    makeHose(
      [
        [back * 0.32, bodyH * 0.8, 0.26],
        [back * (w * 0.55), bodyH * 0.68, 0.3],
        [back * (w - 0.14), 1.16, 0.33],
        [back * (w - 0.045), 1.4, 0.34]
      ],
      0.008,
      0x16191f
    )
  )

  group.add(util)
  return util
}

// 窗外景色：整幅 Canvas 画（天空渐变 + 日/月 + 树线剪影 + 草地），按真实时间出白天/落日/夜晚
// 一体画在天空板上：不会侧视穿帮、不会视角一动就突变
function makeWindowViewTexture(hour) {
  const W = 1024
  const H = 480
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')

  const isDay = hour >= 6.5 && hour < 16.5
  const isDusk = (hour >= 16.5 && hour < 19.2) || (hour >= 5 && hour < 6.5)
  const mode = isDay ? 'day' : isDusk ? 'dusk' : 'night'

  const skyTop = { day: '#6fb1e5', dusk: '#3c3f6e', night: '#070f1d' }[mode]
  const skyMid = { day: '#d8ecf7', dusk: '#f2a05c', night: '#16304a' }[mode]
  const grassA = { day: '#7aa85a', dusk: '#4a5c33', night: '#16281a' }[mode]
  const grassB = { day: '#4e7d38', dusk: '#33402a', night: '#0e1c12' }[mode]
  const treeCol = { day: '#2e4a26', dusk: '#25301f', night: '#0a140c' }[mode]
  const horizonY = Math.round(H * 0.62)

  // 天空渐变
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY)
  sky.addColorStop(0, skyTop)
  sky.addColorStop(1, skyMid)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, horizonY)

  // 日/月（带径向光晕）；上午偏左、下午偏右、落日贴树线
  const bodyX = mode === 'night' ? W * 0.72 : hour < 12 ? W * 0.28 : W * 0.72
  const bodyY = mode === 'dusk' ? horizonY - 46 : H * 0.24
  const bodyR = mode === 'night' ? 30 : mode === 'dusk' ? 44 : 34
  const bodyColor = { day: '#fff6d8', dusk: '#ff9448', night: '#eef2fa' }[mode]
  const glow = ctx.createRadialGradient(bodyX, bodyY, bodyR * 0.2, bodyX, bodyY, bodyR * 3.2)
  glow.addColorStop(0, bodyColor + 'cc')
  glow.addColorStop(1, bodyColor + '00')
  ctx.fillStyle = glow
  ctx.fillRect(bodyX - bodyR * 3.2, bodyY - bodyR * 3.2, bodyR * 6.4, bodyR * 6.4)
  ctx.fillStyle = bodyColor
  ctx.beginPath()
  ctx.arc(bodyX, bodyY, bodyR, 0, Math.PI * 2)
  ctx.fill()

  // 夜晚星星
  if (mode === 'night') {
    ctx.fillStyle = '#cfe0f5'
    for (let i = 0; i < 70; i++) {
      const sx = Math.random() * W
      const sy = Math.random() * horizonY * 0.85
      ctx.globalAlpha = 0.35 + Math.random() * 0.6
      ctx.fillRect(sx, sy, 1.6, 1.6)
    }
    ctx.globalAlpha = 1
  }

  // 远处树线剪影（一排大小不一的圆 + 底部连成带）
  ctx.fillStyle = treeCol
  ctx.fillRect(0, horizonY - 14, W, 16)
  let tx = -20
  while (tx < W + 20) {
    const r = 22 + Math.random() * 26
    ctx.beginPath()
    ctx.arc(tx, horizonY - 12, r, Math.PI, 0)
    ctx.fill()
    tx += r * 1.15
  }

  // 草地（近处渐变）
  const grass = ctx.createLinearGradient(0, horizonY, 0, H)
  grass.addColorStop(0, grassA)
  grass.addColorStop(1, grassB)
  ctx.fillStyle = grass
  ctx.fillRect(0, horizonY, W, H - horizonY)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const glassTint = { day: 0x5a87a8, dusk: 0xb26a4a, night: 0x2a4a6e }[mode]
  return { tex, glassTint }
}

// 后墙两扇窗，每扇是「双开窗」：左右两片各自铰链、各自把手，向外推开 45°。
// 黑色窗框（现场是深色铝合金），窗台木色。
function buildWindows() {
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x2b3745,
    roughness: 0.34,
    metalness: 0.72
  })
  // 窗框用黑色：现场是深色铝框，之前的深蓝灰在灯光下偏亮
  const windowFrameMat = new THREE.MeshStandardMaterial({
    color: 0x101418,
    roughness: 0.5,
    metalness: 0.55
  })

  const now = new Date()
  const hour = now.getHours() + now.getMinutes() / 60
  const { tex: viewTex, glassTint } = makeWindowViewTexture(hour)

  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9fc4e0,
    transparent: true,
    opacity: 0.24,
    roughness: 0.08,
    metalness: 0.15,
    emissive: new THREE.Color(glassTint),
    emissiveIntensity: 1.1
  })

  // 窗外景色（整幅画面，宽度收在墙面范围内，避免从墙边缘溢出穿模）
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(4.06, 1.9),
    new THREE.MeshBasicMaterial({ map: viewTex })
  )
  backdrop.position.set(0, 1.5, -2.145)
  scene.add(backdrop)

  const WIN_COUNT = 2 // 后墙两扇窗
  const winW = 1.35 // 每扇窗宽（里面分左右两片对开）
  const winH = 1.3
  const gap = 0.34
  const totalW = winW * WIN_COUNT + gap * (WIN_COUNT - 1)
  const startX = -totalW / 2 + winW / 2

  // 后墙（带两处窗洞，由墙段拼成：窗台以下 + 窗顶以上 + 窗间竖条）
  const wallTexEnd = makeTileTexture({ tiles: 4, base: [188, 172, 136], grout: '#4a4234', vary: 8 })
  wallTexEnd.repeat.set(4.1 / 1.2, 2.6 / 1.2)
  const wallMatEnd = new THREE.MeshStandardMaterial({
    map: wallTexEnd,
    roughness: 0.55,
    side: THREE.DoubleSide
  })
  const winTop = 1.5 + winH / 2 // 2.15
  const winBottom = 1.5 - winH / 2 // 0.85
  const segs = [
    [4.1, winBottom, 0, winBottom / 2], // 窗台以下
    [4.1, 2.6 - winTop, 0, winTop + (2.6 - winTop) / 2] // 窗顶以上
  ]
  // 窗间竖条：左边缘、窗与窗之间、右边缘
  let edge = -2.05
  for (let i = 0; i < WIN_COUNT; i++) {
    const cx = startX + i * (winW + gap)
    const left = cx - winW / 2
    if (left - edge > 0.005) segs.push([left - edge, winH, (edge + left) / 2, 1.5])
    edge = cx + winW / 2
  }
  if (2.05 - edge > 0.005) segs.push([2.05 - edge, winH, (edge + 2.05) / 2, 1.5])
  for (const [w, h, x, y] of segs) {
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMatEnd)
    seg.position.set(x, y, -2.1)
    seg.receiveShadow = true
    scene.add(seg)
  }

  for (let wi = 0; wi < WIN_COUNT; wi++) {
    const cx = startX + wi * (winW + gap)

    // ── 固定外框（黑色铝合金）──
    const outBars = [
      [winW, 0.06, cx, 1.5 + winH / 2],
      [winW, 0.06, cx, 1.5 - winH / 2],
      [0.06, winH, cx - winW / 2 + 0.03, 1.5],
      [0.06, winH, cx + winW / 2 - 0.03, 1.5]
    ]
    for (const [w, h, x, y] of outBars) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), windowFrameMat)
      bar.position.set(x, y, -2.032)
      scene.add(bar)
    }

    // ── 左右两片对开窗扇 ──
    // side = -1 靠左铰链，+1 靠右铰链；两片各自有把手，向外推开 45°
    for (const side of [-1, 1]) {
      const sashW = winW / 2 - 0.03
      const hingeX = side * (winW / 2 - 0.035)

      const sash = new THREE.Group()
      const innerX = -side * (sashW / 2) // 玻璃相对铰链的偏移

      const glass = new THREE.Mesh(new THREE.PlaneGeometry(sashW - 0.04, winH - 0.1), glassMat)
      glass.position.set(innerX, 0, 0)
      sash.add(glass)

      // 窗扇黑框：上下左右四根
      const sashBars = [
        [sashW, 0.035, innerX, (winH - 0.1) / 2],
        [sashW, 0.035, innerX, -(winH - 0.1) / 2],
        [0.035, winH - 0.1, innerX - sashW / 2 + 0.018, 0],
        [0.035, winH - 0.1, innerX + sashW / 2 - 0.018, 0]
      ]
      for (const [w, h, ox, oy] of sashBars) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.024), windowFrameMat)
        b.position.set(ox, oy, 0)
        sash.add(b)
      }

      // 把手：装在自由边（远离铰链那侧），朝房间凸出
      const lockMat = new THREE.MeshStandardMaterial({ color: 0xd5dee8, roughness: 0.22, metalness: 0.9 })
      const handle = new THREE.Group()
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.15, 0.032), lockMat)
      grip.position.z = 0.028
      handle.add(grip)
      const stem = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.028, 0.026), lockMat)
      stem.position.z = 0.006
      handle.add(stem)
      handle.position.set(-side * (sashW - 0.07), 0, 0.018)
      sash.add(handle)

      const idx = wi * 2 + (side < 0 ? 0 : 1)
      glass.userData.windowIdx = idx
      grip.userData.windowIdx = idx
      stem.userData.windowIdx = idx
      clickTargets.push(glass, grip, stem)

      // 铰链在窗洞左右两侧竖轴，向外（-z）推开 45°
      sash.position.set(cx + hingeX, 1.5, -2.058)
      sash.userData.windowIdx = idx
      scene.add(sash)
      windowSashes.push({ group: sash, closedRot: 0, openRot: -side * (Math.PI / 4), targetRot: 0 })
    }
  }

  // 窗台
  const sill = new THREE.Mesh(new THREE.BoxGeometry(totalW + 0.24, 0.06, 0.14), frameMat)
  sill.position.set(0, 1.5 - winH / 2 - 0.06, -1.99)
  scene.add(sill)
}

// 进门侧 D2 边的开水机：黑色机身（约洗衣机 1.5 倍高）+ 顶部 LED 屏 + 刷卡区（接水上方，明显标识）+ 接水区 + 背后进水管 + 电线/空开
function buildWaterBoiler() {
  const g = new THREE.Group()
  // 门墙内表面 z=4.30，机身深 0.38，中心最多到 4.06，再留 4cm 缝
  g.position.set(-1.55, 0, 4.02)

  const blackMat = new THREE.MeshStandardMaterial({
    color: 0x161b22,
    roughness: 0.42,
    metalness: 0.35
  })
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x9fadbd,
    roughness: 0.22,
    metalness: 0.85
  })

  const H = 1.58 // 比洗衣机（0.95m）高一大截
  // 机身（黑色）
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, H, 0.38), blackMat)
  body.position.y = H / 2
  body.castShadow = true
  body.receiveShadow = true
  body.userData.facility = 'boiler'
  clickTargets.push(body)
  g.add(body)

  // 顶盖
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.4), steelMat)
  cap.position.y = H + 0.025
  g.add(cap)

  // 顶部 LED 屏（点阵红字：温度/状态，Canvas 生成）
  const ledCanvas = document.createElement('canvas')
  ledCanvas.width = 256
  ledCanvas.height = 64
  const lctx = ledCanvas.getContext('2d')
  lctx.fillStyle = '#0a0d12'
  lctx.fillRect(0, 0, 256, 64)
  lctx.fillStyle = '#ff4d3d'
  lctx.font = '700 34px "Courier New", monospace'
  lctx.textAlign = 'center'
  lctx.textBaseline = 'middle'
  lctx.fillText('开水 95°C', 128, 34)
  const ledTex = new THREE.CanvasTexture(ledCanvas)
  ledTex.colorSpace = THREE.SRGBColorSpace
  const ledScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.075),
    new THREE.MeshStandardMaterial({
      map: ledTex,
      emissive: new THREE.Color(0xff4d3d),
      emissiveMap: ledTex,
      emissiveIntensity: 0.9,
      roughness: 0.4
    })
  )
  ledScreen.position.set(0.212, 1.42, 0)
  ledScreen.rotation.y = Math.PI / 2
  g.add(ledScreen)

  // 刷卡区（接水区上方）：圆角刷卡机 + 蓝色感应区 + 明显"刷卡"标识牌
  const reader = new THREE.Group()
  const readerBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.16, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x242b34, roughness: 0.4, metalness: 0.3 })
  )
  reader.add(readerBody)
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.012, 20),
    new THREE.MeshStandardMaterial({
      color: 0x1d5fbf,
      emissive: 0x1d5fbf,
      emissiveIntensity: 0.9,
      roughness: 0.3
    })
  )
  pad.rotation.z = Math.PI / 2
  pad.position.x = 0.034
  reader.add(pad)
  // 明显标识：蓝底白字"刷卡"牌
  const signCanvas = document.createElement('canvas')
  signCanvas.width = 128
  signCanvas.height = 64
  const sctx = signCanvas.getContext('2d')
  sctx.fillStyle = '#1d5fbf'
  sctx.fillRect(0, 0, 128, 64)
  sctx.fillStyle = '#ffffff'
  sctx.font = '700 34px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif'
  sctx.textAlign = 'center'
  sctx.textBaseline = 'middle'
  sctx.fillText('刷卡', 64, 34)
  const signTex = new THREE.CanvasTexture(signCanvas)
  signTex.colorSpace = THREE.SRGBColorSpace
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.09, 0.045),
    new THREE.MeshStandardMaterial({
      map: signTex,
      emissive: new THREE.Color(0x1d5fbf),
      emissiveMap: signTex,
      emissiveIntensity: 0.5,
      roughness: 0.5
    })
  )
  sign.rotation.y = Math.PI / 2
  sign.position.set(0.032, 0.115, 0)
  reader.add(sign)
  reader.position.set(0.2, 1.2, 0)
  g.add(reader)

  // 接水区（正常大小：能竖着放进暖水瓶）：正面内凹深槽 + 粗龙头 + 大接水盘
  const recess = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.5, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x0b0f15, roughness: 0.8 })
  )
  recess.position.set(0.2, 0.68, 0)
  g.add(recess)
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 10), steelMat)
  spout.position.set(0.245, 0.88, 0)
  spout.rotation.z = Math.PI / 2.5
  g.add(spout)
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.3), steelMat)
  tray.position.set(0.24, 0.42, 0)
  g.add(tray)
  // 接水盘上的格栅缝
  for (let i = 0; i < 5; i++) {
    const slit = new THREE.Mesh(
      new THREE.BoxGeometry(0.19, 0.006, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x2a323c, roughness: 0.7 })
    )
    slit.position.set(0.24, 0.432, -0.11 + i * 0.055)
    g.add(slit)
  }

  // 绿色运行指示灯
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 1.8 })
  )
  led.position.set(0.212, 1.02, 0.12)
  g.add(led)

  scene.add(g)

  // 背后进水管（从入口墙直接进机背，几乎贴墙）
  scene.add(
    makeHose(
      [
        [-1.2, 1.2, 4.21],
        [-1.2, 1.5, 4.21],
        [-1.2, 1.55, 3.6],
        [-2.02, 1.55, 3.5]
      ],
      0.014,
      0x7c8b9c
    )
  )

  // 电源线 + 空开（装在靠门那面墙：左墙近门口段，避开机体）
  const breaker = makeBreaker(-1, 0.05, 1.55, 0) // 复用防水空开样式，back=-1 → 朝 -x 墙
  breaker.position.set(-1.9, 0, 3.35)
  scene.add(breaker)
  // 电线：空开沿左墙走到机顶，不探出门墙
  scene.add(
    makeHose(
      [
        [-1.9, 1.5, 3.35],
        [-1.9, 1.58, 3.6],
        [-1.7, 1.62, 3.85],
        [-1.55, 1.63, 4.02]
      ],
      0.007,
      0x1a1f26
    )
  )

  const tag = makeFacilityTag('开水机', { w: 0.56, h: 0.26, color: '#dff0ff', border: '#2f5a78' })
  tag.position.set(-1.28, 1.82, 4.02)
  scene.add(tag)
}

// 进门门框 + 木门（向内敞开）+ 20% 透明度的入口墙 + 两侧墙垛（电闸装在右侧墙垛）
function buildDoorway() {
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x3b4a5e,
    roughness: 0.38,
    metalness: 0.5
  })
  const pierTex = makeTileTexture({ tiles: 2, base: [188, 172, 136], grout: '#4a4234', vary: 6 })
  pierTex.repeat.set(0.5, 2.2)
  const pierMat = new THREE.MeshStandardMaterial({ map: pierTex, roughness: 0.55 })

  const doorZ = 4.35

  // 两侧门框立柱
  for (const x of [-0.86, 0.86]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.14), frameMat)
    post.position.set(x, 1.2, doorZ)
    post.castShadow = true
    scene.add(post)
  }
  // 上横梁
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.1, 0.14), frameMat)
  lintel.position.set(0, 2.36, doorZ)
  scene.add(lintel)

  // 木门（向内敞开约 70°，铰链在左侧立柱）：木纹色面板 + 内嵌线条 + 金属把手
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a6849, roughness: 0.62, metalness: 0.05 })
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x6e5238, roughness: 0.7 })
  const doorPivot = new THREE.Group()
  doorPivot.position.set(-0.81, 0, doorZ)
  const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(1.56, 2.26, 0.045), woodMat)
  doorPanel.position.set(0.78, 1.15, 0)
  doorPanel.castShadow = true
  doorPivot.add(doorPanel)
  // 门面内嵌装饰线条（两条横槽）
  for (const y of [0.62, 1.68]) {
    const groove = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 0.012), woodDark)
    groove.position.set(0.78, y, -0.026)
    doorPivot.add(groove)
  }
  // 门把手
  const knob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.09, 10),
    new THREE.MeshStandardMaterial({ color: 0xc9d2dc, roughness: 0.3, metalness: 0.85 })
  )
  knob.rotation.x = Math.PI / 2
  knob.position.set(1.38, 1.05, -0.05)
  doorPivot.add(knob)
  doorPivot.rotation.y = -2.55 // 向外敞开约 146°，贴到门外侧，不挡门口视线
  scene.add(doorPivot)

  // 入口整面墙：带门洞的瓷砖墙，BackSide 单面渲染 —— 从房间内看墙完整存在；
  // 相机在门外（+z 侧）看过来时该面被剔除，完全不挡镜头
  const entryTex = makeTileTexture({ tiles: 4, base: [188, 172, 136], grout: '#4a4234', vary: 8 })
  entryTex.repeat.set(4.1 / 1.2, 2.6 / 1.2)
  const entryWallMat = new THREE.MeshStandardMaterial({
    map: entryTex,
    roughness: 0.55,
    side: THREE.BackSide
  })
  // 门洞：x ±0.86、高 2.36；墙分三段拼（左、右、门楣上）
  const entrySegs = [
    [1.19, 2.6, -1.455, 1.3], // 左段 -2.05..-0.86
    [1.19, 2.6, 1.455, 1.3], // 右段 0.86..2.05
    [1.72, 0.24, 0, 2.48] // 门楣上方 2.36..2.6
  ]
  for (const [w, h, x, y] of entrySegs) {
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(w, h), entryWallMat)
    seg.position.set(x, y, doorZ + 0.09)
    scene.add(seg)
  }

  // 右侧墙垛（与门框同墙，装电闸）
  const pier = new THREE.Mesh(new THREE.BoxGeometry(0.62, 2.6, 0.1), pierMat)
  pier.position.set(1.6, 1.3, doorZ)
  pier.receiveShadow = true
  scene.add(pier)

  // 左侧墙垛（对称，视觉完整）
  const pierL = new THREE.Mesh(new THREE.BoxGeometry(0.62, 2.6, 0.1), pierMat)
  pierL.position.set(-1.6, 1.3, doorZ)
  pierL.receiveShadow = true
  scene.add(pierL)
}

// 门边电闸：防水配电箱样式 —— 半透明翻盖下是一排空开（左红总闸 + 五个分路）
function buildBreakerBox() {
  const g = new THREE.Group()
  g.position.set(1.62, 0, 4.02)

  const boxMat = new THREE.MeshStandardMaterial({ color: 0xc4ced9, roughness: 0.5, metalness: 0.3 })

  // 箱体（横向，一排开关）
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.24, 0.1), boxMat)
  body.position.y = 1.5
  body.castShadow = true
  g.add(body)

  // 一排空开：红色总闸 + 5 个白色分路（各自带黑色拨杆）
  const mcbBody = new THREE.BoxGeometry(0.055, 0.13, 0.05)
  const mcbLever = new THREE.BoxGeometry(0.018, 0.045, 0.02)
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.5 })
  const redMat = new THREE.MeshStandardMaterial({
    color: 0xd63a3a,
    roughness: 0.5,
    emissive: 0x7f1d1d,
    emissiveIntensity: 0.5
  })
  const leverMat = new THREE.MeshStandardMaterial({ color: 0x242e3a, roughness: 0.6 })
  for (let i = 0; i < 6; i++) {
    const x = -0.2 + i * 0.08
    const mcb = new THREE.Mesh(mcbBody, i === 0 ? redMat : whiteMat)
    mcb.position.set(x, 1.5, -0.032)
    g.add(mcb)
    const lever = new THREE.Mesh(mcbLever, leverMat)
    lever.position.set(x, 1.505, -0.062)
    g.add(lever)
  }

  // 半透明防水翻盖（罩住整排，能透出里面的开关）
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(0.54, 0.2, 0.03),
    new THREE.MeshStandardMaterial({
      color: 0xdde6ef,
      transparent: true,
      opacity: 0.3,
      roughness: 0.15,
      depthWrite: false
    })
  )
  lid.position.set(0, 1.5, -0.075)
  g.add(lid)

  scene.add(g)

  // 标注牌（挂在箱体上方，朝房间内）
  const tag = makeFacilityTag('电 闸', { w: 0.42, h: 0.2, color: '#ffd9d9', border: '#7f2b2b' })
  tag.position.set(1.62, 1.72, 3.9)
  scene.add(tag)
}

// 走廊真实感道具：灭火器 / 小心地滑 A 字牌 / 公告栏 / 拖把池+拖把 / 地漏
function buildCorridorProps() {
  // 通用：Canvas 文字面板（公告、警示牌用）
  function textPanel({ w, h, bg, fg, title, lines, titleColor }) {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = Math.round((256 * h) / w)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (title) {
      ctx.fillStyle = titleColor || fg
      ctx.font = '700 34px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(title, canvas.width / 2, 48)
    }
    ctx.fillStyle = fg
    ctx.font = '500 20px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'left'
    lines.forEach((t, i) => ctx.fillText(t, 22, 92 + i * 30))
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    return new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 })
    )
  }

  // 使用须知挂在 4 号（z=1.15）和 5 号（z=0）之间的左墙，朝走道
  const board = new THREE.Group()
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x3a2f22, roughness: 0.6 })
  const cards = [
    {
      title: '洗衣机',
      color: '#8a2f2f',
      lines: ['先登记再启动', '结束及时取衣', '故障点机器留言']
    },
    {
      title: '烘干机',
      color: '#8a4b1f',
      lines: ['脱水后再烘干', '到时及时取出', '滤网保持干净']
    }
  ]
  cards.forEach((card, i) => {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.34), boardMat)
    frame.position.set(0, 0, (i - 0.5) * 0.38)
    board.add(frame)
    const panel = textPanel({
      w: 0.3,
      h: 0.36,
      bg: '#f2ede0',
      fg: '#4a4238',
      title: card.title,
      titleColor: card.color,
      lines: card.lines
    })
    panel.position.set(0.02, 0, (i - 0.5) * 0.38)
    panel.rotation.y = Math.PI / 2
    panel.userData.notice = card.title === '洗衣机' ? 'washer' : 'dryer'
    clickTargets.push(panel)
    board.add(panel)
  })
  board.position.set(-2.0, 1.55, 0.58)
  scene.add(board)

  // ④ 开水机与 D2 之间的空水龙头。左墙是 x=-2.05 的平面，龙头必须探进房间，否则会埋进墙里看不见
  // 彩蛋：点击水龙头可开关水
  const spareTap = makeFaucet({ axis: 'x', sign: 1, clickable: true })
  spareTap.position.set(-1.98, 1.15, 3.15)
  scene.add(spareTap)

  // 水从出水嘴正下方落下。嘴口局部坐标 (0.07, -0.123)，龙头原点 (-1.98, 1.15, 3.15)
  const streamMat = new THREE.MeshStandardMaterial({
    color: 0xb7def6,
    transparent: true,
    opacity: 0.42,
    roughness: 0.05,
    metalness: 0.15,
    depthWrite: false
  })
  const spoutX = -1.91
  const spoutY = 1.027
  const streamLen = spoutY - 0.02
  const stream = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.007, streamLen, 8), streamMat)
  stream.position.set(spoutX, spoutY - streamLen / 2, 3.15)
  stream.visible = false
  scene.add(stream)
  const splash = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12), streamMat.clone())
  splash.rotation.x = -Math.PI / 2
  splash.position.set(spoutX, 0.012, 3.15)
  splash.visible = false
  scene.add(splash)
  faucetStream = { stream, splash }

  // ⑤ 网状垃圾桶（靠门那侧、开水机旁边）：竖杆 + 圆环围成的铁丝网桶 + 黑色垃圾袋内衬
  const binMat = new THREE.MeshStandardMaterial({ color: 0x8a939e, roughness: 0.35, metalness: 0.8 })
  const bin = new THREE.Group()
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.34, 5), binMat)
    rod.position.set(Math.cos(a) * 0.13, 0.17, Math.sin(a) * 0.13)
    bin.add(rod)
  }
  for (const ry of [0.02, 0.17, 0.33]) {
    const ringM = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.006, 6, 20), binMat)
    ringM.rotation.x = Math.PI / 2
    ringM.position.y = ry
    bin.add(ringM)
  }
  const liner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.115, 0.1, 0.3, 14),
    new THREE.MeshStandardMaterial({ color: 0x1c2129, roughness: 0.9 })
  )
  liner.position.y = 0.16
  bin.add(liner)
  // 位置：门边角落，紧挨开水机但留缝（开水机前脸 z≈3.83、x 跨 -1.9~-1.2，
  // 桶半径 0.13，放 -1.02/3.66 时最近距离约 7cm，不会穿模）
  bin.position.set(-1.02, 0, 3.66)
  scene.add(bin)

  // ⑥ 门口对面：白墙走廊 + 尽头一扇木门（纯贴图，带阴影；从房间内看门口不再是黑洞）
  const hallCanvas = document.createElement('canvas')
  hallCanvas.width = 256
  hallCanvas.height = 336
  const hctx = hallCanvas.getContext('2d')
  // 白墙（微渐变，上亮下暗）
  const wallGrad = hctx.createLinearGradient(0, 0, 0, 336)
  wallGrad.addColorStop(0, '#e8e6e0')
  wallGrad.addColorStop(1, '#c9c6bd')
  hctx.fillStyle = wallGrad
  hctx.fillRect(0, 0, 256, 336)
  // 地面
  hctx.fillStyle = '#a8a49a'
  hctx.fillRect(0, 296, 256, 40)
  // 门的落影（地面 + 左侧墙影）
  hctx.fillStyle = 'rgba(60,55,48,0.35)'
  hctx.fillRect(76, 292, 106, 10)
  hctx.fillStyle = 'rgba(60,55,48,0.22)'
  hctx.fillRect(78, 66, 10, 230)
  // 木门（上亮下暗 + 门芯内凹阴影）
  const doorGrad = hctx.createLinearGradient(88, 60, 88, 296)
  doorGrad.addColorStop(0, '#8a6c4a')
  doorGrad.addColorStop(1, '#6e5439')
  hctx.fillStyle = doorGrad
  hctx.fillRect(88, 60, 80, 236)
  // 门框
  hctx.strokeStyle = '#54402a'
  hctx.lineWidth = 5
  hctx.strokeRect(88, 60, 80, 236)
  // 门芯板（内凹：左上深线、右下浅线）
  for (const [rx, ry, rw, rh] of [
    [98, 76, 60, 96],
    [98, 186, 60, 92]
  ]) {
    hctx.strokeStyle = 'rgba(40,28,16,0.55)'
    hctx.lineWidth = 3
    hctx.strokeRect(rx, ry, rw, rh)
    hctx.strokeStyle = 'rgba(255,240,220,0.25)'
    hctx.lineWidth = 1.5
    hctx.strokeRect(rx + 2.5, ry + 2.5, rw, rh)
  }
  // 门把手（带一点高光）
  hctx.fillStyle = '#3a332a'
  hctx.beginPath()
  hctx.arc(159, 188, 6, 0, Math.PI * 2)
  hctx.fill()
  hctx.fillStyle = '#d8dee5'
  hctx.beginPath()
  hctx.arc(157.5, 186.5, 4, 0, Math.PI * 2)
  hctx.fill()
  const hallTex = new THREE.CanvasTexture(hallCanvas)
  hallTex.colorSpace = THREE.SRGBColorSpace
  const hallDoor = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 2.5),
    new THREE.MeshStandardMaterial({ map: hallTex, roughness: 0.9 })
  )
  hallDoor.position.set(0, 1.25, 5.05)
  hallDoor.rotation.y = Math.PI // 朝房间内
  scene.add(hallDoor)

  // 拖把靠在里侧左墙，不再放没有用途的水桶和水龙头
  // 拖把：细杆 + 布条头，斜靠墙
  const mopStick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 1.25, 6),
    new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 0.7 })
  )
  mopStick.position.set(-1.88, 0.62, -1.35)
  mopStick.rotation.z = 0.18
  scene.add(mopStick)
  const mopHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xcfd6dd, roughness: 0.95 })
  )
  mopHead.scale.set(1, 0.55, 1)
  mopHead.position.set(-1.78, 0.035, -1.35)
  scene.add(mopHead)

  // ⑤ 地漏 ×2（靠里侧墙根，贴着机器排的墙边）
  const drainMat = new THREE.MeshStandardMaterial({ color: 0x2b323c, roughness: 0.4, metalness: 0.6 })
  const drainRingMat = new THREE.MeshStandardMaterial({ color: 0x171d25, roughness: 0.6 })
  for (const [dx, dz] of [
    [1.84, 0.55],
    [-1.84, -0.75],
    [-1.86, 3.15] // 空水龙头正下方（水流落点）
  ]) {
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.065, 20), drainMat)
    d.rotation.x = -Math.PI / 2
    d.position.set(dx, 0.006, dz)
    scene.add(d)
    const dr = new THREE.Mesh(new THREE.RingGeometry(0.038, 0.052, 20), drainRingMat)
    dr.rotation.x = -Math.PI / 2
    dr.position.set(dx, 0.008, dz)
    scene.add(dr)
  }

  // ⑥ 铁网储物架（电闸下方角落，进门右手墙垛下）：三层金属网架 + 摆了几双鞋
  const rack = new THREE.Group()
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x707a86, roughness: 0.35, metalness: 0.8 })
  // 四根立柱
  for (const [px, pz] of [
    [-0.26, -0.16],
    [0.26, -0.16],
    [-0.26, 0.16],
    [0.26, 0.16]
  ]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.78, 6), wireMat)
    post.position.set(px, 0.39, pz)
    rack.add(post)
  }
  // 三层网板（横竖细杆交叠出"铁网"感）
  for (const sy of [0.1, 0.4, 0.7]) {
    for (let i = 0; i < 6; i++) {
      const rodX = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.008, 0.008), wireMat)
      rodX.position.set(0, sy, -0.16 + i * 0.064)
      rack.add(rodX)
      const rodZ = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, 0.34), wireMat)
      rodZ.position.set(-0.26 + i * 0.104, sy, 0)
      rack.add(rodZ)
    }
  }
  // 鞋子（两双+一只拖鞋：小盒鞋身 + 略尖鞋头）
  const shoeColors = [0x3a4a5c, 0x6b4a3a, 0x4a4a4a]
  const shoeSpots = [
    [-0.12, 0.115, -0.05, 0],
    [0.1, 0.115, -0.04, 0],
    [-0.08, 0.415, 0.02, 1],
    [0.14, 0.415, 0.03, 2],
    [0.0, 0.715, -0.02, 0]
  ]
  for (const [sx, sy, sz, ci] of shoeSpots) {
    const shoe = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.045, 0.19),
      new THREE.MeshStandardMaterial({ color: shoeColors[ci], roughness: 0.75 })
    )
    shoe.add(body)
    const toe = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 6),
      new THREE.MeshStandardMaterial({ color: shoeColors[ci], roughness: 0.75 })
    )
    toe.scale.set(0.83, 0.55, 0.9)
    toe.position.set(0, -0.008, 0.1)
    shoe.add(toe)
    shoe.position.set(sx, sy, sz)
    shoe.rotation.y = (ci - 1) * 0.16
    rack.add(shoe)
  }
  rack.position.set(1.62, 0, 3.72) // 门墙以内，不顶到门垛
  scene.add(rack)
}


// 默认机位：按屏幕比例给两套，核心是「像人站在门口往里看」。
//
// 之前竖屏用的机位是 y=2.34 —— 比门楣（2.36）还高，观感像贴在天花板上俯视，
// 地板占了近半个屏幕，近处的 D1/D2 又被两侧裁掉。
// 现在压到站立视高（1.72）并把视线压低一点：天花板只留顶部一条，
// 走道和两排机器成为画面主体；视场角 72° —— 再窄装不下两排，再宽边缘畸变会回来。
const CAM_PORTRAIT = { pos: [0, 1.72, 4.3], target: [0, 0.74, -1.3], fov: 72 }
const CAM_LANDSCAPE = { pos: [0, 1.9, 4.2], target: [0, 0.8, -0.8], fov: 58 }

function defaultCam() {
  const aspect = camera?.aspect || window.innerWidth / Math.max(window.innerHeight, 1)
  return aspect < 0.85 ? CAM_PORTRAIT : CAM_LANDSCAPE
}

// 缩放/俯仰边界：房间只有 3×7 米，松了会穿墙钻进机器里
const ZOOM_MIN = 1.9
const ZOOM_MAX = 6.2
function applyCameraLimits() {
  if (!controls) return
  controls.minDistance = ZOOM_MIN
  controls.maxDistance = ZOOM_MAX
  controls.minPolarAngle = Math.PI * 0.16
  controls.maxPolarAngle = Math.PI * 0.49
}

function fitCamera() {
  if (!camera) return
  const cam = defaultCam()
  camera.fov = cam.fov
  camera.updateProjectionMatrix()
}

function initThree() {
  const el = stageRef.value
  if (!el) return
  const w = el.clientWidth
  const h = el.clientHeight

  // preserveDrawingBuffer 会让每帧多一次缓冲拷贝，移动端实测明显掉帧。
  // 只有我截图（无头浏览器需读像素）时才需要，所以用 ?shot=1 单独打开。
  const needShot = /[?&]shot=1/.test(location.href)

  let tier = initialQuality()

  const created = createCompatibleRenderer(THREE.WebGLRenderer, {
    // 高 DPR 下 4x MSAA 几乎看不出来，却实打实多一次全屏 resolve
    antialias: tier !== 'low',
    alpha: false,
    preserveDrawingBuffer: needShot,
    powerPreference: 'high-performance',
    quality: tier,
  })
  renderer = created.renderer
  tier = created.quality
  conservativeRenderer = created.conservative
  qualityTier = tier
  renderer.setSize(w, h)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // 静态场景：阴影只算一次（动态元素均不投影）
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.needsUpdate = true
  // 电影级色调映射
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.domElement.style.display = 'block'
  el.appendChild(renderer.domElement)
  // DPR 上限 / 阴影开关统一由档位决定（自适应调档也走这里）
  applyQuality(tier)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a1119)
  scene.fog = new THREE.FogExp2(0x0a1119, 0.022)

  // PBR 环境反射：让金属/玻璃/水面有质感（"高级感"主要来源）
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = new RoomEnvironment()
  try {
    environmentTarget = pmrem.fromScene(environment, 0.04)
    scene.environment = environmentTarget.texture
  } finally {
    environment.dispose()
    pmrem.dispose()
  }

  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 60)
  // 站在门洞内侧看走道：门框立柱（z=4.35）落在身后，两排机器正面都在视野里
  const cam0 = defaultCam()
  camera.position.set(...cam0.pos)
  fitCamera()

  controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(...cam0.target)
  controls.enableDamping = !reducedMotion
  controls.dampingFactor = 0.08
  controls.enablePan = false
  applyCameraLimits()
  controls.addEventListener('start', onControlsStart)
  controls.addEventListener('end', onControlsEnd)
  // 允许转到背后回看门口（门框 / 电闸）
  controls.minAzimuthAngle = -Math.PI
  controls.maxAzimuthAngle = Math.PI

  // 展示用：?view=back 从房间内部回看门口墙（门框 + 电闸）
  // 注意相机要在后墙（z=-2.1）以内，否则窗框会糊满镜头
  if (route.query.view === 'back') {
    controls.minDistance = 0.3
    controls.maxPolarAngle = Math.PI * 0.95
    controls.minPolarAngle = 0.05
    controls.enableDamping = false
    camera.position.set(0, 2.0, -1.55)
    controls.target.set(0, 1.0, 4.0)
    controls.update()
  }
  // 回归用：?view=door 贴近 4 号机（占用中）舱门，检查桶内衣物/水面是否穿模
  if (route.query.view === 'door') {
    controls.minDistance = 0.3
    controls.maxPolarAngle = Math.PI * 0.95
    controls.minPolarAngle = 0.05
    controls.enableDamping = false
    camera.position.set(-0.42, 0.68, 1.15)
    controls.target.set(-0.98, 0.52, 1.15)
    controls.update()
  }
  // 回归用：?view=wall 从走道斜看右墙（投放装置 / 液体盒 / 水龙头 / 水管）
  if (route.query.view === 'wall') {
    controls.minDistance = 0.3
    controls.maxPolarAngle = Math.PI * 0.95
    controls.minPolarAngle = 0.05
    controls.enableDamping = false
    camera.position.set(-0.7, 1.5, 1.9)
    controls.target.set(1.9, 1.15, 0.4)
    controls.update()
  }

  // 光照
  // 光照：暖白为主（约 3800K 感），补光留一点冷色做层次
  scene.add(new THREE.HemisphereLight(0xf2ede2, 0x0a1119, 0.85))
  const key = new THREE.DirectionalLight(0xfff6e8, 1.5)
  key.position.set(2.5, 5.2, 3.5)
  key.castShadow = true
  key.shadow.mapSize.set(tier === 'low' ? 512 : 1024, tier === 'low' ? 512 : 1024)
  key.shadow.normalBias = 0.025
  key.shadow.bias = -0.0001
  key.shadow.camera.near = 1
  key.shadow.camera.far = 16
  key.shadow.camera.left = -3.5
  key.shadow.camera.right = 3.5
  key.shadow.camera.top = 4
  key.shadow.camera.bottom = -4
  scene.add(key)

  const fill = new THREE.DirectionalLight(0x9fc3ff, 0.5)
  fill.position.set(-3, 3, -2)
  scene.add(fill)

  buildRoom()
  buildWindows()
  buildWaterBoiler()
  buildDoorway()
  buildBreakerBox()
  buildCorridorProps()
  for (const slot of SLOTS) buildMachine(slot)
  mergeStaticEnvironment(scene, [...clickTargets, ...windowSashes.map((sash) => sash.group), ...machines.map((machine) => machine.group), faucetStream?.stream, faucetStream?.splash])

  // 灯管下方的点光源，制造顶灯光斑（暖白）
  for (const x of [-0.85, 0.85]) {
    const pl = new THREE.PointLight(0xffe4bd, 14, 7, 2)
    pl.position.set(x, 2.32, 1.3)
    scene.add(pl)
  }

  timer = new THREE.Timer()
  timer.connect(document)
  animate()

  // 交互
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointercancel', onPointerCancel)
  renderer.domElement.addEventListener('lostpointercapture', onPointerCancel)
  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)

  resizeHandler = () => {
    if (!renderer || !camera) return
    const nw = el.clientWidth
    const nh = el.clientHeight
    if (!nw || !nh) return
    renderer.setSize(nw, nh)
    camera.aspect = nw / nh
    fitCamera()
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', resizeHandler)
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(resizeHandler)
    resizeObserver.observe(el)
  }

  // 页面不可见时暂停渲染（省电省性能）
  visHandler = () => {
    pointerGesture.cancel()
    interacting = false
    performanceWindow = { at: 0, frames: 0, sent: performanceWindow.sent }
    if (document.visibilityState === 'visible' && !contextFailed) {
      syncData().catch(() => {})
      lastRafTs = 0
      rafAccMs = 0
      timer?.reset()
      prevT = timer?.getElapsed() || 0
      if (!rafId) animate()
    } else if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }
  document.addEventListener('visibilitychange', visHandler)
}

let cameraGoal = null // { pos, target } 相机飞行目标（点选机器/公告时启用）

// ── 画质档位 ──
// 画质控制分辨率和阴影，帧率由交互、动画和减少动态偏好共同决定。
const QUALITY = {
  low: { dprCap: 1.15, shadow: false },
  mid: { dprCap: 1.45, shadow: true },
  high: { dprCap: 1.75, shadow: true },
}
let qualityTier = 'mid'

function initialQuality() {
  if (conservativeRenderer && qualityPreference.value === 'auto') return 'low'
  return chooseInitialQuality({
    preference: qualityPreference.value,
    deviceMemory: Number(navigator.deviceMemory) || 0,
    hardwareConcurrency: Number(navigator.hardwareConcurrency) || 0,
    devicePixelRatio: window.devicePixelRatio || 1,
    reducedMotion,
  })
}

function changeQuality() {
  qualityPreference.value = normalizeQualityPreference(qualityPreference.value)
  try { localStorage.setItem('ws_room_quality', qualityPreference.value) } catch { /* 私密模式仍可即时切换 */ }
  applyQuality(initialQuality())
  qBad = qGood = 0
  qWin = { t: 0, n: 0, cost: 0 }
  roomTrack('room_interaction', { action: 'quality' })
}

function onMotionChange(event) {
  reducedMotion = event.matches
  if (controls) controls.enableDamping = !reducedMotion
  if (qualityPreference.value === 'auto') applyQuality(initialQuality())
}
motionQuery.addEventListener('change', onMotionChange)

function onControlsStart() { interacting = true; cameraGoal = null; lastInteractionAt = performance.now() }
function onControlsEnd() { interacting = false; lastInteractionAt = performance.now() }

function onContextLost(event) {
  event.preventDefault()
  failScene('context_lost')
}

function failScene(reason) {
  contextFailed = true
  cancelAnimationFrame(rafId)
  rafId = 0
  stopPoll()
  loading.value = false
  error.value = '当前环境暂时无法显示3D，可重试或使用2D看板'
  signalRoomFailure(stageRef.value, reason)
}

function onContextRestored() {
  if (disposed) return
  contextFailed = false
  releaseThree()
  bootstrap()
}

function applyQuality(tier) {
  qualityTier = tier
  activeQuality.value = tier
  const q = QUALITY[tier] || QUALITY.mid
  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dprCap))
    renderer.shadowMap.enabled = q.shadow
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.shadowMap.needsUpdate = true
  }
}

// ?perf=1：右上角实时显示帧率 / 单帧渲染耗时 / draw calls / 档位
const perfEl = /[?&]perf=1/.test(location.href)
  ? (() => {
      const d = document.createElement('div')
      d.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:9999;font:11px/1.5 ui-monospace,monospace;' +
        'color:#9fd7ff;background:rgba(0,0,0,.62);padding:4px 8px;border-radius:6px;pointer-events:none'
      document.body.appendChild(d)
      return d
    })()
  : null

// ── 自适应画质 ──
//
// 关键：**用「单帧渲染耗时」判断，而不是「帧率」**。
// 我们自己限了帧（空闲 30fps），按帧率判断的话永远达不到高分阈值，
// 结果就是所有人几秒内被打到 low（上一版就踩了这个坑）。
// 渲染耗时和限帧无关：一帧画 20ms 说明 30fps 都吃力，一帧画 3ms 说明还有富余。
//
// 用真实墙钟（performance.now）而不是 rAF 的 ts，避免掉帧时时间戳跳跃干扰统计。
let qWin = { t: 0, n: 0, cost: 0 }
let qBad = 0
let qGood = 0

function tuneQuality(renderCost) {
  if (qualityPreference.value !== 'auto' || reducedMotion || conservativeRenderer) return
  const now = performance.now()
  if (!qWin.t) {
    qWin.t = now
    qWin.n = 1
    qWin.cost = renderCost
    return
  }
  qWin.n++
  qWin.cost += renderCost
  const span = now - qWin.t
  if (span < 1500) return // 1.5 秒一个观察窗口

  const avgCost = qWin.cost / qWin.n
  const fps = (qWin.n * 1000) / span
  qWin = { t: now, n: 0, cost: 0 }
  // 帧成本决定 busy 时能开多快（5ms 就别限帧了，限了反而抖）
  setBusyTarget(avgCost)

  // 一帧超过 16ms 就别想稳住 30fps 了，往下走
  const canHold = avgCost <= 16
  // 一帧 5ms 以内、且确实跑满了限帧上限，说明还有余量，可以往上试
  const hasHeadroom = avgCost <= 5 && fps >= (qualityTier === 'low' ? 12 : 18)

  if (!canHold) {
    qGood = 0
    if (++qBad < 2) return // 连续两个窗口都不行才降，避开打开页面时的抖动
    qBad = 0
    if (qualityTier === 'high') {
      applyQuality('mid')
    } else if (qualityTier === 'mid') {
      applyQuality('low')

    }
    return
  }

  qBad = 0
  if (!hasHeadroom || qualityTier === 'high') {
    qGood = 0
    return
  }
  // 升级要更保守：连续四个窗口有余量才抬一档
  if (++qGood < 4) return
  qGood = 0
  if (qualityTier === 'low') {
    applyQuality('mid')

  } else if (qualityTier === 'mid') {
    applyQuality('high')
  }
}

// ── 帧节奏 ──
// 不能用「距上一帧 < 33ms 就跳过」这种写法：屏幕 60Hz 时帧间隔 16.7ms，
// 33ms 的阈值会让实际渲染落在第 3 帧（50ms）→ 真实只有 20fps 且节奏忽快忽慢，
// 看起来就是「明明不卡但一顿一顿」。
// 改成累加时间片：攒够一个周期才画一帧，画完把余量保留，节奏是均匀的。
let rafAccMs = 0
let lastRafTs = 0
// busy 时的目标间隔：0 = 不额外限帧（跟着屏幕刷新走，最顺）
let busyMinMs = 0

function setBusyTarget(avgCost) {
  // 单帧 10ms 以内完全撑得住 60fps，就不用限
  if (avgCost <= 10) busyMinMs = 0
  else if (avgCost <= 14) busyMinMs = 16.7
  else busyMinMs = 20
}

function animate(ts) {
  if (disposed || contextFailed || document.visibilityState === 'hidden') { rafId = 0; return }
  rafId = requestAnimationFrame(animate)
  const busy = Boolean(cameraGoal) || interacting || pointerGesture.active || performance.now() - lastInteractionAt < 450
  const animated = faucetOn || machines.some((machine) => machine.clothGroup?.visible ||
    (machine.doorPivot && Math.abs(machine.doorPivot.rotation.y - machine.doorTarget) > 0.002)) ||
    windowSashes.some((sash) => Math.abs(sash.group.rotation.y - sash.targetRot) > 0.004)
  const interval = Math.max(busy ? busyMinMs : 0, renderInterval({ busy, animated, reducedMotion, quality: qualityTier }))

  if (ts !== undefined) {
    if (lastRafTs) rafAccMs += Math.max(0, ts - lastRafTs)
    lastRafTs = ts
  }
  if (interval > 0 && rafAccMs + 0.5 < interval) return
  // 只扣掉一个周期，积压最多留一个周期：落后时不要「连追几帧」，那样更抖
  rafAccMs = interval > 0 ? Math.max(0, Math.min(rafAccMs - interval, interval)) : 0

  timer?.update(ts)
  const t = timer?.getElapsed() || 0
  const dt = Math.min(0.06, Math.max(0.001, t - prevT))
  prevT = t

  // 相机飞行：点选机器/公告后平滑对准；用户一拖动就立即交还控制权
  if (cameraGoal && camera && controls) {
    const k = Math.min(1, dt * 3.2)
    camera.position.lerp(cameraGoal.pos, k)
    controls.target.lerp(cameraGoal.target, k)
    if (camera.position.distanceTo(cameraGoal.pos) < 0.02) cameraGoal = null
  }

  // 悬浮面板跟随：锚在机器朝走道一侧，夹在画面边缘，避免盖住舱门
  if (isWide.value && (selected.value || facility.value) && camera) {
    const m = selected.value ? machines.find((x) => x.no === selected.value.no) : null
    const el = stageRef.value
    if (el && (m || facility.value)) {
      const anchor = m
        ? panelAnchor.set(
            m.group.position.x + m.slotFacing * 0.85,
            m.kind === 'dryer' ? 1.35 : 1.15,
            m.group.position.z
          )
        : panelAnchor.set(-1.35, 1.2, 4.02)
      anchor.project(camera)
      const w = el.clientWidth
      const h = el.clientHeight
      const half = Math.min(w * 0.42, 160)
      const x = Math.min(Math.max(((anchor.x + 1) / 2) * w, half + 8), w - half - 8)
      const halfHeight = Math.min((panelRef.value?.offsetHeight || 320) / 2, h / 2 - 10)
      const y = el.offsetTop + Math.min(Math.max(((-anchor.y + 1) / 2) * h, halfHeight + 10), h - halfHeight - 10)
      if (Math.abs(panelPos.value.x - x) > 1 || Math.abs(panelPos.value.y - y) > 1) panelPos.value = { x, y }
    }
  }

  // 状态环轻微呼吸，空闲机更明显（提醒"这台能用"）
  flicker = reducedMotion || !animated ? 0.9 : 0.75 + Math.sin(t * 2.2) * 0.18

  // 窗扇平开动画（点把手开窗/关窗，绕左右两侧竖轴向外转）
  for (const s of windowSashes) {
    const cur = s.group.rotation.y
    const diff = s.targetRot - cur
    if (Math.abs(diff) > 0.004) s.group.rotation.y = reducedMotion ? s.targetRot : cur + diff * Math.min(1, dt * 5)
  }
  // 水流轻微摆动 + 落点水花闪动
  if (faucetStream && faucetOn) {
    faucetStream.stream.scale.x = 1 + Math.sin(t * 30) * 0.08
    faucetStream.splash.material.opacity = 0.4 + Math.sin(t * 24) * 0.15
  }
  for (const m of machines) {
    const state = m.data?.state
    const isIdle = state === 'idle'
    m.ringMat.emissiveIntensity = isIdle ? flicker + 0.35 : 0.85

    // 舱门开合动画：朝目标角度缓动
    if (m.doorPivot && m.doorTarget !== undefined) {
      const cur = m.doorPivot.rotation.y
      const diff = m.doorTarget - cur
      if (Math.abs(diff) > 0.002) m.doorPivot.rotation.y = reducedMotion ? m.doorTarget : cur + diff * Math.min(1, dt * 4.5)
    }
    // 有衣物在翻滚：绕筒轴缓慢转动（真实滚筒约 50rpm 以下，视觉上宁慢勿快）
    if (!reducedMotion && m.clothGroup?.visible) {
      const seed = typeof m.no === 'number' ? m.no : m.no === 'D1' ? 2.3 : 3.1
      m.clothGroup.rotation.x += dt * (0.85 + (seed % 3) * 0.18)
      // 每件衣物再带一点自转，像被筒壁带起又翻落
      for (let i = 0; i < m.clothGroup.children.length; i++) {
        m.clothGroup.children[i].rotation.y += dt * (0.4 + i * 0.13)
      }
    }
    // 桶内水面波动
    if (!reducedMotion && qualityTier !== 'low' && m.waterGroup?.visible && m.water) {
      const phase = typeof m.no === 'number' ? m.no * 0.6 : 0.3
      animateWater(m.water, t + phase)
    }
    // 故障 X 轻微脉动
    if (!reducedMotion && m.xMark?.visible) {
      const k = 0.75 + Math.sin(t * 4) * 0.35
      m.xMark.children.forEach((bar) => {
        if (bar.material) bar.material.emissiveIntensity = k
      })
    }
  }
  controls?.update()
  // 量一帧到底画了多久：自适应画质靠这个判断，不靠帧率（我们自己限了帧）
  let renderCost = 0
  if (renderer && scene && camera) {
    const r0 = performance.now()
    try { renderer.render(scene, camera) } catch { failScene('render_failed'); return }
    renderCost = performance.now() - r0
  }
  if (renderCost && (busy || animated)) tuneQuality(renderCost)
  samplePerformance()

  // ?perf=1 时右上角显示帧率 / 单帧耗时 / 绘制调用数，方便现场判断卡在哪
  if (perfEl && ts) {
    if (!perfEl._t0) {
      perfEl._t0 = ts
      perfEl._n = 0
      perfEl._cost = 0
    }
    perfEl._n++
    perfEl._cost += renderCost
    if (ts - perfEl._t0 >= 500) {
      const fps = Math.round((perfEl._n * 1000) / (ts - perfEl._t0))
      const avg = (perfEl._cost / perfEl._n).toFixed(1)
      const info = renderer ? renderer.info.render : null
      const tgt = busyMinMs === 0 ? '不限' : `${Math.round(1000 / busyMinMs)}`
      perfEl.textContent =
        `${fps}fps · ${avg}ms/帧 · ${info ? info.calls : '-'}calls · ` +
        `${info ? Math.round(info.triangles / 1000) : '-'}k tris · ${qualityTier} · 目标${tgt}`
      perfEl._t0 = ts
      perfEl._n = 0
      perfEl._cost = 0
    }
  }
}

function onPointerDown(e) {
  pointerGesture.down(e)
  lastInteractionAt = performance.now()
  stageRef.value?.focus({ preventScroll: true })
  cameraGoal = null // 用户一拖动就中断相机飞行
}

function onPointerMove(event) { pointerGesture.move(event) }
function onPointerCancel(event) { pointerGesture.cancel(event.pointerId); interacting = false }

function onPointerUp(e) {
  if (!pointerGesture.up(e) || !renderer || !camera) return
  lastInteractionAt = performance.now()

  const rect = renderer.domElement.getBoundingClientRect()
  pointerNdc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  )
  pointerRay.setFromCamera(pointerNdc, camera)
  pointerHits.length = 0
  const hits = pointerRay.intersectObjects(clickTargets, false, pointerHits)
  if (!hits.length) {
    clearSelection() // 点空处收起面板
    return
  }
  const hit = hits[0].object

  // 窗户：点月牙锁推开/关合窗扇
  if (hit.userData.windowIdx !== undefined) {
    const s = windowSashes[hit.userData.windowIdx]
    if (s) s.targetRot = Math.abs(s.targetRot - s.closedRot) < 0.01 ? s.openRot : s.closedRot
    return
  }

  // 空水龙头：点击开关水
  if (hit.userData.faucet) {
    faucetOn = !faucetOn
    if (faucetStream) {
      faucetStream.stream.visible = faucetOn
      faucetStream.splash.visible = faucetOn
    }
    showToast(faucetOn ? '水龙头开了' : '水龙头关了')
    return
  }

  // 开水机：点出说明卡片 + 相机对准
  if (hit.userData.facility === 'boiler') {
    selected.value = null
    facility.value = 'boiler'
    cameraGoal = {
      pos: new THREE.Vector3(-0.55, 1.35, 3.15),
      target: new THREE.Vector3(-1.2, 0.9, 4.02)
    }
    return
  }

  // 使用须知：相机对准 4 号和 5 号中间那两块牌子
  if (hit.userData.notice) {
    facility.value = null
    cameraGoal = {
      pos: new THREE.Vector3(-0.85, 1.5, 0.58),
      target: new THREE.Vector3(-2.0, 1.55, 0.58)
    }
    return
  }

  // 机器：选中 + 相机飞到正对它舱门的视角
  const no = hit.userData.machineNo
  const m = machines.find((x) => x.no === no)
  if (!m?.data) return
  focusMachine(m)
}

// 选中某台机器并飞相机（?focus=N 可直接触发，回归截图用）
function focusMachine(m) {
  roomTrack('room_interaction', { action: 'select', kind: m.kind || 'washer' })
  facility.value = null
  selected.value = { no: m.no, kind: m.kind || 'washer', ...m.data }
  // 换机器就重置登记方式：有剩余时间默认「跟着机器」
  resetRegisterMode()
  const facing = m.slotFacing
  cameraGoal = {
    pos: new THREE.Vector3(m.group.position.x + facing * 1.55, 0.95, m.group.position.z + 0.12),
    target: new THREE.Vector3(m.group.position.x + facing * 0.45, 0.53, m.group.position.z)
  }
  if (reducedMotion && camera && controls) {
    camera.position.copy(cameraGoal.pos)
    controls.target.copy(cameraGoal.target)
    cameraGoal = null
  }
}

// 右排近→远，再沿左排远→近回到门口；包含所有九个实际机位。
const NAV_ORDER = ['D1', 1, 2, 3, 4, 5, 6, 7, 'D2']
function switchMachine(dir) {
  if (!selected.value) return
  const idx = NAV_ORDER.indexOf(selected.value.no)
  if (idx < 0) return
  const next = NAV_ORDER[(idx + dir + NAV_ORDER.length) % NAV_ORDER.length]
  const m = machines.find((x) => x.no === next)
  if (m?.data) focusMachine(m)
}

function selectSlot(no) {
  const machine = machines.find((item) => item.no === no)
  if (machine?.data) focusMachine(machine)
}

let dryerKeyAt = 0
function onStageKeydown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return
  if (event.key.toLowerCase() === 'd') { dryerKeyAt = performance.now(); event.preventDefault(); return }
  if (/^[1-7]$/.test(event.key)) {
    const dryer = performance.now() - dryerKeyAt < 1500 && dryerKeyAt > 0 && Number(event.key) <= 2
    selectSlot(dryer ? `D${event.key}` : Number(event.key))
    dryerKeyAt = 0
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    if (selected.value) switchMachine(event.key === 'ArrowRight' ? 1 : -1)
    else selectSlot('D1')
  } else if (event.key === 'Escape' || event.key === 'Home') resetCamera()
  else return
  event.preventDefault()
}

function clearSelection() {
  selected.value = null
  facility.value = null
  // 收起面板时相机飞回默认全景
  if (camera && controls) {
    const cam = defaultCam()
    cameraGoal = {
      pos: new THREE.Vector3(...cam.pos),
      target: new THREE.Vector3(...cam.target)
    }
  }
}

function resetCamera() {
  if (!camera || !controls) return
  cameraGoal = null
  selected.value = null
  facility.value = null
  roomTrack('room_interaction', { action: 'reset' })
  applyCameraLimits()
  const cam = defaultCam()
  camera.position.set(...cam.pos)
  controls.target.set(...cam.target)
  fitCamera()
  controls.update()
  lastInteractionAt = performance.now()
}

// 桶内视觉：绿=空桶、黄=衣物翻滚、红=故障 X
function applyDrumVisual(m) {
  const state = m.data?.state || 'unknown'
  if (!m.clothGroup) return
  m.clothGroup.visible = state === 'occupied' || state === 'abnormal'
  m.xMark.visible = state === 'faulty'
  // 空闲 = 舱门敞开（一眼看出"这台能用"）；其余状态关门
  if (m.doorPivot) m.doorTarget = state === 'idle' ? m.doorOpenAngle : 0
  // 占用时桶内有水面（异常占用也算里面有衣服）
  if (m.waterGroup) m.waterGroup.visible = state === 'occupied' || state === 'abnormal'
  // 空桶时桶底略亮（"空的、能用"）
  const baseColor = state === 'idle' ? 0x243040 : 0x161e28
  if (m.drumBase?.material?.color) m.drumBase.material.color.setHex(baseColor)
  // 顶部状态灯带同步颜色
  const hex = STATE_HEX[state] || STATE_HEX.unknown
  if (m.stripMat) {
    m.stripMat.color.setHex(hex)
    m.stripMat.emissive.setHex(hex)
  }
}

// 排队可视化：机器前每排一个人就放一个待洗桶（盆里泡着衣物）
const QUEUE_BUCKET_COLORS = [0x3f8fd2, 0xd26a8a, 0x4fae86, 0xd9a13f]
function updateQueueVisuals() {
  const counts = new Map()
  for (const entry of queueList.value) counts.set(entry.machineId, (counts.get(entry.machineId) || 0) + 1)
  for (const m of machines) {
    if (!m.queueGroup) continue
    // 只在数量变化时重建
    const count = Math.min(3, counts.get(m.data?.machineId) || 0)
    if (count === (m.queueCount || 0)) continue
    m.queueCount = count
    while (m.queueGroup.children.length) {
      const oldBucket = m.queueGroup.children[0]
      disposeObjectResources(oldBucket, [], [], DRUM_MATS.cloth)
      m.queueGroup.remove(oldBucket)
    }
    const show = Math.min(count, 3) // 最多画 3 个桶
    for (let i = 0; i < show; i++) {
      const bucket = new THREE.Group()
      const basin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.085, 0.065, 0.11, 14),
        new THREE.MeshStandardMaterial({
          color: QUEUE_BUCKET_COLORS[i % QUEUE_BUCKET_COLORS.length],
          roughness: 0.5,
          metalness: 0.05
        })
      )
      basin.position.y = 0.055
      bucket.add(basin)
      // 桶口一圈白边 + 冒出来的衣物
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.085, 0.008, 8, 20),
        new THREE.MeshStandardMaterial({ color: 0xe8edf3, roughness: 0.5 })
      )
      rim.rotation.x = Math.PI / 2
      rim.position.y = 0.11
      bucket.add(rim)
      const cloth = makeClothPiece(0.05, DRUM_MATS.cloth[i % DRUM_MATS.cloth.length])
      cloth.position.y = 0.12
      bucket.add(cloth)
      // 排在机器舱门前的走道一侧，逐个往 z 方向排开
      bucket.position.set(m.slotFacing * 0.62, 0, -0.28 + i * 0.24)
      m.queueGroup.add(bucket)
    }
  }
}

// 拉取看板数据（机器状态 + 留言 + 排队），把 1F 的机器按物理编号映射到场景
let syncPending = null
async function syncData(force = false) {
  if (syncPending) return syncPending
  syncPending = performSyncData(force)
  try { return await syncPending } finally { syncPending = null }
}

async function performSyncData(force) {
  const [data, msgData, queueData, occData] = await Promise.all([
    loadBoard({ force, dorm: 'guiyuan' }),
    api('/api/messages?dorm=guiyuan', { auth: false }).catch(() => null),
    // 排队要带上 token 才能算 mine（这条是不是我的）；但**不能强制登录**，
    // 看板是公开的，匿名访客也要能看。所以用 optional。
    api('/api/queue?dorm=guiyuan', { auth: 'optional' }).catch(() => null),
    api('/api/occupancy?building=b1', { auth: false }).catch(() => null)
  ])
  if (disposed) return
  const slotMap = data.mapping || {}
  if (msgData) allMessages.value = msgData.messages || []
  if (queueData) queueList.value = queueData.queue || []
  if (occData) occupancyMap.value = occData.occupancy || {}

  // 上游抓取失败时服务端会继续返回上一次的看板，界面必须提示「这不是最新」，
  // 否则用户会照着旧状态白跑一趟。
  const updatedMs = data?.board?.updatedAt ? new Date(data.board.updatedAt).getTime() : 0
  lastBoardUpdated = updatedMs
  const ageMin = updatedMs ? Math.floor((Date.now() - updatedMs) / 60000) : -1
  staleMin.value = ageMin >= 3 ? ageMin : null

  const floors = data?.board?.floors || []
  const firstFloor = floors.find((f) => f.code === '1F') || floors[0]
  const list = firstFloor?.machines || []
  // 绑定查找要用整个看板：绑定的机器可能不在 1F（比如 D1 绑到了「柳园西」）
  const allMachines = floors.flatMap((f) => f.machines || [])

  for (const m of machines) {
    // 有绑定就只认绑定；无绑定仅兼容 mock 固定 id，绝不猜真实设备。
    const wantedId = typeof m.no === 'number' ? `1F-0${m.no}` : `1F-${m.no}`
    const boundId = slotMap[String(m.no)]
    // 绑定的是哪台就是哪台，**不限楼层**：
    // 之前只在 1F 列表里找，D1 绑到「柳园西」（floorCode 不是 1）就找不到，
    // 于是一直显示「未知」——其实绑定是好的。
    const hit = boundId
      ? allMachines.find((x) => String(x.id) === String(boundId))
      : list.find((x) => String(x.id) === wantedId)
    m.data = hit
      ? {
          // 异常占用：后端直接给 abnormal，或 occupied + abandoned/abnormal 上报标记 → 橙色
          state:
            hit.state === 'abnormal' || (hit.state === 'occupied' && (hit.abandoned || hit.abnormal))
              ? 'abnormal'
              : hit.state || 'unknown',
          leftMin: hit.leftMin,
          finishAt: hit.finishAt,
          estimated: hit.estimated,
          availabilityLabel: hit.availabilityLabel || '',
          registrationPending: hit.registrationPending === true,
          availabilitySource: hit.availabilitySource || '',
          rawState: hit.rawState,
          kind: hit.kind || m.kind,
          name: hit.name || wantedId,
          rawName: hit.name,
          machineId: hit.id
        }
      : { state: 'unknown', leftMin: null, name: boundId ? '绑定设备暂不可用' : '机位尚未绑定', rawName: null, machineId: '', kind: m.kind }
    const hex = STATE_HEX[m.data.state] || STATE_HEX.unknown
    m.ringMat.color.setHex(hex)
    m.ringMat.emissive.setHex(hex)
    applyDrumVisual(m)
    drawLabel(m)
  }

  // 视觉回归用：?demo=1 强制确定性状态（4 占用 / D1 异常占用 / 3 故障 / 其余空闲）
  if (route.query.demo) {
    for (const m of machines) {
      if (m.no === 4) {
        m.data.state = 'occupied'
        m.data.leftMin = 32
      } else if (m.no === 'D1') {
        m.data.state = 'abnormal'
        m.data.leftMin = 0
      } else if (m.no === 3) {
        m.data.state = 'faulty'
        m.data.leftMin = null
      } else {
        m.data.state = 'idle'
        m.data.leftMin = null
      }
      const hex = STATE_HEX[m.data.state]
      m.ringMat.color.setHex(hex)
      m.ringMat.emissive.setHex(hex)
      applyDrumVisual(m)
      drawLabel(m)
    }
  }

  updateQueueVisuals()
  // 若正在看某台，刷新它的信息
  if (selected.value) {
    const m = machines.find((x) => x.no === selected.value.no)
    if (m?.data) selected.value = { no: m.no, kind: m.kind || 'washer', ...m.data }
  }

  // 回归用：?focus=4 直接选中某台并飞相机（配合 ?demo=1 截图验证悬浮面板）
  if (route.query.focus && !selected.value) {
    const raw = route.query.focus
    const no = /^D[12]$/.test(raw) ? raw : Number(raw)
    const m = machines.find((x) => x.no === no)
    if (m?.data) focusMachine(m)
  }
}

// 登记洗衣保存公开备注与消毒液选项，开洗自动退出自己的排队。
async function quickStart() {
  return submitRegistration('washer')
}

// 本机留言板：只看挂在当前选中机器上的留言（最新 5 条）
const machineMessages = computed(() => {
  if (!selected.value?.machineId) return []
  return allMessages.value
    .filter((m) => m.machineId === selected.value.machineId)
    .slice(-5)
    .reverse()
})

// 给当前选中的机器留言
async function postMachineMessage() {
  const t = msgText.value.trim()
  if (!t || !selected.value?.machineId) return
  try {
    await api('/api/messages', {
      method: 'POST',
      body: {
        text: t,
        machineId: selected.value.machineId,
        machineName: selected.value.name || selected.value.rawName || ''
      }
    })
    msgText.value = ''
    showToast('已留言')
    await syncData()
  } catch (e) {
    showToast(e?.message || '留言失败')
  }
}

// 排队：我在当前选中机器上是否已排队（服务端用 token 标 mine）
const myQueueEntry = computed(() => {
  if (!selected.value?.machineId) return null
  return queueList.value.find((q) => q.machineId === selected.value.machineId && q.mine) || null
})
// 当前选中机器的排队人数
const selectedQueueCount = computed(() => {
  if (!selected.value?.machineId) return 0
  return queueList.value.filter((q) => q.machineId === selected.value.machineId).length
})

async function toggleQueue() {
  if (!selected.value?.machineId) return
  queueSubmitting.value = true
  try {
    if (myQueueEntry.value) {
      await api('/api/queue', { method: 'DELETE' })
      showToast('已取消排队')
    } else {
      await api('/api/queue', { method: 'POST', body: { machineId: selected.value.machineId } })
      showToast('已排队，轮到你会提醒你')
    }
    await syncData()
  } catch (e) {
    showToast(e?.message || '操作失败')
  } finally {
    queueSubmitting.value = false
  }
}

async function bootstrap() {
  if (dorm.code !== 'guiyuan' || disposed) return
  loading.value = true
  error.value = ''
  try {
    await nextTick()
    if (contextFailed) { releaseThree(); contextFailed = false }
    if (!renderer) {
      try { initThree() } catch {
        releaseThree()
        failScene('initialization_failed')
        return
      }
    }
    if (contextFailed) return
    await syncData(true)
    if (disposed) return
    loading.value = false
    if (!readyAt) readyAt = performance.now()
    startPoll()
  } catch (e) {
    loading.value = false
    error.value = e?.message || '加载失败'
  }
}

// 每 30s 拉一次看板，页面在前台时才轮询，后台标签页不打扰接口
const POLL_MS = 45000
let pollTimer = null
let pollBusy = false

function startPoll() {
  stopPoll()
  pollTimer = setInterval(async () => {
    if (pollBusy || document.visibilityState === 'hidden') return
    pollBusy = true
    try {
      await syncData()
    } catch (e) {
      /* 下一轮再试 */
    } finally {
      pollBusy = false
    }
  }, POLL_MS)
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

onMounted(() => {
  if (dorm.code && dorm.code !== 'guiyuan') { router.replace('/list'); return }
  if (dorm.code) { bootstrap(); startPoll() }
})

watch(() => dorm.code, (code) => {
  if (!code) return
  if (code !== 'guiyuan') { stopPoll(); router.replace('/list'); return }
  bootstrap()
  startPoll()
})

const countdownTimer = setInterval(() => {
  if (document.visibilityState === 'hidden' || disposed) return
  clockNow.value = Date.now()
  const age = lastBoardUpdated ? Math.floor((clockNow.value - lastBoardUpdated) / 60000) : 0
  staleMin.value = age >= 3 ? age : null
  for (const m of machines) {
    const end = m.data?.finishAt ? new Date(m.data.finishAt).getTime() : NaN
    if (!Number.isFinite(end) || !['occupied', 'abnormal'].includes(m.data.state)) continue
    const left = Math.max(0, Math.ceil((end - clockNow.value) / 60000))
    if (left !== m.data.leftMin) {
      m.data.leftMin = left
      drawLabel(m)
      if (selected.value?.no === m.no) selected.value = { no: m.no, kind: m.kind, ...m.data }
    }
  }
}, 1000)

function samplePerformance() {
  if (!readyAt || !renderer) return
  const now = performance.now()
  if (!performanceWindow.at) performanceWindow.at = now
  performanceWindow.frames++
  const elapsed = now - performanceWindow.at
  const first = !performanceWindow.sent
  if (elapsed < (first ? 1000 : 30000)) return
  const fields = {
    fps: Math.round(performanceWindow.frames * 1000 / elapsed),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    quality: qualityTier,
  }
  if (first) fields.durationMs = Math.round(readyAt - startedAt)
  roomTrack('room_performance', fields)
  performanceWindow = { at: now, frames: 0, sent: true }
}

function releaseThree() {
  cancelAnimationFrame(rafId)
  rafId = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', resizeHandler)
  document.removeEventListener('visibilitychange', visHandler)
  timer?.dispose()
  controls?.removeEventListener('start', onControlsStart)
  controls?.removeEventListener('end', onControlsEnd)
  controls?.dispose()
  if (renderer) {
    for (const [name, handler] of [
      ['pointerdown', onPointerDown], ['pointerup', onPointerUp], ['pointermove', onPointerMove],
      ['pointercancel', onPointerCancel], ['lostpointercapture', onPointerCancel],
      ['webglcontextlost', onContextLost], ['webglcontextrestored', onContextRestored],
    ]) renderer.domElement.removeEventListener(name, handler)
  }
  if (scene) scene.environment = null
  environmentTarget?.dispose()
  environmentTarget = null
  disposeObjectResources(scene, Object.values(GEO), [DRUM_MATS.base, DRUM_MATS.lip, DRUM_MATS.x, ...DRUM_MATS.cloth])
  renderer?.renderLists.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
  renderer = scene = camera = controls = timer = null
  windowSashes.length = 0
  machines.length = 0
  clickTargets = []
  faucetStream = null
  faucetOn = false
  cameraGoal = null
  pointerGesture.cancel()
  interacting = false
  lastRafTs = rafAccMs = prevT = 0
}

onUnmounted(() => {
  disposed = true
  clearInterval(countdownTimer)
  stopPoll()
  releaseThree()
  widthQuery.removeEventListener('change', onWidthChange)
  motionQuery.removeEventListener('change', onMotionChange)
  perfEl?.remove()
})

</script>

<style scoped>
.dorm-switch { border: 0; background: transparent; color: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
.nav-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  color: #cbd5e1;
}

/* 2D 切换：和看板那侧的「3D」胶囊呼应，一眼能看出这是视图切换 */
.switch-2d {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 24px;
  padding: 0 10px;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.5px;
  color: #7dd3fc;
  border: 1px solid rgba(125, 211, 252, 0.45);
  background: rgba(125, 211, 252, 0.12);
  border-radius: 999px;
  line-height: 1;
  user-select: none;
}
.switch-2d:active {
  background: rgba(125, 211, 252, 0.26);
}

.room-page {
  position: relative;
  display: flex;
  flex-direction: column;
  /* 默认首页：底部有 tabbar（50px） */
  height: calc(100vh - 50px);
  height: calc(100dvh - 50px);
  background: #0a1119;
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
}

.room-home { display: inline-grid; place-items: center; width: 36px; height: 36px; color: inherit; background: transparent; border: 0; border-radius: 9px; cursor: pointer; }
.quality-control { position: absolute; top: 48px; right: 12px; display: flex; align-items: center; gap: 5px; color: #b6c9dd; font-size: 11px; padding: 4px 7px; border: 1px solid #3b4a5e; background: #101d2be6; border-radius: 8px; }
.quality-control select { color-scheme: dark; border: 0; background: #142333; color: #e0ecf8; font-size: 12px; min-height: 30px; max-width: 96px; }
.machine-shortcuts { position: absolute; display: flex; gap: 5px; justify-content: center; bottom: 39px; width: 100%; padding: 0 10px; box-sizing: border-box; }
.machine-shortcuts button { flex: 0 1 38px; min-width: 29px; height: 36px; padding: 0 4px; color: #d7e9fa; border: 1px solid #38516a; background: #0c1b2be8; border-radius: 9px; cursor: pointer; }
.machine-shortcuts button[aria-pressed="true"] { color: #a4e2ff; border-color: #79d0fc; background: #18476c; }
.room-page button:focus-visible, .stage:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
.legend, .orientation { pointer-events: none; }
.stale-chip { max-width: calc(100% - 165px); }

.stage-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(10, 17, 25, 0.9);
  color: var(--text-dim, #94a3b8);
  z-index: 5;
}

.err-text {
  max-width: 80%;
  text-align: center;
  color: #f59e0b;
}

.spin {
  width: 22px;
  height: 22px;
  border: 2px solid #1e293b;
  border-top-color: #22c55e;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.legend {
  position: absolute;
  top: 10px;
  left: 12px;
  display: flex;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(8, 13, 23, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.16);
  font-size: 11px;
  color: #cbd5e1;
  backdrop-filter: blur(6px);
}

/* 数据过期提示：放在图例下方，低饱和的琥珀色，不抢画面但看得见 */
.stale-chip {
  position: absolute;
  top: 44px;
  left: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(120, 53, 15, 0.72);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #fcd34d;
  font-size: 11px;
  backdrop-filter: blur(6px);
  pointer-events: none;
}

.legend .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}

.dot.idle {
  background: #22c55e;
}
.dot.occ {
  background: #f59e0b;
}
.dot.abn {
  background: #f97316;
}
.dot.fal {
  background: #ef4444;
}

.orientation {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(8, 13, 23, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.16);
  font-size: 11px;
  color: #94a3b8;
  white-space: nowrap;
  backdrop-filter: blur(6px);
}

/* 机器面板：窄屏（手机）= 底部固定卡片；宽屏 = 跟随机器悬浮 */
.machine-panel {
  position: absolute;
  z-index: 6;
  background: rgba(10, 17, 27, 0.92);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 14px;
  padding: 10px 12px 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}

/* 窄屏：底部卡片，好按、不挡场景 */
@media (max-width: 719px) {
  .machine-panel {
    position: relative;
    flex: 0 1 auto;
    left: auto;
    right: auto;
    bottom: auto;
    margin: 0 10px 10px;
    width: auto;
    max-height: 46dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
  }
  .legend { gap: 8px; }
  .stage.has-panel .orientation { display: none; }
  .stage.has-panel .machine-shortcuts { bottom: 8px; }
  .mp-head { position: sticky; top: -10px; background: #101b29; z-index: 1; padding: 8px 0; }
}

.mp-nav, button.mp-close { min-width: 36px; min-height: 36px; border: 1px solid #34506a; background: #142a40; color: #b5defc; border-radius: 8px; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .sheet-enter-active, .sheet-leave-active { transition: none; } }

/* 宽屏：跟随机器上方悬浮 */
@media (min-width: 720px) {
  .machine-panel {
    width: min(84vw, 320px);
    max-height: calc(100% - 76px);
    overflow-y: auto;
    transform: translate(-50%, -50%);
  }
}

.mp-fault {
  margin-bottom: 8px;
}
.mp-fault-hint {
  font-size: 12px;
  color: #fca5a5;
  margin-bottom: 8px;
  line-height: 1.45;
}

.boiler-no {
  border-color: #7dd3fc;
  color: #e0f2fe;
  display: grid;
  place-items: center;
  font-weight: 700;
}

.mp-rules {
  margin: 0;
  padding: 0 0 0 18px;
  color: #dbe4ee;
  font-size: 13px;
  line-height: 1.7;
}

.mp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.mp-no {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 2px solid #6b7280;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  font-weight: 700;
  color: #e8f0fb;
}

.mp-meta {
  flex: 1;
  min-width: 0;
}

.mp-name {
  font-size: 13px;
  color: #e8f0fb;
  margin-bottom: 2px;
}

.mp-state {
  font-size: 12px;
}

.mp-dev {
  margin-top: 2px;
  font-size: 11px;
  color: #7b8a9d;
}

.mp-close {
  color: #64748b;
  font-size: 17px;
  padding: 4px;
}

.mp-nav {
  font-size: 22px;
  line-height: 1;
  color: #93c5fd;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  border-radius: 8px;
}
.mp-nav:active {
  background: rgba(59, 130, 246, 0.18);
}

.mp-hint-dim {
  margin: -4px 0 8px;
  font-size: 11px;
  color: #8fa2b8;
}

/* 「按机器剩余」是默认项，做得比普通选项显眼一点 */
.mp-dur-follow {
  font-size: 12px;
  font-weight: 600;
}

.mp-dur.disabled {
  opacity: 0.42;
  cursor: not-allowed;
  border-style: dashed;
}

.mp-durations {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 8px;
}

.mp-dur {
  background: #152438;
  min-height: 34px;
  font-size: 11px;
  padding: 6px 4px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #b6c2d2;
  cursor: pointer;
  text-align: center;
  white-space: nowrap;
}
.mp-dur:disabled,.mp-modes button:disabled{opacity:.55;cursor:default}

.mp-dur.on {
  border-color: #3b82f6;
  color: #93c5fd;
  background: rgba(59, 130, 246, 0.14);
}

.mp-note {
  width: 100%;
  box-sizing: border-box;
  background: rgba(148, 163, 184, 0.1);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  color: #e8f0fb;
  font-size: 12px;
  padding: 7px 9px;
  margin-bottom: 8px;
  outline: none;
}

.mp-note::placeholder {
  color: #5b6b7f;
}

.mp-queue {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.mp-queue-n {
  font-size: 11px;
  color: #f59e0b;
}

.mp-msgs {
  margin-top: 10px;
  border-top: 1px dashed rgba(148, 163, 184, 0.2);
  padding-top: 8px;
}

.mp-msgs-title {
  font-size: 11px;
  color: #7d8ea3;
  margin-bottom: 6px;
}

.mp-msg-empty {
  font-size: 11px;
  color: #55637a;
}

.mp-msg {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  color: #cdd8e5;
  line-height: 1.5;
  margin-bottom: 4px;
}

.mp-msg-nick {
  flex: none;
  color: #7fb0e0;
}

/* 留言正文：短内容跟昵称同一行起排，长内容正常折行；
   不用 pre-wrap（会把服务端存的 \n 变成莫名换行），也不用 break-all（会硬拆英文） */
.mp-msg-text {
  flex: 1;
  min-width: 0;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.mp-dry { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.mp-dry-row { display: flex; align-items: center; gap: 8px; justify-content: center; }
.mp-dry-label { font-size: 13px; color: #cdd8e5; }
.mp-dry-input {
  width: 84px; height: 34px; text-align: center;
  font-size: 17px; font-weight: 700; color: #eaf2fb;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px; outline: none;
}
.mp-step {
  width: 34px; height: 34px; border-radius: 8px;
  border: 1px solid rgba(125, 211, 252, 0.45);
  background: rgba(125, 211, 252, 0.14);
  color: #9fd7ff; font-size: 18px; line-height: 1; cursor: pointer;
}
.mp-step:active { background: rgba(125, 211, 252, 0.3); }
.mp-dry-unit { font-size: 13px; color: #8fa3b8; }
.mp-dry-warn {
  margin: 8px 0; padding: 9px 12px; border-radius: 10px;
  background: rgba(251, 146, 60, 0.16);
  border: 1px solid rgba(251, 146, 60, 0.5);
  color: #ffd7b0; font-size: 13px; line-height: 1.6;
}
.mp-dry-warn-sub { color: #ffb37a; font-weight: 600; }

.mp-proof {
  margin: 10px 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.45);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mp-proof-title { font-size: 13px; color: #ffc9c9; font-weight: 600; }
.mp-proof-line { font-size: 12px; color: #e6eef7; display: flex; align-items: center; gap: 6px; }
.mp-proof-line b { color: #ffd48a; }
.mp-proof-photos { display: flex; gap: 8px; }
.mp-proof-btn {
  flex: 1;
  height: 34px;
  border-radius: 8px;
  font-size: 12px;
  color: #cfe3f7;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  cursor: pointer;
}
.mp-file { display: none; }
.mp-proof-size { font-size: 11px; color: #9fd7ff; }
.mp-proof-tip { font-size: 11px; color: #9fb2c6; line-height: 1.5; }

.mp-msg-post {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.mp-msg-post .mp-note {
  margin-bottom: 0;
  flex: 1;
}

.mp-send {
  font-size: 12px;
  color: #3b82f6;
  padding: 6px 8px;
  cursor: pointer;
  white-space: nowrap;
}

.mp-occupier {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #cdd8e5;
  background: rgba(148, 163, 184, 0.08);
  border-radius: 8px;
  padding: 6px 9px;
  margin-bottom: 8px;
}
.mp-occ-avatar {
  border-radius: 50%;
  flex: none;
}
.mp-urge {
  margin-bottom: 8px;
}

/* 首次使用的资料设置浮层（居中卡片，不打断看房） */
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity .2s cubic-bezier(.16,1,.3,1), transform .24s cubic-bezier(.16,1,.3,1);
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
@media(prefers-reduced-motion:reduce){.sheet-enter-active,.sheet-leave-active{transition:none}.sheet-enter-from,.sheet-leave-to{transform:none}}
.mp-modes{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.mp-modes button{padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text-dim);font-size:12px}.mp-modes button.on{border-color:#60a5fa;color:#93c5fd}.mp-custom-duration{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--text-dim);margin:10px 0}.mp-custom-duration input{width:72px;padding:6px;border:1px solid var(--border);border-radius:6px;color:var(--text);background:var(--bg);font:inherit;color-scheme:dark}
</style>
