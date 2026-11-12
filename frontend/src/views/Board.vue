<template>
  <div class="page board">
    <van-nav-bar>
      <template #title><button class="dorm-switch" @click="dorm.showPicker = true">{{ dorm.name || '选择住宿楼' }} ▾</button></template>
      <template #right>
        <div class="nav-actions">
          <span v-if="dorm.code === 'guiyuan'" class="room-btn" @click="goRoom">3D</span>
          <van-icon name="tv-o" size="20" @click="goDisplay" />
        </div>
      </template>
    </van-nav-bar>

    <!-- 顶部统计 -->
    <div class="stats">
      <div class="stat"><div class="stat-num">{{ board?.total ?? '-' }}</div><div class="stat-label">本楼机器</div></div>
      <div class="stat idle"><div class="stat-num">{{ board?.idle ?? '-' }}</div><div class="stat-label">空闲</div></div>
      <div class="stat occ"><div class="stat-num">{{ board?.occupied ?? '-' }}</div><div class="stat-label">占用</div></div>
      <div class="stat fal"><div class="stat-num">{{ board?.faulty ?? '-' }}</div><div class="stat-label">故障</div></div>
    </div>

    <div class="board-heading"><h2>{{ dorm.name }}洗衣房</h2><span>{{ sourceBoard ? `更新于 ${new Date(sourceBoard.updatedAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}` : '正在读取…' }}</span></div>
    <div class="kind-filter"><button v-for="k in kinds" :key="k.value" :class="{on:kind===k.value}" @click="kind=k.value">{{ k.text }}</button></div>
    <div class="sort-note"><span>最快可用优先</span><button type="button" :class="{on:onlyFavorites}" :aria-pressed="onlyFavorites" @click="onlyFavorites=!onlyFavorites"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>{{onlyFavorites?'查看全部机器':'常用机器'}}<span v-if="favorites.length && !onlyFavorites">{{favorites.length}}</span></button></div>
    <!-- 楼层切换 -->
    <FloorTabs v-model="activeFloor" :floors="[{code:'all',name:'本楼全部',machines:floors.flatMap(f=>f.machines)},...floors]" />

    <van-pull-refresh v-model="refreshing" @refresh="load(true)">
      <!-- 兜底：加载失败 -->
      <div v-if="error && !board" class="empty">
        <p>加载失败：{{ error }}</p>
        <van-button size="small" type="primary" @click="load(true)">重试</van-button>
      </div>
      <!-- 兜底：空态 -->
      <div v-else-if="!currentMachines.length" class="empty text-dim">{{ onlyFavorites ? '当前楼栋或筛选下没有收藏机器，可切换“查看全部机器”。' : dorm.code ? '这栋楼暂无符合筛选的机器' : '先选择住宿楼' }}</div>
      <div v-else class="grid">
        <MachineCard v-for="m in currentMachines" :key="m.id" :machine="m" :slot="machineSlot(sourceBoard?.slotMapping,m.id)" :favorite="favorites.includes(String(m.id))" @favorite="loadFavorites" />
      </div>
    </van-pull-refresh>
    <div v-if="error && board" class="board-tip">刷新失败，显示上次数据：{{ error }}</div>
    <div v-else-if="sourceBoard?.freshness?.syncFailed" class="board-tip">最近一次同步未成功，显示上次有效数据 <button @click="load(true)">重新检查</button></div>
    <div v-else-if="staleMinutes >= 3" class="board-tip">数据已 {{ staleMinutes }} 分钟未更新，请以现场为准</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api } from '../api'
import { sortByAvailability } from '../machineOrder'
import { useUserStore } from '../stores/user'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useDormStore } from '../stores/dorm'
import { filterDormFloors, boardAgeMinutes } from '../boardQuery'
import { useDormBoard } from '../useDormBoard'
import { platformNow } from '../platformClock'
import FloorTabs from '../components/FloorTabs.vue'
import MachineCard from '../components/MachineCard.vue'
import { machineSlot } from '../machineSlot'

const router = useRouter()
const dorm = useDormStore()
const user=useUserStore()
const favorites=ref([]),onlyFavorites=ref(false)
let favoritesGeneration=0
async function loadFavorites(){const generation=++favoritesGeneration,owner=user.user?.id;favorites.value=[];if(!user.isLoggedIn)return;try{const d=await api('/api/user/laundry-preferences');if(generation===favoritesGeneration&&owner===user.user?.id)favorites.value=d.preferences?.favorites||d.favorites||[]}catch{}}
watch(()=>user.user?.id,loadFavorites,{immediate:true})

