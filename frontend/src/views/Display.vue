<template>
  <div class="display">
    <div class="d-top">
      <div class="d-time">{{ clock }}</div>
      <button class="d-building" @click="dorm.showPicker = true">{{ dorm.name || '选择住宿楼' }} ▾</button>
    </div>

    <!-- 空闲数醒目展示 -->
    <div class="d-idle">
      <div class="d-idle-num">{{ board?.idle ?? '-' }}</div>
      <div class="d-idle-label">台空闲</div>
    </div>

    <div class="d-summary">
      <span class="state-idle">空闲 {{ board?.idle ?? 0 }}</span>
      <span class="state-occupied">占用 {{ board?.occupied ?? 0 }}</span>
      <span class="state-faulty">故障 {{ board?.faulty ?? 0 }}</span>
    </div>

    <div v-if="error" class="d-status">{{ sourceBoard ? '刷新失败，暂时显示上次数据' : '暂时无法读取机器数据' }} <button @click="load(true)">重试</button></div>
    <div v-else-if="sourceBoard?.freshness?.syncFailed" class="d-status">最近一次同步未成功，显示上次有效数据 <button @click="load(true)">重新检查</button></div>
    <div v-else-if="staleMinutes >= 3" class="d-status">数据已 {{ staleMinutes }} 分钟未更新，请以现场为准</div>
    <div v-else-if="sourceBoard && !floors.length" class="d-status">这栋楼暂无机器数据</div>
    <!-- 各楼层机器大色块 -->
    <div class="d-floors">
      <div v-for="f in floors" :key="f.code" class="d-floor">
        <div class="d-floor-code">{{ f.code }}</div>
        <div class="d-machines">
          <div
            v-for="m in f.machines"
            :key="m.id"
            class="d-machine"
            :class="'bg-' + stateClass(m.state)"
          >
            <span class="d-m-name">{{ m.displayName || m.name || m.id }}</span>
            <span class="d-m-state" v-if="m.suspectedUncollected">疑似未取</span><span class="d-m-state" v-else-if="m.state === 'occupied'">{{ m.leftMin == null ? '剩余时间待确认' : `剩${m.leftMin}分` }}</span>
          </div>
        </div>
      </div>
    </div>
    <van-button size="small" plain @click="$router.push('/list')">返回列表</van-button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { filterDormFloors, boardAgeMinutes } from '../boardQuery'
import { useDormBoard } from '../useDormBoard'
import { useDormStore } from '../stores/dorm'

const dorm = useDormStore()
const { sourceBoard, error, now, load } = useDormBoard(dorm)
const staleMinutes = computed(() => boardAgeMinutes(sourceBoard.value, now.value))
const floors = computed(() => filterDormFloors(sourceBoard.value, dorm.code, dorm.buildings).map((f) => ({ ...f, machines: (f.machines || []).map((m) => {
  const end = m.finishAt ? new Date(m.finishAt).getTime() : NaN
  return Number.isFinite(end) ? { ...m, leftMin: Math.max(0, Math.ceil((end - now.value) / 60000)) } : m
}) })))
const board = computed(() => {
  if (!sourceBoard.value) return null
  const all = floors.value.flatMap((f) => f.machines || [])
  return { total: all.length, idle: all.filter((m) => m.state === 'idle').length, occupied: all.filter((m) => ['occupied', 'abnormal'].includes(m.state)).length, faulty: all.filter((m) => m.state === 'faulty').length }
})
const clock = ref('')
let clockTimer
// 状态 -> 颜色类
function stateClass(s) {
  return ({ idle: 'idle', occupied: 'occupied', faulty: 'faulty' })[s] || 'unknown'
}
// 每秒刷新时钟
function tickClock() {
  now.value = Date.now()
  clock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

onMounted(() => { tickClock(); clockTimer = setInterval(tickClock, 1000) })
onUnmounted(() => clearInterval(clockTimer))
</script>

<style scoped>
.display {
  min-height: 100vh;
  background: var(--bg);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.d-status { text-align:center; color:#fbbf24; font-size:18px; } .d-status button { border:1px solid var(--border); border-radius:8px; padding:6px 14px; background:var(--bg-card); color:var(--text); cursor:pointer; }
.d-top { display: flex; justify-content: space-between; align-items: baseline; }
.d-time { font-size: 56px; font-weight: 800; letter-spacing: 2px; }
.d-building { font-size: 24px; color: var(--text-dim); border: 0; background: transparent; cursor: pointer; }
.d-idle { text-align: center; }
.d-idle-num { font-size: 160px; font-weight: 900; color: var(--st-idle); line-height: 1; }
.d-idle-label { font-size: 36px; color: var(--text-dim); }
.d-summary { display: flex; gap: 32px; justify-content: center; font-size: 30px; font-weight: 700; }
.d-floors { display: flex; flex-direction: column; gap: 16px; }
.d-floor-code { font-size: 30px; font-weight: 700; margin-bottom: 8px; }
.d-machines { display: flex; flex-wrap: wrap; gap: 12px; }
.d-machine {
  min-width: 130px; padding: 14px 18px; border-radius: 12px;
  color: #0b1220; font-weight: 700; font-size: 24px;
  display: flex; flex-direction: column;
}
.d-m-state { font-size: 18px; }
</style>

<style scoped>@media(max-width:600px){.display{padding:16px;gap:18px}.d-time{font-size:30px}.d-building{font-size:20px}.d-idle-num{font-size:100px}.d-summary{font-size:18px;gap:16px}.d-machine{font-size:18px;min-width:100px}}</style>
