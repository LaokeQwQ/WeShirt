// WeShirt 海乐设备抓取（Agent Scraper 负责）
// 契约：docs/CONTRACTS.md §2.4
// 纯 JS / ESM / 仅用 node 内置与全局 fetch

// ---- 默认 state 映射：原始整数 → 展示状态 ----
export const DEFAULT_STATE_MAP = { idle: [1], occupied: [2], faulty: [3] }

const VALID_STATES = ['idle', 'occupied', 'faulty', 'unknown']

// ---- Mock 设备：≥12 台，覆盖 3 个楼层 ----
export const MOCK_MACHINES = [
  // 1F
  { id: '1F-01', name: '1F-01 海尔', floorCode: '1F', state: 'idle', finishAt: null },
  { id: '1F-02', name: '1F-02 海尔', floorCode: '1F', state: 'idle', finishAt: null },
  { id: '1F-03', name: '1F-03 海尔', floorCode: '1F', state: 'idle', finishAt: null },
  { id: '1F-04', name: '1F-04 海尔', floorCode: '1F', state: 'idle', finishAt: null },
  { id: '1F-05', name: '1F-05 海尔', floorCode: '1F', state: 'idle', finishAt: null },
  // 1F 共 7 台：对应 3D 洗衣房的物理编号 1-7（右手 D1、1-4；左手 D2、7、6、5）
  { id: '1F-06', name: '1F-06 海尔', floorCode: '1F', state: 'idle', finishAt: null },
  // 现场第 7 台（左手边最里侧）
  { id: '1F-07', name: '1F-07 海尔', floorCode: '1F', state: 'idle', finishAt: null },
  // 最近处两台烘干机：右手 D1、左手 D2
  { id: '1F-D1', name: '1F-D1 烘干机', floorCode: '1F', state: 'idle', finishAt: null },
  { id: '1F-D2', name: '1F-D2 烘干机', floorCode: '1F', state: 'idle', finishAt: null },
  // 2F
  { id: '2F-01', name: '2F-01 海尔', floorCode: '2F', state: 'idle', finishAt: null },
  { id: '2F-02', name: '2F-02 海尔', floorCode: '2F', state: 'idle', finishAt: null },
  { id: '2F-03', name: '2F-03 海尔', floorCode: '2F', state: 'idle', finishAt: null },
  { id: '2F-04', name: '2F-04 海尔', floorCode: '2F', state: 'idle', finishAt: null },
  { id: '2F-05', name: '2F-05 海尔', floorCode: '2F', state: 'idle', finishAt: null },
  // 3F
  { id: '3F-01', name: '3F-01 海尔', floorCode: '3F', state: 'idle', finishAt: null },
  { id: '3F-02', name: '3F-02 海尔', floorCode: '3F', state: 'idle', finishAt: null },
  { id: '3F-03', name: '3F-03 海尔', floorCode: '3F', state: 'idle', finishAt: null },
  { id: '3F-04', name: '3F-04 海尔', floorCode: '3F', state: 'idle', finishAt: null },
]

// 把 stateMap 反转为 { 整数: 状态名 } 便于查表
function invertStateMap(stateMap) {
  const inv = {}
  for (const [label, nums] of Object.entries(stateMap)) {
    if (!Array.isArray(nums)) continue
    for (const n of nums) inv[n] = label
  }
  return inv
}

// 把 "YYYY-MM-DD HH:mm:ss"（北京时间 UTC+8）解析为 ISO 字符串
export function parseBeijing(str) {
  if (!str || typeof str !== 'string') return null
  // 外部抓取回写可能已经是 ISO：显式时区必须沿用，不能再加一次 UTC+8。
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(str.trim())) {
    const time = Date.parse(str.trim())
    return Number.isFinite(time) ? new Date(time).toISOString() : null
  }
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s = '00'] = m
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString()
}