const { sourceBoard, now, error, refreshing, load } = useDormBoard(dorm)
const floors = computed(() => filterDormFloors(sourceBoard.value, dorm.code, dorm.buildings).map((f) => ({ ...f, machines: (f.machines || []).map((m) => {
  const end = m.finishAt ? new Date(m.finishAt).getTime() : NaN
  return Number.isFinite(end) ? { ...m, leftMin: Math.max(0, Math.ceil((end - platformNow(sourceBoard.value, now.value)) / 60000)) } : m
}) })))
const board = computed(() => {
  if (!sourceBoard.value) return null
  const all = floors.value.flatMap((f) => f.machines || [])
  return { ...sourceBoard.value, total: all.length, idle: all.filter((m) => m.state === 'idle').length, occupied: all.filter((m) => ['occupied', 'abnormal'].includes(m.state)).length, faulty: all.filter((m) => m.state === 'faulty').length }
})
const staleMinutes = computed(() => boardAgeMinutes(sourceBoard.value, now.value))
const activeFloor = ref('all')
const kind = ref('')
const kinds = [{value:'',text:'全部类型'},{value:'washer',text:'洗衣机'},{value:'dryer',text:'烘干机'}]
watch(floors, (next) => { if (activeFloor.value !== 'all' && !next.some((f) => f.code === activeFloor.value)) activeFloor.value = 'all' })

// 当前楼层机器列表
const currentMachines = computed(() => {
  const list=activeFloor.value==='all'?floors.value.flatMap(f=>f.machines||[]):floors.value.find(f=>f.code===activeFloor.value)?.machines||[]
  return sortByAvailability(list.filter((m)=>(!kind.value||m.kind===kind.value)&&(!onlyFavorites.value||favorites.value.includes(String(m.id)))),now.value)
})

function goDisplay() { router.push('/display') }
function goRoom() { router.push('/') }

</script>

<style scoped>
.sort-note{display:flex;justify-content:space-between;padding:4px 14px;color:var(--text-dim);font-size:12px}.sort-note button{background:transparent;color:#93c5fd;border:0;padding:5px;cursor:pointer}.board-heading{display:flex;justify-content:space-between;align-items:center;padding:4px 14px}.board-heading h2{margin:0;font-size:18px}.board-heading span{font-size:11px;color:var(--text-dim)}.kind-filter{display:flex;gap:8px;padding:10px 12px}.kind-filter button{border:1px solid var(--border);background:var(--bg-card);color:var(--text-dim);border-radius:20px;padding:7px 13px}.kind-filter button.on{border-color:#60a5fa;color:#93c5fd;background:#1c3049}
.dorm-switch { border: 0; background: transparent; color: inherit; font-size: 16px; font-weight: 600; cursor: pointer; }
.board-tip { padding: 12px; color: #fbbf24; font-size: 12px; text-align: center; }
.nav-actions { display: flex; align-items: center; gap: 14px; }
.room-btn {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.45);
  background: rgba(34, 197, 94, 0.1);
  border-radius: 999px;
  padding: 2px 9px;
  line-height: 18px;
}
.stats { display: flex; gap: 8px; padding: 12px; }
.stat {
  flex: 1; background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 12px; text-align: center; padding: 10px 4px;
}
.stat-num { font-size: 22px; font-weight: 700; }
.stat-label { font-size: 12px; color: var(--text-dim); }
.stat.idle .stat-num { color: var(--st-idle); }
.stat.occ .stat-num { color: var(--st-occupied); }
.stat.fal .stat-num { color: var(--st-faulty); }
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; padding: 0 12px; }
.empty { text-align: center; padding: 40px 16px; }
.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.kind-filter{flex-wrap:wrap}.kind-filter button{min-height:40px;flex:1;white-space:nowrap}.sort-note{align-items:center;gap:10px;padding:4px 12px 10px}.sort-note>span{white-space:nowrap}.sort-note>button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:8px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);font:inherit;font-size:12px;white-space:nowrap}.sort-note>button.on{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 12%,var(--bg-card));color:var(--primary)}.sort-note svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6}.sort-note .on svg{fill:currentColor}.sort-note>button>span{font-size:11px;color:var(--text-dim)}.board-heading{gap:12px}.board-heading h2{min-width:0;overflow-wrap:anywhere}.board-heading>span{flex:none}
</style>
