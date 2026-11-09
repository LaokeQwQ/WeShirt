// 应用入口：挂载 Vue + Pinia + Router + Vant
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Vant from 'vant'
import 'vant/lib/index.css'
import './styles.css'
import App from './App.vue'
import router from './router'
import { useUserStore } from './stores/user'
import { setToken, onNeedLogin, claimCode } from './api'
import { initTelemetry } from './telemetry'
import { useDormStore } from './stores/dorm'
import { safeLoginTarget } from './loginFlow'

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
    await claimCode(code)
    history.replaceState(null, '', location.pathname + location.search + '#' + target)
    return true
  } catch {
    history.replaceState(null, '', location.pathname + location.search + '#/login?e=claim_failed&to=' + encodeURIComponent(target))
    return false
  }
}

async function boot() {
  // 先换码再挂载：目标环境不支持顶层 await，所以整体包一层 async 函数
  const claimed = await preclaim()

  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.use(Vant) // 全量注册 Vant 4 组件
  initTelemetry({ router, getDorm: () => useDormStore().code, app })
  app.mount('#app')
  if ('serviceWorker' in navigator && window.isSecureContext) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', {updateViaCache:'none'}).catch(()=>{}), {once:true})

  // 任何需要登录的请求在未登录时，统一带去登录页并记住回跳目标
  onNeedLogin(() => {
    const cur = router.currentRoute.value
    if (cur.path === '/login') return
    router.replace({ path: '/login', query: cur.fullPath !== '/' ? { to: cur.fullPath } : {} })
  })

  // 启动时恢复登录态：先用本地 token 拉 /me，没有就用设备密钥续用。
  // 身份只能来自钉钉登录，所以「续不上」是正常情况（新设备/退出登录），
  // 不做任何自动注册，交给路由守卫引导到登录页。
  const userStore = useUserStore()
  userStore.init()
  useDormStore().loadSite()

  // token 与 store 对齐：api.js 模块里缓存了 token，store 从 localStorage 读，
  // 两者必须在启动时同步一次，否则首次请求会漏带 Authorization。
  setToken(userStore.token)

  if (claimed) userStore.ready = true
  else userStore.bootstrap().catch((e) => console.warn('恢复登录态失败：', e?.message || e))
}

boot()