// 整数 state → 展示状态；无法识别 → 'unknown'
export function normalizeMachines(raws, stateMap = DEFAULT_STATE_MAP) {
  if (!Array.isArray(raws)) return []
  const inv = invertStateMap(stateMap)
  return raws.map((raw) => {
    const id = raw.id ?? raw.deviceId
    const name = raw.name ?? ''
    const floorCode = raw.floorCode ?? ''
    let state
    if (typeof raw.state === 'string' && VALID_STATES.includes(raw.state)) {
      state = raw.state
    } else {
      state = inv[raw.state] || 'unknown'
    }
    // 幂等：mock/内部数据已是归一化形态（带 finishAt），直接沿用；
    // 真实 API 数据是原始形态（带 finishTime 字符串），走北京时间解析。
    const finishAt =
      raw.finishAt !== undefined ? raw.finishAt : parseBeijing(raw.finishTime)
    return {
      id,
      name,
      floorCode,
      state,
      finishAt,
      // 上游原始状态码，原样带出来：面板上直接显示，
      // 免得「为什么是故障」只能靠猜（4号机 state=3 那次就是靠它定位的）
      rawState: raw.rawState !== undefined ? raw.rawState : raw.state,
    }
  })
}

// 确定性伪随机（mulberry32），用于 mock 状态自然演进
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clone(obj) {
  return structuredClone(obj)
}

// ---- 海乐真实接口实测 state 语义：1=空闲 2=运行中 3=故障/离线 ----
export const HAIER_REAL_STATE_MAP = DEFAULT_STATE_MAP

// 读取 env.HAIER_STATE_MAP（JSON 字符串或对象），非法则回落默认表
export function resolveStateMap(env) {
  const raw = env && env.HAIER_STATE_MAP
  if (!raw) return DEFAULT_STATE_MAP
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    const ok =
      m &&
      typeof m === 'object' &&
      ['idle', 'occupied', 'faulty'].every((k) => Array.isArray(m[k]))
    return ok ? m : DEFAULT_STATE_MAP
  } catch {
    return DEFAULT_STATE_MAP
  }
}

// 这些状态码视为「偶发」，值得重试一次：
// 405 尤其反直觉，但线上实测过上游会短时间对全部请求返回 405（WAF 抖动），
// 之前没有重试时，一次抖动就让看板陈旧了一个多小时。
const RETRYABLE_STATUS = new Set([405, 408, 425, 429, 500, 502, 503, 504])

function isRetryable(err) {
  const m = String((err && err.message) || '')
  const st = m.match(/^HAIER HTTP (\d{3})/)
  if (st) return RETRYABLE_STATUS.has(Number(st[1]))
  // 网络层错误（超时、连接被重置）也值得重试
  return /timeout|network|fetch failed|ECONN|socket/i.test(m)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 统一请求：code!==0 / 非 2xx / 非 JSON 都抛错，交给调用方保留旧状态
// 错误文案带上「方法 + 路径 + 状态码」：只写 "HAIER HTTP 405" 时根本没法判断
// 是哪个端点出的问题（历史上排查过一次，只能靠猜）。
async function requestJson(url, { method = 'GET', headers, body, timeoutMs = 15000, retries = 2, authFirst = false } = {}) {
  const path = (() => {
    try {
      const u = new URL(url)
      return u.pathname + u.search
    } catch {
      return url
    }
  })()

  let lastErr = null
  // 匿名优先：状态接口本来就公开（App 不登录也能看），带 token 只是「有就带上」。
  // 顺序：先不带 Authorization（少一条鉴权链、少一次 401），失败再带 token 重试。
  // token 过期/被停用不再等于同步挂掉，账号池退化成「备用通道」。
  const fullHeaders = new Headers(headers || {})
  const anonHeaders = new Headers(fullHeaders)
  anonHeaders.delete('authorization')
  const order = fullHeaders.has('authorization')
    ? (authFirst ? [fullHeaders, anonHeaders] : [anonHeaders, fullHeaders])
    : [anonHeaders]
  let usedIdx = 0
  let attempts = 0

  // 每次重试/切换身份都有独立的期限，且包含响应体读取。
  const send = async (requestHeaders) => {
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
    try {
      const init = { method, headers: requestHeaders, signal: ctrl.signal }
      if (body !== undefined) init.body = JSON.stringify(body)
      const res = await fetch(url, init)
      if (!res.ok) {
        if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {})
        throw new Error(`HAIER HTTP ${res.status} ${method} ${path}`)
      }
      const text = await res.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`HAIER non-JSON response ${method} ${path}`)
      }
      if (!payload || payload.code !== 0) {
        throw new Error(
          `HAIER code ${payload?.code}${payload?.message ? ` ${payload.message}` : ''} ${method} ${path}`
        )
      }
      return payload.data
    } catch (e) {
      if (timedOut) throw new Error(`HAIER timeout ${method} ${path}`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts = attempt + 1
    if (attempt > 0) {
      // 指数退避 + 抖动，避免多组并发在同一时刻一起重试
      await sleep(300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200))
    }
    try {
      try {
        return await send(order[usedIdx])
      } catch (e) {
        // 最终错误必须来自第二条通道，才能正确重试/冷却 429、503 等响应。
        if (/^HAIER HTTP (401|403)\b/.test(String(e?.message)) && usedIdx === 0 && order.length > 1) {
          usedIdx = 1
          return await send(order[usedIdx])
        }
        throw e
      }
    } catch (e) {
      lastErr = e
      if (!isRetryable(e) || attempt === retries) break
    }
  }
  // 重试过就把尝试次数带出来，排查时能区分「一次就挂」和「重试都挂」
  if (lastErr && String(lastErr.message).startsWith('HAIER HTTP')) {
    throw new Error(`${lastErr.message} (tried ${attempts}x)`)
  }
  throw lastErr
}

