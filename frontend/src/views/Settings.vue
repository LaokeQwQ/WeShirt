<template>
  <div class="page settings">
    <van-nav-bar title="设置" />

    <van-cell-group inset title="资料与账号" class="account-group">
      <div class="profile">
        <div class="profile-head">
          <button class="avatar-edit" type="button" aria-label="更换头像" :aria-busy="avatarBusy" :disabled="avatarBusy" @click="showAvatarActions = true">
            <Avatar :name="nick" :src="avatarUrl" :size="56" />
            <van-icon name="edit" class="avatar-edit-icon" />
          </button>
          <div class="profile-head-meta">
            <div class="profile-name">{{ nick || '还没起名' }}</div>
            <div class="profile-avatar-tip">{{ avatarBusy ? '正在更新头像…' : '点击头像更换' }}</div>
          </div>
        </div>
        <input ref="fileInput" type="file" accept="image/*" class="file-input" @change="onFilePicked" />
        <div class="profile-row">
          <input v-model="nick" class="nick-input" aria-label="昵称" maxlength="16" placeholder="昵称（1-16 字）" />
          <div class="profile-editor-actions">
            <van-button size="small" plain class="random-nick-btn" :disabled="profileSaving" @click="rollNick">随机昵称</van-button>
            <van-button size="small" type="primary" :loading="profileSaving" @click="saveProfile">保存</van-button>
          </div>
        </div>
        <div class="profile-tip">昵称点击保存后生效 · 留言板/排队里别人看到的是 {{ maskedPreview }}</div>
      </div>
      <van-cell title="住宿楼" :value="dorm.name || '选择住宿楼'" :label="!user?.dormBuilding ? '首次选择后自动记住，之后可自行修改一次' : dorm.changesRemaining > 0 ? `还可自行修改 ${dorm.changesRemaining} 次` : '自行修改次数已用完，需要调整请联系管理员'" :is-link="!user?.dormBuilding || dorm.changesRemaining > 0" @click="(!user?.dormBuilding || dorm.changesRemaining > 0) && (dorm.showPicker = true)" />
      <van-cell
        title="钉钉账号"
        :value="user?.dingNick || (user?.dingUserId ? '已登录' : '—')"
        :label="user?.dingUserId ? '取衣提醒会发到这个钉钉' : '未获取到钉钉身份'"
      />
      <van-cell title="手机号" :value="user?.mobile || '—'" />
      <van-cell class="logout-cell">
        <template #title>
          <button class="logout-btn" type="button" :disabled="loggingOut" @click="doLogout">
            {{ loggingOut ? '退出中…' : '退出登录' }}
          </button>
        </template>
      </van-cell>
    </van-cell-group>

    <!-- 通知 -->
    <van-cell-group inset title="通知">
      <van-cell title="接收开屏公告" label="关闭后不再弹出公告"><template #value><van-switch :model-value="announcementsOn" :loading="announcementSaving" @update:model-value="setAnnouncements" /></template></van-cell>
      <van-cell title="Web Push 订阅">
        <template #value>
          <van-button size="small" :loading="pushLoading" @click="subscribePush">{{ pushText }}</van-button><van-button v-if="pushSubscribed" size="small" plain :loading="pushLoading" @click="unsubscribePush">关闭</van-button>
        </template>
      </van-cell>
      <van-cell title="iPhone 怎么开通知" class="ios-guide-cell">
        <template #label>
          <ol class="ios-guide">
            <li>用 <b>Safari</b> 打开本站（钉钉、微信或 QQ 内置浏览器不支持此方式）</li>
            <li>点底部「分享」→「<b>添加到主屏幕</b>」</li>
            <li>从<b>主屏幕图标</b>打开（不是 Safari 标签页）</li>
            <li>回来点上面的「开启通知」，弹窗选<b>允许</b></li>
          </ol>
        </template>
      </van-cell>
      <van-cell title="取衣提醒" :label="notifyLabel">
        <template #value>
          <van-switch :model-value="notifyOn" :loading="notifySaving" @update:model-value="setNotify" />
        </template>
      </van-cell>
      <van-cell v-if="notifyOn" title="提前提醒时间">
        <template #value>
          <div class="lead-opts">
            <span
              v-for="m in LEADS"
              :key="m"
              class="lead-opt"
              :class="{ on: notifyLead === m }"
              @click="setLead(m)"
              >{{ m === 0 ? '洗完' : m + ' 分钟' }}</span
            >
          </div>
        </template>
      </van-cell>
      <van-cell
        title="发一条测试提醒"
        label="给自己发一次：钉钉私聊 + 浏览器推送"
      >
        <template #value>
          <van-button size="small" :loading="testLoading" @click="sendTest">发送</van-button>
        </template>
      </van-cell>
      <div v-if="testResult" class="test-result" :class="{ bad: !testResult.ok }">
        <div>{{ testResult.hint }}</div>
        <div class="test-detail">
          钉钉：{{ testResult.dm?.ok ? '已送达' : testResult.dm?.skipped ? '未绑定' : testResult.dm?.err || '失败' }}
          <br />
          推送：{{ testResult.push?.ok ? '已送达' : testResult.push?.err || '失败' }}
        </div>
      </div>
    </van-cell-group>

    <van-cell-group inset title="隐私" class="privacy-group">
      <van-cell title="匿名性能数据" label="收集页面耗时、错误类别和3D性能，保留14天；不含身份和消息"><template #value><van-switch :model-value="telemetryOn" :disabled="dnt" @update:model-value="setTelemetry" /></template></van-cell>
    </van-cell-group>

    <FavoriteSettings />

    <van-cell-group inset title="朋友与代取" class="collaboration-group">
      <van-cell title="朋友与代取" label="添加好友、私聊和请求代取衣物" is-link to="/social" class="settings-destination settings-social">
        <template #icon><van-icon name="friends-o" class="destination-icon" /></template>
      </van-cell>
      <van-cell title="洗衣助手" label="问机器状态，管理自己的洗衣偏好" is-link to="/assistant" class="settings-destination settings-assistant">
        <template #icon><van-icon name="chat-o" class="destination-icon" /></template>
      </van-cell>
    </van-cell-group>

    <van-cell-group v-if="adminVisible" inset title="管理"><van-cell title="管理员后台" is-link @click="goAdmin" /></van-cell-group>
    <AboutDonation />
    <van-action-sheet v-model:show="showAvatarActions" title="更换头像" :actions="avatarActions" cancel-text="取消" close-on-click-action @select="selectAvatarAction" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { api, NEED_LOGIN } from '../api'
