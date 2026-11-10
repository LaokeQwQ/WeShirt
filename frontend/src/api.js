// 统一请求封装
// - 自动携带 Bearer token
// - 401 时清理失效会话，需要身份的操作引导重新登录
// - 网络异常/业务错误统一抛出，由调用方做兜底 UI

// API 基地址：本地开发直连 8787；生产（EdgeOne）走同源相对路径，避免把 localhost 打进线上包
// 需要时用 VITE_API_BASE 覆盖
import { track, getTelemetryContext } from './telemetry'
import { createSingleFlight } from './loginFlow'

const DEV_BASE = 'http://localhost:8787'
const BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? DEV_BASE : '')

const TOKEN_KEY = 'ws_token'
const UUID_KEY = 'ws_uuid'
const DEVICE_KEY = 'ws_device'
const ADMIN_KEY = 'ws_admin_token' // 旧版：存的是原始口令，已废弃，读到就清掉
const ADMIN_SESSION_KEY = 'ws_admin_session' // 新版：{ session, expAt }
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const NO_IDEMPOTENCY = /^\/api\/(?:auth(?:\/|$)|dingtalk(?:\/|$)|cron(?:\/|$)|telemetry(?:\/|$)|inspections(?:\/|$)|urge\/reveal(?:\/|$))|\/(?:photos?|uploads?)(?:\/|$)/
const newClientEvent = () => 'client_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
const newRequestKey = () => 'req_' + crypto.randomUUID()
const pendingWrites = new Map()

export function apiError(message, { status = 0, eventId, code = '', idempotencyKey, sentinel = false } = {}) {
  const trace = typeof eventId === 'string' && /^(?:evt|client)_[a-f0-9]{24}$/.test(eventId) ? eventId : newClientEvent()
  const text = String(message || '请求未能完成').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)
  const error = new Error(sentinel ? NEED_LOGIN : `${text}（${status ? 'HTTP ' + status : '网络 0'}，事件 ${trace}）`)
  Object.assign(error, { status, eventId: trace, code, ...(idempotencyKey ? { idempotencyKey } : {}) })
  return error
}

async function responseError(res, fallback, extra = {}) {
  const data = await res.json().catch(() => null)
  return apiError(data?.error?.message || fallback, { status: res.status, eventId: res.headers.get('X-Event-ID') || data?.error?.eventId, code: data?.error?.code || '', ...extra })
}

// 后台会话：口令只用来换一张 12 小时的票据，页面不再保存口令本身。
// 过期（或换了浏览器时间）就当作没登录，避免"输一次永久进后台"。
export function getAdminSession() {
  try {
    localStorage.removeItem(ADMIN_KEY) // 清掉历史遗留的明文口令
    const raw = localStorage.getItem(ADMIN_SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!s || !s.session || !Number.isFinite(s.expAt)) {
      localStorage.removeItem(ADMIN_SESSION_KEY)
      return null
    }
    if (Date.now() >= s.expAt) {
      localStorage.removeItem(ADMIN_SESSION_KEY)
      return null
    }
    return s
  } catch {
    return null
  }
}

export function setAdminSession(session, expAt) {
  try {
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({ session, expAt }))
    localStorage.removeItem(ADMIN_KEY)
  } catch {
    /* 隐私模式写不进去：本次会话仍可用，只是刷新后要重新登录 */
  }
}

export function clearAdminSession() {
  try {
    localStorage.removeItem(ADMIN_SESSION_KEY)
    localStorage.removeItem(ADMIN_KEY)
  } catch {
    /* 忽略 */
  }
}

// 设备密钥：32 位十六进制随机串，只存在本机。
// 作用：token 丢了（清缓存之外的情况 / 换标签页 / 后端偶发 401）也能续用同一身份，
// 而不是默默给你建一个新匿名用户（那会让用户觉得「我的资料又变了」）。
// 注意不能用 user id 当密钥——那是公开可见的，等于送人冒用身份。
function getDeviceSecret() {
  try {
    let s = localStorage.getItem(DEVICE_KEY)
    if (s && /^[a-f0-9]{32,128}$/i.test(s)) return s.toLowerCase()
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    s = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(DEVICE_KEY, s)
    return s
  } catch {
    return ''
  }
}

// 模块内 token 缓存，避免每次请求都读 localStorage
let token = localStorage.getItem(TOKEN_KEY) || ''
let sessionRevision = 0

// 401 重认证后回调（由 stores/user.js 注册，用于同步 pinia 状态）
let reauthHook = null
export function onReauth(fn) { reauthHook = fn }

// 外部主动设置 token（如 store 初始化时）
export function setToken(t) {
  sessionRevision++
  token = t || ''
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}
export function getToken() { return token }

// 未登录信号：任何需要登录的请求在未登录时抛这个错误，
// 调用方 catch 到就跳登录页（不再默默建匿名身份）。
export const NEED_LOGIN = 'NEED_LOGIN'