/**
 * 出网自检：在**当前运行时**逐个打一遍上游端点，返回每个请求的结果。
 * 用途：从 Edge 运行时出网和从本机出网可能不一样（IP / 中间设备 / 方法限制），
 * 只看聚合后的 "HAIER HTTP 405" 无法定位。这个函数把每一步都摊开。
 * 不返回任何请求头内容（Authorization 在环境变量里，不能泄露）。
 */
export async function diagnoseHaier(env = {}) {
  const out = { mode: env.HAIER_MODE || 'mock', base: null, steps: [] }
  if (out.mode !== 'real') {
    out.note = 'HAIER_MODE 不是 real，无需出网'
    return out
  }
  const base = String(env.HAIER_URL || '').replace(/\/+$/, '')
  out.base = base
  if (!base) {
    out.note = '缺少 HAIER_URL'
    return out
  }
  const pid = env.HAIER_POSITION_ID || ''
  const headers = { 'content-type': 'application/json', ...JSON.parse(env.HAIER_HEADERS || '{}') }
  const timeoutMs = Number(env.HAIER_TIMEOUT_MS) > 0 ? Number(env.HAIER_TIMEOUT_MS) : 8000

  const step = async (label, url, method = 'GET', body) => {
    const t0 = Date.now()
    const rec = { label, method, path: url.replace(base, ''), ms: 0 }
    try {
      const init = { method, headers }
      if (body !== undefined) init.body = JSON.stringify(body)
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(timeoutMs)
      }
      const r = await fetch(url, init)
      const text = await r.text()
      rec.status = r.status
      rec.ok = r.ok
      rec.preview = String(text).slice(0, 160).replace(/\s+/g, ' ')
      try {
        const j = JSON.parse(text)
        rec.code = j.code
        rec.message = j.message
      } catch {
        /* 非 JSON */
      }
    } catch (e) {
      rec.error = String((e && e.message) || e)
    }
    rec.ms = Date.now() - t0
    out.steps.push(rec)
    return rec
  }

  const floorUrl = `${base}/position/floorCodeList?positionId=${encodeURIComponent(pid)}`
  const catUrl = `${base}/position/positionDevice?id=${encodeURIComponent(pid)}`
  await step('floorCodeList', floorUrl)
  await step('positionDevice', catUrl)
  await step('deviceDetailPage', `${base}/position/deviceDetailPage`, 'POST', {
    positionId: /^\d+$/.test(String(pid)) ? Number(pid) : String(pid),
    floorCode: '1',
    categoryCode: '00',
    page: 1,
    pageSize: 10,
  })
  return out
}