import { useUserStore } from '../stores/user'
import { useDormStore } from '../stores/dorm'
import Avatar from '../components/Avatar.vue'
import AboutDonation from '../components/AboutDonation.vue'
import FavoriteSettings from '../components/FavoriteSettings.vue'
import { findBannedWord } from '../nick'
import { telemetryEnabled, setTelemetryEnabled } from '../telemetry'
import { randomNickExcept } from '../../../packages/core/profile.js'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const dorm = useDormStore()
const user = computed(() => userStore.user)
let disposed = false
const adminVisible = ref(false)
let permissionsGeneration = 0
async function loadPermissions() {
  const uid = userStore.user?.id
  const request = ++permissionsGeneration
  if (!uid) { adminVisible.value = false; return }
  try {
    const result = await api('/api/user/permissions', { auth: 'optional', silent: true })
    if (!disposed && request === permissionsGeneration && uid === userStore.user?.id) adminVisible.value = result.adminVisible === true
  } catch { if (!disposed && request === permissionsGeneration) adminVisible.value = false }
}
function onPermissionsVisible() { if (document.visibilityState === 'visible') loadPermissions() }
watch(() => userStore.user?.id, () => { permissionsGeneration++; adminVisible.value = false; loadPermissions() })
onMounted(() => { loadPermissions(); document.addEventListener('visibilitychange', onPermissionsVisible) })
onUnmounted(() => { disposed = true; permissionsGeneration++; document.removeEventListener('visibilitychange', onPermissionsVisible) })