// 全局「需要登录」钩子：由 main.js 注册成 router.push('/login')。
// 这样各个页面不用每个 catch 里都写跳转逻辑，漏一处就会被卡住。
let needLoginHook = null
export function onNeedLogin(fn) { needLoginHook = fn }
function fireNeedLogin() {
  try { if (needLoginHook) needLoginHook() } catch { /* 钩子自身出错不影响抛错 */ }
}

// 匿名注册 / 续用身份（契约 POST /api/auth）
// 现在只做「设备密钥换 token」：身份只能由钉钉登录产生。
// 没有绑定过的设备返回 need_login，这里转成 NEED_LOGIN 抛给上层。
const reauth = createSingleFlight(async function ({ silent = false } = {}) {
  const device = getDeviceSecret()
  const revision = sessionRevision
  let res
  try { res = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device }),
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  }) } catch { throw apiError('登录请求网络异常，请重试', { code: 'network_error' }) }
  if (revision !== sessionRevision || String(localStorage.getItem(DEVICE_KEY)||'').toLowerCase() !== device) throw apiError('登录状态已变化，请重试', { status:409, code:'session_changed' })
  if (res.status === 401) {
    if (!silent) fireNeedLogin()
    throw await responseError(res, '请先登录', { sentinel: true })
  }
  if (!res.ok) throw await responseError(res, '登录状态已失效')
  const data = await res.json().catch(() => null)
  if (!data?.token || !data?.user?.id) throw apiError('登录响应无效，请重新登录', { status: res.status, eventId: res.headers.get('X-Event-ID'), code: 'invalid_response' })
  if (revision !== sessionRevision || String(localStorage.getItem(DEVICE_KEY)||'').toLowerCase() !== device) throw apiError('登录状态已变化，请重试', { status:409, code:'session_changed' })
  setToken(data.token)
  if (data.user?.id) localStorage.setItem(UUID_KEY, data.user.id)
  if (reauthHook) reauthHook(token, data.user)
  return data
})

// Explicit device restoration shares the same request/payload as 401 renewal.
// A public-page startup probe can stay silent when this is a new device.
export function restoreDeviceSession(options = {}) { return reauth(options) }

// 用一次性取回码换 token（钉钉登录找回旧账号后调用，避免 token 出现在 URL 里）
export async function claimCode(code) {
  let res
  try { res = await fetch(BASE + '/api/auth/claim', {
    signal: AbortSignal.timeout(10000), cache: 'no-store',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device: getDeviceSecret() })
  }) } catch { throw apiError('登录请求网络异常，请重试', { code: 'network_error' }) }
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.token || !data?.user?.id) {
    throw apiError(data?.error?.message || '登录已过期，请重新登录', { status: res.status, eventId: res.headers.get('X-Event-ID') || data?.error?.eventId, code: data?.error?.code || 'invalid_response' })
  }
  setToken(data.token)
  if (data.user?.id) localStorage.setItem(UUID_KEY, data.user.id)
  if (reauthHook) reauthHook(data.token, data.user)
  return data
}

// 通用请求方法。path 需自带 /api 前缀，例如 '/api/machines'
// timeout：默认 20s。看板首个请求可能触发后端向上游抓数据，给宽一点；
// 其它接口都没必要等这么久，调用方可自行传更小的值。
export async function api(path, opts = {}) {
  const started = performance.now()
  const timing = { status: 0 }
  const context = getTelemetryContext()
  const method = String(opts.method || 'GET').toUpperCase()
  const requestOpts = { ...opts, method }
  let writeScope = '', previous
  if (WRITES.has(method) && !NO_IDEMPOTENCY.test(path) && opts.idempotencyKey !== false) {
    const explicitKey = opts.idempotencyKey || Object.entries(opts.headers || {}).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1]
    let payload
    try { payload = JSON.stringify(opts.body ?? null) } catch { throw apiError('请求内容无效', { code: 'bad_param' }) }
    if (payload.length <= 65536) {
      writeScope = JSON.stringify([token, getAdminSession()?.session || '', method, path, payload, explicitKey || ''])
      const now = Date.now()
      for (const [key, entry] of pendingWrites) if (entry.expiresAt <= now) pendingWrites.delete(key)
      previous = pendingWrites.get(writeScope)
      if (previous?.promise) return previous.promise
    }
    requestOpts.idempotencyKey = explicitKey || previous?.key || newRequestKey()
  }
  const execute = async () => {
    try {
      const result = await performApi(path, requestOpts, timing)
      if (writeScope) pendingWrites.delete(writeScope)
      return result
    } catch (error) {
      if (/^(?:evt|client)_[a-f0-9]{24}$/.test(error.eventId || '')) timing.eventId = error.eventId
      if (writeScope) {
        if (error.status === 0) pendingWrites.set(writeScope, { key: requestOpts.idempotencyKey, expiresAt: Date.now() + 120000, promise: null })
        else pendingWrites.delete(writeScope)
      }
      throw error
    }
  }
  const job = execute()
  if (writeScope) {
    pendingWrites.set(writeScope, { key: requestOpts.idempotencyKey, expiresAt: Date.now() + 120000, promise: job })
    while (pendingWrites.size > 30) pendingWrites.delete(pendingWrites.keys().next().value)
  }
  try { return await job }
  finally { track('api_request', { ...context, ...timing, endpoint: path, durationMs: Math.min(60000, performance.now() - started) }) }
}