/**
 * 账号池：多个账号轮流打上游，某个被限流就切下一个。
 *
 * 支持这些写法（从简到繁）：
 *   HAIER_ACCOUNTS=["tokenA","tokenB"]                          // 只给 Authorization
 *   HAIER_ACCOUNTS=[{"token":"eyJ...","label":"我"}, {...}]      // 推荐：带备注
 *   HAIER_ACCOUNTS=[{"Authorization":"Bearer a"}, ...]           // 完整请求头
 *   HAIER_HEADERS={"Authorization":"Bearer a"}                   // 老写法，单账号
 *
 * 返回 `[{ headers, label }]`，永远至少有一项（老配置视为单账号池）。
 * 这里只做解析，不碰存储；轮询到第几个由调用方决定（要跨请求保持一致）。
 */
export function parseAccountPool(env = {}) {
  const base = { 'content-type': 'application/json' }
  const asAccount = (item) => {
    if (typeof item === 'string') return { headers: { ...base, Authorization: normalizeAuth(item) }, label: '' }
    if (item && typeof item === 'object') {
      const { token, label, ...rest } = item
      const headers = { ...base, ...rest }
      if (token && !headers.Authorization) headers.Authorization = normalizeAuth(token)
      else if (headers.Authorization) headers.Authorization = normalizeAuth(headers.Authorization)
      return { headers, label: typeof label === 'string' ? label.slice(0, 16) : '' }
    }
    return null
  }

  let list = null
  if (env.HAIER_ACCOUNTS) {
    try {
      const parsed = JSON.parse(env.HAIER_ACCOUNTS)
      if (Array.isArray(parsed)) list = parsed.map(asAccount).filter(Boolean)
    } catch {
      /* 解析失败就当没配，退回单账号 */
    }
  }

  if (!list || !list.length) {
    let headers = base
    try {
      headers = { ...base, ...JSON.parse(env.HAIER_HEADERS || '{}') }
    } catch {
      /* 保持 base */
    }
    if (headers.Authorization) headers.Authorization = normalizeAuth(headers.Authorization)
    return [{ headers, label: '' }]
  }
  return list
}

/**
 * 补全 "Bearer " 前缀。
 * 只对「看起来是裸 JWT」的输入动手（三段、点分），别把自定义 scheme 改坏。
 */
export function normalizeAuth(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return s
  if (/^bearer\s/i.test(s)) return s
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return 'Bearer ' + s
  return s
}

/**
 * 从 Authorization 里的 JWT 读过期时间（毫秒）。读不到返回 null。
 * 用途：后台显示每个号还剩几天，提前提醒换 token —— 而不是等同步炸了才发现。
 */