const pushLoading = ref(false)
const pushText = ref('开启通知')
const pushSubscribed=ref(false)
const announcementsOn=ref(true),announcementSaving=ref(false)
const telemetryOn=ref(telemetryEnabled()),dnt=navigator.doNotTrack==='1'
function setTelemetry(on){setTelemetryEnabled(on);telemetryOn.value=telemetryEnabled()}
async function setAnnouncements(on){announcementSaving.value=true;try{const d=await api('/api/user/announcements',{method:'PATCH',body:{enabled:on}});announcementsOn.value=d.enabled;localStorage.setItem(`ws_announcements:${user.value?.id||'guest'}`,JSON.stringify(d))}catch(e){showToast(e.message)}finally{announcementSaving.value=false}}
onMounted(async()=>{try{announcementsOn.value=(await api('/api/user/announcements')).enabled}catch{};try{const reg=await navigator.serviceWorker?.getRegistration();const sub=await reg?.pushManager?.getSubscription();pushSubscribed.value=!!sub;pushText.value=sub?'重新同步订阅':Notification.permission==='denied'?'通知已被浏览器阻止':'开启通知'}catch{}})
async function unsubscribePush(){if(pushLoading.value)return;pushLoading.value=true;try{const reg=await navigator.serviceWorker.getRegistration();const sub=await reg?.pushManager.getSubscription();if(sub){await api('/api/push/unsubscribe',{method:'POST',body:{endpoint:sub.endpoint}});await sub.unsubscribe()}pushSubscribed.value=false;pushText.value='开启通知';showToast('浏览器通知已关闭')}catch(e){showToast(e.message)}finally{pushLoading.value=false}}


const LEADS = [0, 3, 5, 10]
const notifyOn = ref(userStore.user?.notifyOn !== false)
const notifyLead = ref(LEADS.includes(userStore.user?.notifyLeadMin) ? userStore.user.notifyLeadMin : 0)
const notifySaving = ref(false)
const notifyLabel = computed(() =>
  notifyOn.value
    ? notifyLead.value === 0
      ? '洗完立刻提醒（站内 + 已订阅的推送）'
      : `还剩 ${notifyLead.value} 分钟时提醒`
    : '已关闭，洗完不会提醒你'
)

// 测试提醒：发一条真实的取衣通知（钉钉卡片 + Web Push），
// 让用户自己确认「没收到提醒」是设置问题还是通道问题
const testLoading = ref(false)
const testResult = ref(null)
async function sendTest() {
  if (testLoading.value) return
  testLoading.value = true
  testResult.value = null
  try {
    const r = await api('/api/user/test-notify', { method: 'POST', body: {} })
    testResult.value = r
    showToast(r?.hint || '已发送')
  } catch (e) {
    if (e?.message === NEED_LOGIN) {
      router.replace({ path: '/login', query: { to: '/settings' } })
    } else {
      showToast(e?.message || '发送失败')
      testResult.value = { ok: false, hint: e?.message || '发送失败', dm: {}, push: {} }
    }
  } finally {
    testLoading.value = false
  }
}

// 资料编辑：昵称 + 头像（头像只有两种来源：钉钉/上传图片，或昵称首字）
const nick = ref(userStore.user?.nick || '')
const avatarUrl = ref(userStore.user?.avatarUrl || '')
const profileSaving = ref(false)
const fileInput = ref(null)
const dingAvatarLoading = ref(false)
const avatarSaving = ref(false)
const avatarBusy = computed(() => dingAvatarLoading.value || avatarSaving.value)
const showAvatarActions = ref(false)
const avatarActions = computed(() => [
  { name: '用钉钉头像', action: 'dingtalk' },
  { name: '自定义头像', action: 'upload' },
  ...(avatarUrl.value ? [{ name: '移除头像，使用昵称首字', action: 'clear' }] : []),
])
function selectAvatarAction(item) {
  showAvatarActions.value = false
  if (avatarBusy.value) return
  if (item.action === 'dingtalk') return useDingAvatar()
  if (item.action === 'upload') return pickUpload()
  if (item.action === 'clear') return clearAvatar()
}
const maskedPreview = computed(() => {
  const s = (nick.value || '匿名').trim()
  return (s ? [...s][0] : '匿') + '**'
})