async function performApi(path, opts, timing) {
  const { method = 'GET', body, auth = true, retry = true, headers: extra, timeout = 20000, silent = false, idempotencyKey } = opts
  // auth: 'optional' —— 有 token 就带上，没有也照常请求；
  // 401 时既不续期、也不弹登录（匿名可读的接口用这个，比如排队列表要算「哪条是我的」）
  const optionalAuth = auth === 'optional'
  const sentToken = token
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) }
  if (idempotencyKey) {
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'idempotency-key') delete headers[name]
    headers['Idempotency-Key'] = idempotencyKey
  }
  if ((auth || optionalAuth) && token) headers['Authorization'] = 'Bearer ' + token
  // 管理接口要的是后台会话票据（或脚本用的原始口令），不是用户 token
  if (path.startsWith('/api/admin')) {
    const s = getAdminSession()
    if (s && !headers['X-Admin-Token']) headers['X-Admin-Token'] = s.session
  }

  // 超时控制：AbortController + 定时器（Safari 老版本没有 AbortSignal.timeout）
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timer = null
  let timedOut = false
  if (ctrl && timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeout)
  }

  let res
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    })
    timing.status = res.status
  } catch (e) {
    throw apiError(timedOut ? `请求超时（${Math.round(timeout / 1000)}s），请刷新确认结果` : '网络异常，请检查网络后重试', { code: timedOut ? 'timeout' : 'network_error', idempotencyKey })
  } finally {
    if (timer) clearTimeout(timer)
  }

  // token 失效：先尝试用设备密钥续用；续不上就抛 NEED_LOGIN 让上层引导登录
  // （optional 模式不续期：匿名访客本来就没有身份，别把人踢去登录页）
  // 管理接口的 401 是「后台会话过期」，跟用户登录无关，不能走 reauth。
  if (res.status === 401 && path.startsWith('/api/admin') && !path.startsWith('/api/admin/login')) {
    clearAdminSession()
    throw await responseError(res, '后台登录已过期，请重新输入口令', { idempotencyKey })
  }
  if (res.status === 401 && auth && !optionalAuth && retry) {
    if (token === sentToken) setToken('')
    if (!token) await reauth({silent})
    return performApi(path, { ...opts, retry: false }, timing)
  }

  if (!res.ok) {
    const error = await responseError(res, '请求未能完成', { idempotencyKey })
    if (error.code === 'need_login') {
      // optional 模式：把 need_login 当普通错误抛回去，不触发全局跳转
      if (!optionalAuth) {
        if (!silent) fireNeedLogin()
        error.message = NEED_LOGIN
        throw error
      }
    }
    // 带上是哪个接口，方便排查（截图/线上报错都能定位）
    throw error
  }
  try { return await res.json() } catch { throw apiError('服务返回内容无效，请重试', { status: res.status, eventId: res.headers.get('X-Event-ID'), code: 'invalid_response', idempotencyKey }) }
}

// 当前是否已登录（只看本地有没有 token，真正的有效性由接口 401 判定）
export function hasToken() {
  return Boolean(token)
}

// 退出登录：解绑设备密钥 + 清本地状态
export async function logout() {
  sessionRevision++
  const device = getDeviceSecret()
  try {
    await fetch(BASE + '/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device }),
    })
  } catch {
    /* 网络失败也要本地退出 */
  }
  setToken('')
  try {
    localStorage.removeItem(UUID_KEY)
    localStorage.removeItem(DEVICE_KEY)
    localStorage.removeItem('ws_profile')
    // 注意：不清 ws_admin_token —— 管理员口令与用户登录是两套东西
  } catch {
    /* 忽略 */
  }
  if (reauthHook) reauthHook('', null)
}

// 发起钉钉登录：拿授权地址并跳转
export async function startDingLogin() {
  const device = getDeviceSecret()
  let res
  try { res = await fetch(BASE + '/api/dingtalk/login-url?device=' + encodeURIComponent(device), {signal: AbortSignal.timeout(10000), cache:'no-store'}) } catch { throw apiError('登录请求网络异常，请重试', { code: 'network_error' }) }
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.url) {
    throw apiError(data?.error?.message || '无法发起钉钉登录（应用未配置？）', { status: res.status, eventId: res.headers.get('X-Event-ID') || data?.error?.eventId, code: data?.error?.code || 'invalid_response' })
  }
  window.location.href = data.url
}

export { BASE }