export function tokenExpiry(headers) {
  const raw = headers && headers.Authorization
  if (!raw) return null
  const m = String(raw).match(/^bearer\s+(.+)$/i)
  const jwt = (m ? m[1] : String(raw)).trim()
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const json = JSON.parse(atob(pad))
    const exp = Number(json && json.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * 用 KV 里的覆盖值替换池里的 token。
 * 为什么要这层：token 会过期，改环境变量要重新部署；存在 KV 就能当场生效。
 *
 * overrides 形如 `{ "0": { token, label, at } }`，按**下标**覆盖，环境变量仍是基线。
 */
export function applyTokenOverrides(pool, overrides) {
  if (!overrides || typeof overrides !== 'object') return pool
  return pool.map((acc, i) => {
    const o = overrides[i] || overrides[String(i)]
    if (!o || !o.token) return acc
    const headers = { ...acc.headers, Authorization: normalizeAuth(o.token) }
    return { headers, label: (o && o.label) || acc.label || '' }
  })
}

/**
 * 短信验证码登录（半自动：人在环里收码，账号是本人的）。
 *
 * 为什么不写死接口：登录路径/参数/鉴权头各家各版都不一样，靠猜必然错。
 * 这里只做「可配置的适配器」——把抓包得到的两条请求填进 HAIER_LOGIN，就能用：
 *
 *   HAIER_LOGIN={
 *     "sendUrl":   "https://xxx/sms/send",
 *     "sendBody":  {"phone":"{{phone}}"},
 *     "verifyUrl": "https://xxx/login/sms",
 *     "verifyBody":{"phone":"{{phone}}","code":"{{code}}"},
 *     "tokenPath": "data.token",
 *     "headers":   {"appId":"xxx"}
 *   }
 *
 * 模板里只替换 {{phone}} / {{code}}，其余字段原样发出。
 */
export function parseLoginConfig(env = {}) {
  if (!env.HAIER_LOGIN) return null
  let cfg = null
  try {
    cfg = JSON.parse(env.HAIER_LOGIN)
  } catch {
    return null
  }
  if (!cfg || typeof cfg !== 'object') return null
  if (!cfg.sendUrl || !cfg.verifyUrl) return null
  // 只允许 https；本机地址放行是为了本地联调/单测
  const okUrl = (u) => /^https:\/\//i.test(String(u)) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(String(u))
  if (!okUrl(cfg.sendUrl) || !okUrl(cfg.verifyUrl)) return null
  return cfg
}

function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])))
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = fillTemplate(v, vars)
    return out
  }
  return value
}

// 从返回体里按 "data.token" 这种路径取 token
function pickPath(obj, path) {
  if (!path) return undefined
  return String(path)
    .split('.')
    .reduce((acc, k) => (acc == null ? acc : acc[k]), obj)
}

async function postLogin(url, body, headers, timeoutMs = 12000) {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`登录接口 HTTP ${res.status}`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('登录接口返回的不是 JSON')
  }
  // 有的接口用 code，有的用 errcode/RESULT
  const code = json.code ?? json.errcode ?? json.RESULT
  if (code != null && ![0, 200, '0', '200', true].includes(code)) {
    throw new Error(`登录接口返回 ${code}${json.message || json.MESSAGE ? ' ' + (json.message || json.MESSAGE) : ''}`)
  }
  return json
}

export async function sendLoginCode(env, phone) {
  const cfg = parseLoginConfig(env)
  if (!cfg) throw new Error('还没配置登录接口（HAIER_LOGIN）')
  if (!/^1\d{10}$/.test(String(phone || ''))) throw new Error('手机号格式不对')
  const body = fillTemplate(cfg.sendBody || { phone: '{{phone}}' }, { phone })
  await postLogin(cfg.sendUrl, body, cfg.headers || {})
  return { ok: true }
}

export async function verifyLoginCode(env, phone, code) {
  const cfg = parseLoginConfig(env)
  if (!cfg) throw new Error('还没配置登录接口（HAIER_LOGIN）')
  if (!/^1\d{10}$/.test(String(phone || ''))) throw new Error('手机号格式不对')
  if (!/^\d{4,8}$/.test(String(code || ''))) throw new Error('验证码格式不对')
  const body = fillTemplate(cfg.verifyBody || { phone: '{{phone}}', code: '{{code}}' }, { phone, code })
  const json = await postLogin(cfg.verifyUrl, body, cfg.headers || {})
  const token = pickPath(json, cfg.tokenPath || 'data.token') || pickPath(json, 'token') || pickPath(json, 'data.accessToken')
  if (!token || typeof token !== 'string') throw new Error('登录成功但没找到 token 字段，检查 tokenPath')
  return { ok: true, token }
}

/**
 * 组装最终的账号池。优先级：
 *   1. KV 里的 `meta:haierAccounts`（后台批量导入的，最灵活，不用重新部署）
 *   2. 环境变量 HAIER_ACCOUNTS
 *   3. 环境变量 HAIER_HEADERS（老写法，单账号）
 * KV 里按序号的 token 覆盖（meta:haierTokens）只对第 2/3 种生效。
 */