// 退出登录：解绑设备密钥，回到登录页
const loggingOut = ref(false)
async function doLogout() {
  if (loggingOut.value) return
  try {
    await showConfirmDialog({
      title: '退出登录？',
      message: '退出后需要重新用钉钉登录，数据不会丢。',
    })
  } catch {
    return
  }
  loggingOut.value = true
  try {
    await userStore.logout()
    router.replace('/login')
  } catch (e) {
    showToast(e?.message || '退出失败')
    loggingOut.value = false
  }
}

// 本地即时预览，不请求或保存资料，也没有迟到响应覆盖手动输入。
function rollNick() {
  if (!profileSaving.value) nick.value = randomNickExcept(nick.value)
}

// 选预设头像 = 放弃自定义图片
function pickUpload() {
  fileInput.value?.click()
}

// 把用户选的图裁成正方形并压到 128px JPEG，几 KB 就够，能直接塞进 KV
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const S = 128
        const c = document.createElement('canvas')
        c.width = S
        c.height = S
        const ctx = c.getContext('2d')
        const side = Math.min(img.width, img.height)
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S)
        URL.revokeObjectURL(url)
        resolve(c.toDataURL('image/jpeg', 0.82))
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(new Error('图片处理失败'))
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败，换一张试试'))
    }
    img.src = url
  })
}

async function onFilePicked(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = '' // 允许连续选同一张
  if (!f || avatarBusy.value) return
  if (f.size > 8 * 1024 * 1024) return showToast('图片太大了，换一张（<8MB）')
  const requestUser = userStore.user?.id
  avatarSaving.value = true
  try {
    const dataUrl = await compressImage(f)
    if (disposed || requestUser !== userStore.user?.id) return
    const saved = await userStore.setAvatarUrl(dataUrl)
    if (!saved || disposed || requestUser !== userStore.user?.id) return
    avatarUrl.value = dataUrl
    showToast('头像已更新')
  } catch (err) {
    showToast(err?.message || '上传失败')
  } finally {
    avatarSaving.value = false
  }
}

async function useDingAvatar() {
  if (avatarBusy.value) return
  const requestUser = userStore.user?.id
  dingAvatarLoading.value = true
  try {
    const r = await userStore.useDingtalkAvatar()
    if (!r || disposed || requestUser !== userStore.user?.id) return
    avatarUrl.value = r?.user?.avatarUrl || ''
    showToast('已使用钉钉头像')
  } catch (e) {
    showToast(e?.message || '获取钉钉头像失败')
  } finally {
    dingAvatarLoading.value = false
  }
}

async function clearAvatar() {
  if (avatarBusy.value) return
  const requestUser = userStore.user?.id
  avatarSaving.value = true
  try {
    const saved = await userStore.setAvatarUrl(null)
    if (!saved || disposed || requestUser !== userStore.user?.id) return
    avatarUrl.value = ''
    showToast('已改回昵称首字')
  } catch (e) {
    showToast(e?.message || '操作失败')
  } finally {
    avatarSaving.value = false
  }
}

async function saveNotify(patch, rollback) {
  notifySaving.value = true
  const requestUser = userStore.user?.id
  try {
    const saved = await userStore.setNotify(patch)
    if (!disposed && saved && requestUser === userStore.user?.id) {
      notifyOn.value = saved.notifyOn !== false
      notifyLead.value = LEADS.includes(saved.notifyLeadMin) ? saved.notifyLeadMin : 0
    }
  } catch (e) {
    if (!disposed && requestUser === userStore.user?.id) { rollback(); showToast(e?.message || '保存失败') }
  } finally {
    notifySaving.value = false
  }
}

function setNotify(on) {
  const prev = notifyOn.value
  notifyOn.value = on
  saveNotify({ on }, () => { notifyOn.value = prev })
}

