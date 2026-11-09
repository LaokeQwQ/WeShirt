<template>
  <div class="app-root" :class="{ full: route.meta.full, 'room-layout': route.name === 'room3d' }">
    <!-- 未登录提示条：看板可以看，但登记/排队/留言都需要钉钉登录。
         不硬性拦截浏览，只在需要时给一个明确入口，避免用户不知道点了为什么没反应。 -->
    <div v-if="showLoginBar" class="login-bar" @click="goLogin">
      <span class="login-bar-text">还没登录，登记/排队/留言需要钉钉身份</span>
      <span class="login-bar-btn">去登录</span>
    </div>

    <button v-if="!route.meta.full && dorm.code" class="dorm-bar" type="button" @click="dorm.showPicker = true">
      <span>我的住宿楼 · {{ dorm.name }}</span><span>切换 ›</span>
    </button>
    <AnnouncementSplash />
    <QueueNotices />
    <ChannelMentions />
    <InspectionShortcut />
    <router-view v-if="route.meta.full || dorm.code" />
    <div v-else class="dorm-wait">{{ userStore.ready ? '选择住宿楼，查看身边的机器' : '正在恢复你的偏好…' }}</div>

    <van-popup :show="showDormPicker" position="bottom" round :close-on-click-overlay="Boolean(dorm.code)" @update:show="dorm.showPicker = $event">
      <section class="dorm-picker" aria-label="选择住宿楼">
        <h2>{{ dorm.code ? '切换住宿楼' : '你住在哪栋楼？' }}</h2>
        <p>首次选择后会记住。可自行修改一次，之后需联系管理员。</p>
        <p v-if="userStore.isLoggedIn && userStore.user?.dormBuilding">剩余自行修改次数：{{ dorm.changesRemaining }}</p>
        <div class="dorm-options">
          <button v-for="building in dorm.buildings" :key="building.code" type="button" :class="{ chosen: dorm.code === building.code }" :disabled="dorm.saving || userStore.isLoggedIn && userStore.user?.dormBuilding && dorm.changesRemaining <= 0 && building.code !== userStore.user.dormBuilding" @click="selectDorm(building.code)">
            {{ building.name }}<span v-if="dorm.code === building.code"> ✓</span>
          </button>
        </div>
        <p v-if="!dorm.buildings.length">暂无启用的住宿楼，请联系管理员。</p>
        <p v-if="dorm.saving">正在保存…</p>
      </section>
    </van-popup>

    <!-- 底部 tab：未登录只开放「看板」，其它点了先引导登录（不建临时身份） -->
    <van-tabbar v-if="!route.meta.full" :model-value="activeTab" safe-area-inset-bottom @change="onTab">
      <van-tabbar-item name="/" icon="orders-o">看板</van-tabbar-item>
      <van-tabbar-item name="/task" icon="clock-o">我的洗衣</van-tabbar-item>
      <van-tabbar-item name="/board" icon="comment-o">留言</van-tabbar-item>
      <van-tabbar-item name="/settings" icon="setting-o">设置</van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<script setup>
