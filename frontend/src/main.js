import './browserCompatibility'

// 应用入口：挂载 Vue + Pinia + Router + Vant
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Vant from 'vant'
import 'vant/lib/index.css'
import './styles.css'
import App from './App.vue'
import router from './router'
import { useUserStore } from './stores/user'
import { setToken, onNeedLogin, claimCode, restoreDeviceSession } from './api'
import { initTelemetry } from './telemetry'
import { useDormStore } from './stores/dorm'
import { safeLoginTarget, canAutoDingLogin } from './loginFlow'

/**
 * 钉钉登录回调会带着一次性取回码跳回来（#/login?k=xxx）。
 * 这个码必须在**首屏渲染之前**换掉：否则用户会先看到登录页、再被弹走，
 * 观感就是「点了授权回来卡了一下」。换完顺手把 k 从地址栏抹掉
 * （码是一次性的，留着刷新会报「已使用」）。
 */
async function preclaim() {
  const hash = location.hash || ''
  const [path, query = ''] = hash.slice(1).split('?')
  if (path !== '/login') return false
  const params = new URLSearchParams(query)
  const code = params.get('k')
  if (!code) return false
  const target = safeLoginTarget(params.get('to') || sessionStorage.getItem('ws_login_to'))
  sessionStorage.removeItem('ws_login_to')
  // 无论成功失败都消费URL参数，避免挂载登录页后重复兑换。
  history.replaceState(null, '', location.pathname + location.search + '#/login')
  try {
    const data = await claimCode(code)
    history.replaceState(null, '', location.pathname + location.search + '#' + target)
    return data
  } catch (error) {
    // A refreshed OAuth callback can carry an already-consumed claim. Restore
    // only this browser's bound device; never make the claim reusable.
    try {
      const data=await restoreDeviceSession({silent:true})
      history.replaceState(null, '', location.pathname + location.search + '#' + target)
      return data
    } catch { /* A new/unbound device still needs a fresh authorization. */ }
    const failed=new URLSearchParams({e:'claim_failed',to:target})
    if(/^(?:evt|client)_[a-f0-9]{24}$/.test(error?.eventId||'') && Number.isInteger(error?.status) && (error.status===0 || error.status>=100 && error.status<=599)){
      failed.set('eventId',error.eventId);failed.set('status',String(error.status))
    }
    history.replaceState(null, '', location.pathname + location.search + '#/login?' + failed)
    return false
  }
}

async function boot() {
  // 先换码再挂载：目标环境不支持顶层 await，所以整体包一层 async 函数
  const claimed = await preclaim()

  const app = createApp(App)
  app.use(createPinia())
  // Hydrate the claimed identity before router installation/first navigation.
  // Both the router and first render need the profile, not only the saved token.
  const userStore = useUserStore()
  userStore.init()
  if (claimed) {
    userStore.token = claimed.token
    userStore.applyUser(claimed.user)
    userStore.ready = true
  }
  setToken(userStore.token)
  // Router history was constructed when modules loaded, before preclaim changed
  // native history. Synchronize it so initial navigation cannot replay old ?k.
  const initialPath=(location.hash||'#/').slice(1)
  router.options.history.replace(initialPath)
  // A device-only visit to a protected page must recover before its guard runs.
  // Public pages retain their immediate first render and recover below.
  let bootstrapped=false
  const requested=router.resolve(initialPath)
  if(!claimed && !userStore.isLoggedIn && requested.meta.login){
    await userStore.bootstrap()
    bootstrapped=true
  }
  app.use(router)
  app.use(Vant) // 全量注册 Vant 4 组件
  initTelemetry({ router, getDorm: () => useDormStore().code, app })
  app.mount('#app')
  if ('serviceWorker' in navigator && window.isSecureContext) {
    const register=()=>navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{})
    if(document.readyState==='complete')register()
    else window.addEventListener('load',register,{once:true})
  }

  // 任何需要登录的请求在未登录时，统一带去登录页并记住回跳目标
  onNeedLogin(() => {
    const cur = router.currentRoute.value
    if (cur.path === '/login') return
    router.replace({ path: '/login', query: cur.fullPath !== '/' ? { to: cur.fullPath } : {} })
  })

  // 启动时恢复登录态：先用本地 token 拉 /me，没有就用设备密钥续用。
  // 身份只能来自钉钉登录，所以「续不上」是正常情况（新设备/退出登录），
  // 不做任何自动注册，交给路由守卫引导到登录页。
  useDormStore().loadSite()

  // token 与 store 对齐：api.js 模块里缓存了 token，store 从 localStorage 读，
  // 两者必须在启动时同步一次，否则首次请求会漏带 Authorization。
  const maybeOpenDingLogin = async () => {
    // Initial guards may still be redirecting a protected URL to /login?to=….
    // Wait for that navigation instead of replacing its target with START_LOCATION.
    try { await router.isReady() } catch { return }
    const cur=router.currentRoute.value
    if(cur.path!=='/login' && canAutoDingLogin({userAgent:navigator.userAgent,ready:userStore.ready,loggedIn:userStore.isLoggedIn,session:sessionStorage,local:localStorage})) {
      await router.replace({path:'/login',query:{to:safeLoginTarget(cur.fullPath)}})
    }
  }
  if (!claimed && !bootstrapped) userStore.bootstrap().then(maybeOpenDingLogin).catch(() => console.warn('恢复登录态失败，请稍后重试'))
  else if (!claimed) maybeOpenDingLogin()
}

boot()