function setLead(m) {
  if (m === notifyLead.value || notifySaving.value) return
  const prev = notifyLead.value
  notifyLead.value = m
  saveNotify({ leadMin: m }, () => { notifyLead.value = prev })
}

async function saveProfile() {
  if (profileSaving.value) return
  const n = nick.value.trim()
  if (!n) {
    showToast('昵称不能为空')
    return
  }
  // 先说清楚错在哪：服务端还会再拦一次（不能只靠前端）
  const bad = findBannedWord(n)
  if (bad) {
    showToast(`昵称里有「${bad}」，换一个吧`)
    return
  }
  profileSaving.value = true
  try {
    // 头像操作单独保存；改昵称不携带可能过时的头像。
    const saved = await userStore.setProfile({ nick: n })
    if (!saved || disposed) return
    showToast('已保存')
  } catch (e) {
    showToast(e?.message || '保存失败')
  } finally {
    profileSaving.value = false
  }
}

// 带超时的 Promise，避免任何一步卡死就永远转圈
function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms)})]).finally(()=>clearTimeout(timer))
}

// Web Push 订阅：每一步都有超时上限，失败一定给出可读原因
async function subscribePush() {
  if (pushLoading.value) return
  pushLoading.value = true
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('当前环境不支持推送（iOS 需先添加到主屏幕）')
    }
    if (!window.isSecureContext) throw new Error('需要 HTTPS 环境')

    // 先拿公钥：没有公钥就别去申请系统权限，免得用户点了同意却永远失败
    const key = await vapidPublic()
    if (!key) throw new Error('服务端未配置推送密钥（VAPID）')

    if(Notification.permission==='denied')throw new Error('通知已被浏览器阻止，请在站点权限中允许后重试')
    const permission = Notification.permission==='granted'?'granted':await withTimeout(Notification.requestPermission(), 20000, '等待授权超时')
    if (permission !== 'granted') throw new Error('通知权限未开启')

    // 注册 SW：失败要立刻报错，不能 fallback 到 ready（那会无限等）
    let reg = null
    try {
      reg = await withTimeout(navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}), 15000, 'Service Worker 注册超时')
    } catch (e) {
      throw new Error('Service Worker 注册失败：' + (e?.message || e))
    }
    const sw = reg || (await withTimeout(navigator.serviceWorker.ready, 15000, 'Service Worker 未就绪'))

    const existing = await sw.pushManager.getSubscription()
    const sub = existing || await withTimeout(
      sw.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      }),
      20000,
      '浏览器订阅超时'
    )

    await userStore.ensureAuth()
    await withTimeout(
      api('/api/push/subscribe', {
        method: 'POST',
        body: { subscription: sub.toJSON ? sub.toJSON() : sub }
      }),
      15000,
      '保存订阅超时'
    )
    pushText.value = '重新同步订阅'
    pushSubscribed.value = true
    showToast('订阅成功，洗完会提醒你')
  } catch (e) {
    showToast('订阅失败：' + (e?.message || e))
  } finally {
    pushLoading.value = false
  }
}

// VAPID 公钥：优先页面注入，其次问后端（后端没配就返回空）
let vapidCache = ''
async function vapidPublic() {
  if (window.__VAPID_PUBLIC_KEY__) return window.__VAPID_PUBLIC_KEY__
  if (vapidCache) return vapidCache
  try {
    const data = await withTimeout(api('/api/push/key', { auth: false }), 8000, '获取推送密钥超时')
    vapidCache = data?.key || ''
    return vapidCache
  } catch {
    return ''
  }
}

// PushManager 要求 Uint8Array，而 VAPID 公钥是 base64url
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function goAdmin() { router.push('/admin') }