import { computed, watch, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { api } from './api'
import AnnouncementSplash from './components/AnnouncementSplash.vue'
import QueueNotices from './components/QueueNotices.vue'
import ChannelMentions from './components/ChannelMentions.vue'
import InspectionShortcut from './components/InspectionShortcut.vue'
import { useUserStore } from './stores/user'
import { useDormStore } from './stores/dorm'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const dorm = useDormStore()
const showDormPicker = computed(() => route.name !== 'login' && !route.path.startsWith('/admin') && userStore.ready && (!dorm.code || dorm.showPicker))

async function selectDorm(code) {
  try { await dorm.select(code) }
  catch(e) { showToast(e?.message || '住宿楼保存失败，请重试') }
}

watch(() => [userStore.ready, userStore.user?.id, userStore.user?.dormBuilding, userStore.isLoggedIn], () => dorm.reconcile(), { immediate: true })
watch(() => [dorm.code, route.name], () => {
  if (dorm.code && dorm.code !== 'guiyuan' && route.name === 'room3d') router.replace('/list')
}, { immediate: true })

// 登录页 / 大屏 / 管理页不显示（大屏是公开展示，管理页有自己的口令）
const showLoginBar = computed(
  () => !userStore.isLoggedIn && !route.meta.full && route.name !== 'login'
)

function goLogin() {
  router.push({ path: '/login', query: route.fullPath !== '/' ? { to: route.fullPath } : {} })
}

// 未登录：只让看板；点其它 tab 先去登录。
// 以前点「设置」会自动建一个临时匿名账号（青柠君那种），现在这条路堵死了。
const activeTab = computed(() => {
  const p = route.path
  return ['/', '/task', '/board', '/settings'].includes(p) ? p : '/'
})

function onTab(name) {
  const needLogin = name !== '/'
  if (needLogin && !userStore.isLoggedIn) {
    showToast('先登录才能用')
    router.push({ path: '/login', query: { to: name } })
    return
  }
  if (name !== route.path) router.push(name)
}

// ── 取衣确认弹窗 ──
// 「洗完 3 小时内打开应用」时问一句「取到了吗」，点「我已取衣」就标记完成。
// 只在 3 小时内问：超过 3 小时基本是忘了点，再弹就是打扰。
const TAKE_WINDOW_MIN = 180
const checked = ref(false)

async function checkTakeConfirm() {
  if (checked.value || !userStore.isLoggedIn || route.path === '/task' || route.meta.full) return
  checked.value = true
  try {
    const d = await api('/api/tasks')
    const list = Array.isArray(d?.tasks) ? d.tasks : []
    // 挑最早结束、且还在 3 小时窗口内的那条
    const pending = list
      .filter((t) => !t.done && Number(t.overdueMin) > 0 && Number(t.overdueMin) <= TAKE_WINDOW_MIN)
      .sort((a, b) => Number(a.overdueMin) - Number(b.overdueMin))[0]
    if (!pending) return
    // 同一条任务本次会话只问一次（用户点「还没取」后别反复弹）
    const key = 'ws_take_asked'
    if (sessionStorage.getItem(key) === pending.id) return
    sessionStorage.setItem(key, pending.id)

    const over = Number(pending.overdueMin)
    const when = over < 60 ? `${over} 分钟前` : `${Math.floor(over / 60)} 小时前`
    await showConfirmDialog({
      title: '衣服取到了吗？',
      message: `${pending.machineName || pending.machineId} 的登记计时在${when}结束，衣物取到了吗？`,
      confirmButtonText: '我已取衣',
      cancelButtonText: '还没取',
    })
    await api(`/api/tasks/${pending.id}/take`, { method: 'POST' })
    showToast('已标记完成')
  } catch {
    /* 用户点「还没取」或接口失败都不打扰 */
  }
}

// 登录态就绪后再检查一次（刷新页面时 bootstrap 是异步的）
watch(
  () => userStore.isLoggedIn,
  (v) => {
    if (v) checkTakeConfirm()
  },
  { immediate: true }
)
</script>

<style scoped>
.app-root.room-layout { height:100vh; height:100dvh; display:flex; flex-direction:column; }
.room-layout :deep(.room-page) { flex:1; min-height:0; height:auto; }
.login-bar, .dorm-bar { flex:none; }
.login-bar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  background: rgba(37, 99, 235, 0.16);
  border-bottom: 1px solid rgba(59, 130, 246, 0.35);
  cursor: pointer;
}
.login-bar-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #cfe3f7;
}
.login-bar-btn {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: #9fd7ff;
  border: 1px solid rgba(125, 211, 252, 0.5);
  background: rgba(125, 211, 252, 0.14);
  border-radius: 999px;
  padding: 3px 12px;
}
.login-bar:active .login-bar-btn {
  background: rgba(125, 211, 252, 0.3);
}
.dorm-bar { display:flex; width:100%; align-items:center; justify-content:space-between; padding:9px 16px; border:0; border-bottom:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:13px; cursor:pointer; }
.dorm-bar span:last-child { color:#93c5fd; }
.dorm-wait { padding:60px 20px; text-align:center; color:var(--text-dim); }
.dorm-picker { padding:24px 20px calc(28px + env(safe-area-inset-bottom)); background:var(--bg-card); color:var(--text); }
.dorm-picker h2 { margin:0 0 8px; font-size:20px; }
.dorm-picker p { margin:0 0 20px; color:var(--text-dim); font-size:13px; }
.dorm-options { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.dorm-options button { padding:18px; border:1px solid var(--border); border-radius:12px; color:var(--text); background:var(--bg); font-size:17px; cursor:pointer; }
.dorm-options button.chosen { color:#93c5fd; border-color:#3b82f6; background:rgba(59,130,246,.14); }
</style>
