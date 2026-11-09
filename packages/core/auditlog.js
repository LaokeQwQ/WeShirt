// WeShirt · 操作日志审计
//
// 目标：出问题时能回答「谁、什么时候、对什么、做了什么、结果如何」。
// 之前的留档只覆盖「查看手机号」这一条路径，登录/登记/催取/管理操作都没有痕迹，
// 线上排查基本靠猜。
//
// 存储：按天分桶 auditlog:YYYY-MM-DD（北京时间），每天最多 MAX_PER_DAY 条环形截断。
// 这样既能按日期范围读，也避免单个 key 无限膨胀（KV 没有 TTL，膨胀了很难查）。
//
// 同一 store 实例内的桶更新串行；多实例 Edge KV 的最终一致性仍由存储层决定。

import { withOperationLock } from './operations.js'

const MAX_PER_DAY = 500
const DAY_MS = 24 * 60 * 60 * 1000
const cleanupClocks = new WeakMap()

/** 事件类型 → 中文名（管理页筛选用，也避免各处写错字符串） */
export const AUDIT_TYPES = {
  auth: '登录/身份',
  task: '登记洗衣',
  queue: '排队',
  message: '留言',
  urge: '催取/查看手机号',
  admin: '管理操作',
  notify: '通知下发',
  sync: '数据同步',
  error: '异常',
  operation: '业务请求',
}

const VALID_TYPES = new Set(Object.keys(AUDIT_TYPES))
const VALID_LEVELS = new Set(['info', 'warn', 'error'])

/** 北京时间日期串 YYYY-MM-DD（分桶用，不跟随运行时区） */
export function bjDate(ts = Date.now()) {
  const d = new Date(ts + 8 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

/** 脱敏：手机号 / 邮箱 / 长 ID 一律只留头尾 */
export function maskSensitive(input) {
  if (input == null) return input
  let s = String(input)
  // 11 位手机号
  s = s.replace(/\b(\d{3})\d{4}(\d{4})\b/g, '$1****$2')
  // 邮箱
  s = s.replace(/\b([\w.+-])[\w.+-]*@([\w-]+\.[\w.-]+)\b/g, '$1***@$2')
  return s
}

function newLogId() {
  const buf = new Uint8Array(6)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 记一条审计日志。
 *
 * 绝不写入：token、密码、照片内容、完整手机号。detail 里的字符串会过一遍脱敏。
 * 失败不抛错——日志丢一条不能影响主流程。
 *
 * @param {object} store
 * @param {{type:string, action:string, actorId?:string, actorNick?:string,
 *          target?:string, detail?:object, level?:'info'|'warn'|'error'}} ev
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function logEvent(store, ev) {
  if (!store || !ev) return false
  try {
    const type = VALID_TYPES.has(ev.type) ? ev.type : 'error'
    const level = VALID_LEVELS.has(ev.level) ? ev.level : 'info'
    const at = new Date().toISOString()
    const entry = {
      id: 'l_' + newLogId(),
      at,
      type,
      level,
      action: String(ev.action || '').slice(0, 60),
      actorId: ev.actorId ? String(ev.actorId).slice(0, 40) : '',
      actorNick: ev.actorNick ? String(ev.actorNick).slice(0, 24) : '',
      target: ev.target ? maskSensitive(String(ev.target)).slice(0, 60) : '',
      detail: sanitizeDetail(ev.detail),
    }
    const key = `auditlog:${bjDate(new Date(at).getTime())}`
    await withOperationLock(store, key, async () => {
      const list = await store.get(key, [])
      const arr = [...(Array.isArray(list) ? list : []), entry].slice(-MAX_PER_DAY)
      await store.put(key, arr)
    })
    // 持久每日标记避免冷启动重复扫描；清理失败不撤销已写入日志。
    await cleanupExpired(store).catch(() => {})
    return true
  } catch {
    return false
  }
}

async function cleanupExpired(store) {
  if (typeof store.list !== 'function' || typeof store.del !== 'function') return
  const now = Date.now()
  const recent = cleanupClocks.get(store)
  if (Number.isFinite(recent) && now >= recent && now - recent < DAY_MS) return
  await withOperationLock(store, 'auditlog:cleanup', async () => {
    const last = Number(await store.get('auditmeta:lastCleanup', 0))
    cleanupClocks.set(store, now)
    if (last > 0 && now >= last && now - last < DAY_MS) return
    await pruneEvents(store, { keepDays: 30, max: 3 })
    await store.put('auditmeta:lastCleanup', now)
  })
}

/** detail 只保留短标量，避免把大对象（照片、整份看板）塞进日志 */
function sanitizeDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined
  const out = {}
  let count = 0
  for (const [k, v] of Object.entries(detail)) {
    if (count >= 12) break
    if (v == null) continue
    const t = typeof v
    if (t === 'string') {
      // data:image/... 这类内容绝不能进日志
      if (/^data:/i.test(v)) continue
      out[String(k).slice(0, 24)] = maskSensitive(v).slice(0, 120)
    } else if (t === 'number' || t === 'boolean') {
      out[String(k).slice(0, 24)] = v
    } else if (Array.isArray(v)) {
      out[String(k).slice(0, 24)] = v.slice(0, 8).map((x) =>
        typeof x === 'object' ? '[object]' : maskSensitive(String(x)).slice(0, 40)
      )
    }
    count++
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 读日志（新的在前）。
 *
 * @param {object} store
 * @param {{days?:number, type?:string, actorId?:string, level?:string, limit?:number}} opts
 */
export async function listEvents(store, opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 7))
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200))
  const now = Date.now()
  const out = []

  for (let i = 0; i < days; i++) {
    const key = `auditlog:${bjDate(now - i * DAY_MS)}`
    const list = await store.get(key, []).catch(() => [])
    const arr = Array.isArray(list) ? list : []
    // 当天的桶本来就是按时间顺序追加的，倒序取更近的
    for (let j = arr.length - 1; j >= 0; j--) out.push(arr[j])
    if (out.length >= limit * 2) break
  }

  out.sort((a, b) => String(b.at).localeCompare(String(a.at)))

  const filtered = out.filter((e) => {
    if (!e) return false
    if (opts.type && e.type !== opts.type) return false
    if (opts.level && e.level !== opts.level) return false
    if (opts.actorId && e.actorId !== opts.actorId) return false
    if (opts.keyword) {
      const kw = String(opts.keyword).toLowerCase()
      const hay = `${e.action} ${e.target} ${e.actorNick} ${JSON.stringify(e.detail || {})}`.toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })

  return { total: filtered.length, events: filtered.slice(0, limit), days }
}

/**
 * 清理过期日志桶（默认保留 30 天）。
 * 调用点：管理端手动清理，或新建日志时顺手清一天（懒清理）。
 */
export async function pruneEvents(store, { keepDays = 30, max = 0 } = {}) {
  const out = { removed: 0, scanned: 0 }
  const entries = await store.list('auditlog:').catch(() => [])
  const list = Array.isArray(entries) ? entries : []
  const keep = Math.max(1, Number(keepDays) || 30)
  const cutoff = bjDate(Date.now() - keep * DAY_MS)

  for (const e of list) {
    const key = e && e.key
    if (!/^auditlog:\d{4}-\d{2}-\d{2}$/.test(key || '')) continue
    out.scanned++
    const date = key.slice('auditlog:'.length)
    if (date >= cutoff) continue
    if (max > 0 && out.removed >= max) break
    const removed = await withOperationLock(store, key, async () => {
      try { await store.del(key); return true } catch { return false }
    })
    if (removed) out.removed++
  }
  return out
}