export function buildPool(env = {}, kvAccounts = null, kvOverrides = null) {
  const base = { 'content-type': 'application/json' }

  if (Array.isArray(kvAccounts) && kvAccounts.length) {
    const list = []
    for (const a of kvAccounts) {
      const auth = normalizeAuth((a && a.token) || '')
      if (!auth) continue
      list.push({ headers: { ...base, Authorization: auth }, label: (a && a.label) || '' })
    }
    if (list.length) return list
  }

  let pool = parseAccountPool(env)
  if (kvOverrides) pool = applyTokenOverrides(pool, kvOverrides)
  return pool
}

/**
 * 批量导入用的文本解析：一行一个账号。
 * 支持 `标签, token` / `标签 token` / 纯 token，空行和 # 注释忽略。
 */
export function parseTokenLines(text, { limit = 20 } = {}) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let label = ''
    let token = line
    const m = line.match(/^([^,\s]{1,16})\s*[,\s]\s*(.+)$/)
    if (m && /^bearer\s/i.test(m[2].trim())) {
      label = m[1]
      token = m[2].trim()
    } else if (m && m[2].split('.').length === 3) {
      label = m[1]
      token = m[2].trim()
    }
    const auth = normalizeAuth(token)
    // 太短的明显是粘错了（真 token 都是几百字符）
    if (auth.length < 20) continue
    out.push({ token: auth, label: label.slice(0, 16) })
    if (out.length >= limit) break
  }
  return out
}

