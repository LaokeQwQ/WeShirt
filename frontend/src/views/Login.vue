<template>
  <div class="page login">
    <div class="login-card card">
      <div class="logo">等衣</div>
      <h1>用钉钉登录</h1>
      <p class="text-dim desc">
        登录后才能在 3D 洗衣房里登记、排队、留言，衣服洗完也会通过钉钉提醒你。
      </p>

      <van-button
        class="ding-btn"
        block
        type="primary"
        :loading="loading"
        loading-text="正在跳转…"
        @click="login"
      >
        钉钉登录
      </van-button>

      <p v-if="err" class="err">{{ err }}</p>
      <p v-if="trace" class="text-dim login-trace">{{ trace }}</p>

      <div class="tips text-dim">
        <div>· 用的是你手机钉钉里的企业身份，不需要额外注册</div>
        <div>· 登录一次后，这台设备会自动记住</div>
        <div>· 换手机重新登录即可，数据都在云端</div>
      </div>
    </div>

    <div class="guest">
      <button class="guest-btn" @click="skip">先随便看看（不登录）</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { startDingLogin, claimCode } from '../api'
import { useUserStore } from '../stores/user'
import { safeLoginTarget, canAutoDingLogin } from '../loginFlow'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const loading = ref(false)
const err = ref('')
const trace = ref('')
let disposed = false, loginGeneration = 0
onUnmounted(() => { disposed = true; loginGeneration++ })
watch(() => route.fullPath, () => { loginGeneration++; loading.value = false })

const ERR_MSG = {
  claim_failed: '登录凭证兑换失败，请重新登录',
  missing: '授权回调缺少参数，请重新登录',
  state_invalid: '授权已过期，请重新登录',
  state_used: '本次授权已使用，请重新点击钉钉登录',
  state_processing: '本次授权正在处理，请稍后重新点击钉钉登录',
  code_expired: '授权码已失效或已使用，请重新点击钉钉登录',
  not_configured: '钉钉登录配置未完成，请联系管理员',
  module: '钉钉模块未就绪，请联系管理员',
  token: '换取登录凭证失败，请重新点击钉钉登录；仍失败时请提供下方事件编号',
  profile: '读取钉钉资料失败，请重试',
  no_userid: '换不到你的企业内钉钉 userId，请确认已加入组织并开通讯录权限',
  error: '登录过程出错，请重试',
}

function targetPath() {
  return safeLoginTarget(route.query.to || sessionStorage.getItem('ws_login_to'))
}

watch(()=>userStore.ready && userStore.isLoggedIn,(loggedIn)=>{
  if(loggedIn)router.replace(targetPath())
})
watch(()=>userStore.ready,()=>tryAutomaticLogin())

function tryAutomaticLogin() {
  if (loading.value || route.query.k || !canAutoDingLogin({userAgent:navigator.userAgent,ready:userStore.ready,loggedIn:userStore.isLoggedIn,hasError:Boolean(route.query.e || err.value),session:sessionStorage,local:localStorage})) return
  try { sessionStorage.setItem('ws_ding_auto_attempt','1') } catch { return }
  login(true)
}

onMounted(async () => {
  // 从钉钉授权跳回来：带着一次性取回码，换 token
  const k = route.query.k
  if (k) {
    loading.value = true
    try {
      const data = await claimCode(String(k))
      userStore.applyUser(data.user)
      userStore.token = data.token
      router.replace(targetPath())
      return
    } catch (e) {
      err.value = e?.message || '登录已过期，请重新登录'
    } finally {
      loading.value = false
    }
  }
  // 授权失败跳回来：带 e=<flag>
  const e = route.query.e
  if (e) {
    err.value = ERR_MSG[String(e).split(':')[0]] || '登录失败，请重新点击钉钉登录'
    const eventId=route.query.eventId,status=Number(route.query.status)
    if(typeof eventId==='string' && /^(?:evt|client)_[a-f0-9]{24}$/.test(eventId) && typeof route.query.status==='string' && Number.isInteger(status) && (status===0 || status>=100 && status<=599))trace.value=`事件 ${eventId} · 状态码 ${status}`
  }

  // 已经有登录态就直接进站
  if (userStore.isLoggedIn) router.replace(targetPath())
  else tryAutomaticLogin()
})

async function login(automatic = false) {
  if (loading.value) return
  const request = ++loginGeneration
  err.value = ''
  trace.value = ''
  loading.value = true
  try {
    if (automatic !== true) {
      localStorage.removeItem('ws_ding_auto_disabled')
      sessionStorage.removeItem('ws_ding_guest')
      sessionStorage.setItem('ws_ding_auto_attempt','1')
    }
    const to = String(route.query.to || '')
    sessionStorage.setItem('ws_login_to', safeLoginTarget(to))
    await startDingLogin({ canRedirect: () => !disposed && request === loginGeneration })
    // 成功会整页跳走，这里不用收尾
  } catch (e) {
    if (disposed || request !== loginGeneration) return
    err.value = e?.message || '无法发起登录'
    loading.value = false
  }
}

function skip() {
  loginGeneration++
  try { sessionStorage.setItem('ws_ding_guest','1') } catch { /* Browsing as a guest remains available. */ }
  router.replace('/')
}
</script>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 24px 16px 32px;
}
.login-card {
  padding: 28px 20px 22px;
  text-align: center;
}
.logo {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 4px;
  color: #eaf2fb;
  margin-bottom: 4px;
}
h1 {
  margin: 10px 0 6px;
  font-size: 19px;
  font-weight: 700;
  color: #eaf2fb;
}
.desc {
  font-size: 13px;
  line-height: 1.7;
  margin: 0 0 20px;
}
.ding-btn {
  height: 46px;
  font-size: 16px;
  font-weight: 600;
  border-radius: 12px;
}
.err {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: #ffb0b0;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 10px;
  padding: 9px 12px;
  text-align: left;
}
.tips {
  margin-top: 20px;
  text-align: left;
  font-size: 12px;
  line-height: 1.9;
}
.guest {
  margin-top: 18px;
  text-align: center;
}
.guest-btn {
  background: none;
  border: none;
  color: #7d8ea3;
  font-size: 13px;
  padding: 8px 12px;
  cursor: pointer;
}
.guest-btn:active {
  color: #9fd7ff;
}
</style>