onMounted(async () => {
  const initial = { userId: userStore.user?.id, nick: nick.value, avatarUrl: avatarUrl.value, notifyOn: notifyOn.value, notifyLead: notifyLead.value }
  try {
    const u = await userStore.me()
    if (!u || disposed || userStore.user?.id !== initial.userId) return
    if (notifyOn.value === initial.notifyOn) notifyOn.value = u.notifyOn !== false
    if (notifyLead.value === initial.notifyLead) notifyLead.value = LEADS.includes(u.notifyLeadMin) ? u.notifyLeadMin : 0
    if (nick.value === initial.nick) nick.value = u.nick || nick.value
    if (avatarUrl.value === initial.avatarUrl) avatarUrl.value = u.avatarUrl || ''
  } catch (e) {
    // 未登录 → 去登录页；其它错误就用本地缓存渲染，不挡设置页
    if (e?.message === NEED_LOGIN) router.replace({ path: '/login', query: { to: '/settings' } })
  }
})
</script>

<style scoped>
.profile {
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.profile-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.profile-head-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.avatar-edit { position: relative; flex: none; padding: 0; border: 0; border-radius: 50%; background: transparent; cursor: pointer; }
.avatar-edit:disabled { opacity: .6; cursor: wait; }
.avatar-edit-icon { position: absolute; right: -3px; bottom: -2px; padding: 4px; border-radius: 50%; background: #164e63; color: #d4f1fc; font-size: 13px; border: 2px solid var(--surface, #172332); }
.profile-avatar-tip { color: var(--text-dim, #94a3b8); font-size: 12px; }
.file-input {
  display: none;
}
.profile-name {
  font-size: 16px;
  font-weight: 700;
  color: #e8f0fb;
}
.profile-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.nick-input {
  flex: 1 1 150px;
  min-width: 0;
  background: rgba(148, 163, 184, 0.1);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  color: #e8f0fb;
  font-size: 13px;
  padding: 8px 10px;
  outline: none;
}
.nick-input:focus-visible { border-color: #7dd3fc; box-shadow: 0 0 0 2px #7dd3fc22; }
.profile-editor-actions { display: flex; gap: 8px; margin-left: auto; }
.profile-editor-actions :deep(.van-button) { min-height: 36px; }
.profile-editor-actions :deep(.random-nick-btn) { color: #c5e4fa; background: #17324a; border-color: #456789; }
.logout-cell { padding-top: 24px; padding-bottom: 16px; }
.logout-cell::after { display: none; }
.settings :deep(.van-cell-group__title) { padding-top: 24px; font-weight: 600; letter-spacing: .02em; }
.settings :deep(.van-cell__value) { min-width: 0; overflow-wrap: anywhere; }
.settings-destination { min-height: 72px; align-items: center; }
.destination-icon { display: grid; place-items: center; width: 38px; height: 38px; margin-right: 12px; border: 1px solid; border-radius: 10px; font-size: 21px; }
.settings-social .destination-icon { color: #a5e5c9; border-color: #335f52; background: #15342d; }
.settings-assistant .destination-icon { color: #a4dcf5; border-color: #365c75; background: #142f45; }
.avatar-edit:focus-visible, .logout-btn:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 3px; }
.profile-tip {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim, #94a3b8);
}
.page { padding-bottom: 12px; }

/* PC 上别把设置项拉满整屏 */
@media (min-width: 720px) {
  .settings { max-width: 720px; margin: 0 auto; padding: 0 12px 24px; }
}
.ios-guide {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
  color: #9fb2c6;
}
.ios-guide b { color: #cfe3f7; font-weight: 600; }
.ios-guide-cell { padding-bottom: 10px; }

.logout-btn {
  width: 100%;
  height: 36px;
  border-radius: 10px;
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.12);
  color: #ffb0b0;
  font-size: 14px;
  cursor: pointer;
}
.logout-btn:active { background: rgba(239, 68, 68, 0.24); }
.logout-btn:disabled { opacity: 0.6; }

.test-result {
  padding: 8px 16px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: #b7f0c4;
}
.test-result.bad { color: #ffb0b0; }
.test-detail { color: #8fa2b8; margin-top: 2px; }
.admin-icon { margin-right: 8px; font-size: 18px; color: var(--primary); align-self: center; }
.lead-opts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.lead-opt {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #cbd5e1;
  cursor: pointer;
}
.lead-opt.on {
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.16);
  color: #e8f0fb;
}
</style>