export function createHaierClient(env = {}) {
  const mode = env.HAIER_MODE || 'mock'

  if (mode === 'real') {
    const headers = {
      'content-type': 'application/json',
      ...JSON.parse(env.HAIER_HEADERS || '{}'),
    }
    const stateMap = resolveStateMap(env)
    const positionId = env.HAIER_POSITION_ID
    const pageSize = Number(env.HAIER_PAGE_SIZE) > 0 ? Math.min(500, Math.max(1, Math.floor(Number(env.HAIER_PAGE_SIZE)))) : 100

    // A. 多点位流程（推荐）：按楼层 × 类别逐页拉设备明细
    if (positionId) {
      const base = String(env.HAIER_URL || '').replace(/\/+$/, '')
      if (!base) throw new Error('HAIER_URL is required in real mode')

      const fetchStatus = async () => {
        const pid = /^\d+$/.test(String(positionId)) ? Number(positionId) : String(positionId)
        const timeoutMs = Number(env.HAIER_TIMEOUT_MS) > 0 ? Number(env.HAIER_TIMEOUT_MS) : 8000
        // 默认匿名优先（读接口公开）；HAIER_AUTH_MODE=token 时改成先带 token
        const authFirst = String(env.HAIER_AUTH_MODE || '').toLowerCase() === 'token'

        // 这两个是元数据请求，互不依赖，并发拉
        const [floors, cats] = await Promise.all([
          requestJson(`${base}/position/floorCodeList?positionId=${encodeURIComponent(pid)}`, {
            headers,
            timeoutMs,
            authFirst,
          }),
          requestJson(`${base}/position/positionDevice?id=${encodeURIComponent(pid)}`, {
            headers,
            timeoutMs,
            authFirst,
          }),
        ])

        if (!Array.isArray(floors) || !Array.isArray(cats)) throw new Error('HAIER invalid metadata')
        const floorList = [...new Set(floors.map(String))]
        const catList = [...new Set(cats
          .filter((c) => Number(c && c.total) > 0)
          .map((c) => String(c.categoryCode)))]

        // 拉一个 (楼层 × 类别) 的全部页
        const pullCombo = async (floorCode, categoryCode) => {
          const out = []
          let got = 0
          for (let page = 1; page <= 20; page++) {
            const data = await requestJson(`${base}/position/deviceDetailPage`, {
              method: 'POST',
              headers,
              body: { positionId: pid, floorCode, categoryCode, page, pageSize },
              timeoutMs,
              authFirst,
            })
            if (!Array.isArray(data?.items)) throw new Error('HAIER invalid device page')
            const items = data.items
            for (const it of items) {
              out.push({
                id: String(it.deviceId ?? it.id ?? ''),
                name: it.name ?? '',
                floorCode: String(it.floorCode ?? floorCode),
                state: it.state,
                finishTime: it.finishTime ?? null,
              })
            }
            got += items.length
            const total = Number(data && data.total) || 0
            if (!items.length && total > got) throw new Error('HAIER incomplete device page')
            if ((total > 0 && got >= total) || (total <= 0 && items.length < pageSize)) return out
          }
          throw new Error('HAIER device pagination limit exceeded')
        }

        // 限制并发，避免楼层多时瞬间打出大量请求；任一组失败都保留旧完整快照。
        const combos = []
        for (const floorCode of floorList) {
          for (const categoryCode of catList) combos.push([floorCode, categoryCode])
        }
        const groups = new Array(combos.length)
        let cursor = 0
        let failure = null
        await Promise.all(Array.from({ length: Math.min(4, combos.length) }, async () => {
          while (cursor < combos.length && !failure) {
            const index = cursor++
            try {
              groups[index] = await pullCombo(...combos[index])
            } catch (e) {
              failure ||= e
            }
          }
        }))
        if (failure) throw failure
        const raws = groups.flat()

        // 同 deviceId 去重，保持服务端顺序
        const seen = new Set()
        const uniq = []
        for (const r of raws) {
          if (!r.id || seen.has(r.id)) continue
          seen.add(r.id)
          uniq.push(r)
        }

        // 已归一化：调用方再次 normalizeMachines 时为幂等空操作
        return normalizeMachines(uniq, stateMap)
      }

      return { mode, fetchStatus }
    }

    // B. 旧版单接口：整段 POST 后按 page/pageSize 翻页
    const fetchStatus = async () => {
      const url = env.HAIER_URL
      if (!url) throw new Error('HAIER_URL is required in real mode')
      const basePayload = JSON.parse(env.HAIER_PAYLOAD || '{}')
      const items = []
      for (let page = 1; page <= 10; page++) {
        const data = await requestJson(url, {
          method: 'POST',
          headers,
          body: { ...basePayload, page, pageSize },
          timeoutMs: Number(env.HAIER_TIMEOUT_MS) > 0 ? Number(env.HAIER_TIMEOUT_MS) : 8000,
          authFirst: String(env.HAIER_AUTH_MODE || '').toLowerCase() === 'token',
        })
        if (!Array.isArray(data?.items)) throw new Error('HAIER invalid device page')
        const arr = data.items
        for (const it of arr) items.push(it)
        const total = typeof data?.total === 'number' ? data.total : 0
        if (!arr.length && total > items.length) throw new Error('HAIER incomplete device page')
        if ((total > 0 && items.length >= total) || (total <= 0 && arr.length < pageSize)) return normalizeMachines(items, stateMap)
      }
      throw new Error('HAIER device pagination limit exceeded')
    }
    return { mode, fetchStatus }
  }

  // mock 模式：每次返回深拷贝，并按时间/调用轮转状态，保证连续轮询能看到变化
  let callCount = 0
  const fetchStatus = async () => {
    callCount += 1
    const now = Date.now()
    const minute = Math.floor(now / 60000)
    return MOCK_MACHINES.map((m, i) => {
      const c = clone(m)
      const rng = mulberry32(minute * 100003 + i * 7919 + callCount * 104729)
      const r = rng()
      if (r < 0.62) {
        c.state = 'idle'
        c.finishAt = null
      } else if (r < 0.9) {
        c.state = 'occupied'
        const addMin = 10 + Math.floor(rng() * 31) // 10~40 分钟
        c.finishAt = new Date(now + addMin * 60000).toISOString()
      } else {
        c.state = 'faulty'
        c.finishAt = null
      }
      return c
    })
  }
  return { mode, fetchStatus }
}
