// WeShirt · HTTP 路由 + 同步逻辑（双形态共用）
// 工厂 createApp({ store, env }) → Hono app（无模块级单例）。
// 并行 agent 的模块（haier/machines/dingtalk/webpush）通过动态 import 加载，
// 这样即便它们尚未写完，本服务也能正常启动并为不依赖它们的路由提供服务。

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  json,
  apiErr,
  safeErrorCategory,
  nowISO,
  minutesBetween,
  randomCode,
  randomKey,
  warn,
  log,
} from '../packages/core/util.js'
import { newUserId, issueToken, verifyToken, verifyAdminSession } from '../packages/core/auth.js'
import { pickIndex as pickPoolIndex } from '../packages/core/egress.js'
import { checkNick } from '../packages/core/nick.js'
import {
  AVATAR_KEYS,
  buildUser,
  normalizeAvatar,
  normalizeAvatarUrl,
  normalizeNick,
  randomAvatar,
  randomNick,
  randomNickExcept,
} from '../packages/core/profile.js'
import { registerAdminRoutes } from './admin.js'
import { registerTelemetryRoutes } from './telemetry.js'
import { registerAnnouncementRoutes } from './announcements.js'
import { registerAssistantRoutes, pruneAssistantStorage } from './assistant.js'
import { registerSiteRoutes,checkSiteAdmin,getSiteConfig,loadSiteRuntime } from './site.js'
import { registerSocialRoutes } from './social.js'
import { registerOperationsRoutes } from './operations.js'
import { registerFavoriteRoutes } from './favorites.js'
import { registerQueueNoticeRoutes } from './queue-reminders.js'
import { registerInspectionRoutes } from './inspections.js'
import { getUserIdentity } from '../packages/core/identity.js'
import { registerPermissionMiddleware, registerPermissionRoutes } from './permissions.js'
import { registerAuditMiddleware } from './audit-middleware.js'
import { registerRequestSafety } from './request-safety.js'
import { registerTaskMutationLock, withTaskMutation } from './task-mutation-lock.js'
import { processFavoriteReminders } from '../packages/core/favorites.js'
import { processQueueReminders } from '../packages/core/queue-reminders.js'
import { runOperations, applyMachineHealth, withOperationLock } from '../packages/core/operations.js'
import { resolveMachineKind, normalizeMachineCategory } from '../packages/core/machine-kind.js'
import { applyRegisteredAvailability } from '../packages/core/availability.js'
import { processCommunityNotices } from '../packages/core/community-notices.js'
import { pruneCommunityMedia } from './community-media.js'
import { DORM_BUILDINGS, normalizeDormBuilding, dormBuildingName, resolveMachineDorm, filterDormFloors, summarizeDormBuildings, currentDormCatalog, enabledMachineBoard, isMachineDormEnabled } from '../packages/core/buildings.js'

// 登记备注为当前机器面板公开纯文本，不自动发布到留言频道。
function normalizeTaskNote(value) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim() : ''
}
function taskDetailsView(task) {
  return { note: Array.from(normalizeTaskNote(task?.note)).slice(0, 200).join(''), useDisinfectant: task?.useDisinfectant === true, selfCleaned: task?.selfCleaned === true, ...(task?.program==='self_clean'?{program:'self_clean'}:{}) }
}

const DAY_MS = 24 * 60 * 60 * 1000
const MARKS_TTL_MS = 30 * 60 * 1000 // marks 30 分钟过期
const BINDCODE_TTL_MS = 10 * 60 * 1000 // bindcode 10 分钟过期
const BINDCODE_LEN = 12 // 12 位字母数字：31^12 ≈ 7.9e17，6 位纯数字只有 1e6 可被爆破
const MESSAGES_MAX = 100 // messages 截断 100 条
const DRYER_STUCK_MIN = 8 // 烘干机剩余时间连续不变多少分钟算「疑似跳闸」
const DRYER_STUCK_COOLDOWN_MS = 30 * 60 * 1000 // 同一台机器跳闸通知的最短间隔
const NOTIFY_LEADS = [0, 3, 5, 10] // 取衣提醒提前分钟，0 = 洗完再提醒
const DORM_BUILDING_CODES = new Set(['guiyuan', 'liuyuan', 'meiyuan', 'zhuyuan'])

// 现场机位类型优先于上游名称（例如 D1 的名字只有“柳园西”）。
const machineKind = resolveMachineKind

async function notifyCommunityUser(env,store,uid,notice){
  const user=await store.get('user:'+uid,null)
  if(!user||user.disabled||user.blocked||user.notifyOn===false)return {ok:false,skipped:true}
  let dm={ok:false},pushOK=false
  if(user.dingUserId){
    try{const mod=await import('../packages/core/dingtalk.js');dm=await mod.createDingTalk(env).sendSingle(user.dingUserId,notice)}catch{}
  }
  if(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY){
    const subs=await store.get('subs',[])
    const mod=await import('../packages/core/webpush.js'),wp=mod.createWebPush(env)
    for(const sub of (Array.isArray(subs)?subs:[]).filter(sub=>sub.userId===uid).slice(0,5)){
      try{const result=await wp.send(sub.subscription||{endpoint:sub.endpoint,keys:sub.keys},{...notice,body:notice.text});pushOK ||= result?.ok===true}catch{}
    }
  }
  return {ok:user.dingUserId?dm?.ok===true:pushOK}
}

function noticeMachine(machine, mapping = {}) {
  const slot = Object.entries(mapping).find(([, id]) => id != null && String(id) === String(machine?.id))?.[0]
  return { kind: machineKind(machine, mapping), slot: slot || undefined, machineLabel: slot ? `桂园 · ${/^D/i.test(slot) ? `${slot.slice(1)}号烘干机` : `${slot}号洗衣机`}` : undefined }
}

function ownsTaskOccupancy(occupancy, task, userId) {
  if (!occupancy || occupancy.userId !== userId) return false
  if (occupancy.taskId) return occupancy.taskId === task.id
  if (occupancy.startAt && task.startAt) return occupancy.startAt === task.startAt
  return true // 兼容没有关联字段的旧占用记录
}

// ── 惰性加载 machines（computeLeftMin 用），缺失时回退到 util.minutesBetween ──
let _machinesMod = null
let _machinesLoading = null
function getMachines() {
  if (_machinesMod) return Promise.resolve(_machinesMod)
  if (!_machinesLoading) {
    _machinesLoading = import('../packages/core/machines.js').catch((e) => {
      _machinesLoading = null
      return null
    })
  }
  return _machinesLoading.then((m) => {
    _machinesMod = m
    return m
  })
}
async function computeLeftMin(finishAt, now) {
  const m = await getMachines()
  if (m && typeof m.computeLeftMin === 'function') return m.computeLeftMin(finishAt, now)
  return minutesBetween(finishAt, now) // 真实计算，非假响应
}

// 密钥必须由环境变量提供，**绝不回退到内置默认值**。
// 以前写 `env.AUTH_SECRET || 'dev-secret'`：线上漏配一个变量，
// 任何人都能用公开常量伪造任意 userId 的 token；管理员口令退化成 'admin123' 同理。
// 现在缺配置就一律拒绝（前端会看到 401 / 503，运维一眼能看出是配置问题）。
const MIN_SECRET_LEN = 16
function authSecret(env) {
  const s = String((env && env.AUTH_SECRET) || '').trim()
  return s.length >= MIN_SECRET_LEN ? s : ''
}
function adminSecret(env) {
  const t = String((env && env.ADMIN_TOKEN) || '').trim()
  return t.length >= 8 ? t : ''
}

// 取出 Bearer 中的 userId（失败返回 null）
async function bearerUser(c, env) {
  const secret = authSecret(env)
  if (!secret) return null
  const h = c.req.header('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  return verifyToken(m[1], secret)
}

// 管理口令校验：优先请求头（避免口令出现在 URL / 访问日志里）。
// 也接受后台页面用的 12 小时会话票据（见 packages/core/auth.js）。
async function checkSuperAdmin(c, env) {
  const expect = adminSecret(env)
  if (!expect) return false
  const token = c.req.header('x-admin-token') || c.req.query('token')
  if (!token) return false
  if (token === expect) return true
  const payload = await verifyAdminSession(token, authSecret(env)).catch(() => null)
  return Boolean(payload)
}

async function checkAdmin(c,env,store){return await checkSuperAdmin(c,env) || Boolean(store && await checkSiteAdmin(c,store,authSecret(env)))}

// 同步密钥：由 AUTH_SECRET 派生，只能用来触发 /api/cron/sync。
// 填进外部定时器（cron-job.org / UptimeRobot 之类）用它就够了——
// 那些服务会把 URL 存起来，绝不能把管理员口令给出去。
async function syncKeyOf(env) {
  const mod = await import('../packages/core/auth.js')
  return mod.deriveSyncKey(authSecret(env))
}

// 仅保留对外安全的 user 字段
function publicUser(u) {
  if (!u) return null
  return {
    id: u.id,
    nick: u.nick,
    avatar: normalizeAvatar(u.avatar),
    avatarUrl: normalizeAvatarUrl(u.avatarUrl), // 自定义/钉钉头像；为空则前端用 avatar key 画 SVG
    createdAt: u.createdAt,
    dingBound: !!u.dingUserId,
    dingUserId: u.dingUserId || null,
    dingNick: u.dingNick || null,
    // 手机号只回给**本人**（这个函数只用于「当前登录用户」的响应，
    // 公开列表走 maskNick / 单独脱敏，不会经过这里）
    mobile: u.mobile || '',
    notifyOn: u.notifyOn !== false,
    notifyLeadMin: normalizeLead(u.notifyLeadMin),
    dormBuilding: typeof u.dormBuilding==='string' && /^[a-z][a-z0-9_-]{0,31}$/.test(u.dormBuilding) ? u.dormBuilding : null,
    dormChangesRemaining: Math.max(0, 1-(Number.isInteger(u.dormChangeCount)?u.dormChangeCount:0)),
  }
}

// 取用户；不存在就按默认值重建。
// 为什么不是直接 404：KV 没绑定/还没同步时数据读不到，老 token 会指向一个
// 「查不到」的 user。此时把用户当成新用户重建，既不会 404，也让 token 继续可用。
async function getUserOrRebuild(store, userId) {
  // KV 是最终一致性（官方最长 60s 全球同步）。刚写完立刻换到另一个边缘节点读，
  // 有可能读到 null —— 这时如果直接重建并写回，就会把用户真实的资料
  // （钉钉身份、昵称、头像、手机号）覆盖成一份空白记录，
  // 表现为「突然变成新用户、名字变随机、收不到提醒」。线上真出现过。
  // 所以：多次重试；仍然读不到时**只在内存里造一个临时对象，绝不落库**。
  for (const wait of [0, 150, 400]) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    const u = await store.get(`user:${userId}`, null)
    if (u && u.id) {
      // 老数据迁移：emoji 头像 → avatar key
      if (u.avatar !== normalizeAvatar(u.avatar)) {
        u.avatar = normalizeAvatar(u.avatar)
        // 只规范化当前响应，避免读取迁移覆盖并发保存的资料。
      }
      if (!u.nick) u.nick = '同学'
      return u
    }
  }
  return { ...buildUser(userId), transient: true }
}

const NOTIFY_LEAD_SET = new Set([0, 3, 5, 10])

function normalizeLead(v) {
  const n = Number(v)
  return NOTIFY_LEAD_SET.has(n) ? n : 0
}

/**
 * 烘干机「疑似跳闸」检测 —— 放在服务端，不依赖前端开着面板。
 *
 * 判据：上游 remainMin 连续 DRYER_STUCK_MIN 分钟不变，且机器仍在运行态。
 * 真正的烘干机每分钟都会减 1，长时间不动基本只有两种可能：跳闸/断电，
 * 或者上游接口卡住了（两种都值得让人去看一眼）。
 *
 * 为什么要挪到服务端：之前是在 3D 面板里轮询，用户不点开那台机器就永远不会触发，
 * 而「主动通知使用者」的前提是系统自己能发现，不是靠路人开页面。
 *
 * @returns {Promise<number>} 本次真正发出通知的台数
 */
export async function detectDryerStuck(env, store, machinesNow) {
  const buildingId = env.BUILDING_ID || 'b1'
  const key = `dryerstuck:${buildingId}`
  const prev = (await store.get(key, null)) || {}
  const nowMs = Date.now()
  const next = {}
  let alerts = 0

  const list = Array.isArray(machinesNow) ? machinesNow : []
  const [occ, savedMap] = await Promise.all([
    store.get(`occupancy:${buildingId}`, {}),
    store.get(`mapping:${buildingId}`, null),
  ])

  for (const m of list) {
    if (!m) continue
    if (machineKind(m, savedMap?.mapping || {}) !== 'dryer') continue
    const running = m.state === 'occupied'
    // 剩余分钟字段是 leftMin（buildBoard 由 finishAt 算出来的），不是 remainMin
    if (!running || m.leftMin == null || m.estimated) continue

    const rec = prev[m.id]
    // leftMin 没变就沿用上次的起点，变了就重新计时
    const since = rec && rec.remain === m.leftMin ? rec.since || nowMs : nowMs
    const entry = {
      remain: m.leftMin,
      since,
      notifiedAt: rec?.notifiedAt || 0,
      checkedAt: rec?.checkedAt || 0,
    }
    const stuckMin = Math.floor((nowMs - since) / 60000)

    if (
      stuckMin >= DRYER_STUCK_MIN &&
      (!entry.notifiedAt || nowMs - entry.notifiedAt > DRYER_STUCK_COOLDOWN_MS)
    ) {
      entry.checkedAt = nowMs
      // 通知这台机器的登记人（没有登记人就没有收件人，只记状态）
      const holder = occ?.[m.id]
      const target = holder && holder.userId ? await store.get(`user:${holder.userId}`, null) : null
      if (target && target.dingUserId && target.notifyOn !== false) {
        try {
          const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
          const noticeMod = await import('../packages/core/notice.js').catch(() => null)
          if (dingMod && typeof dingMod.createDingTalk === 'function') {
            const dt = dingMod.createDingTalk(env)
            const notice =
              noticeMod && typeof noticeMod.buildStuckNotice === 'function'
                ? noticeMod.buildStuckNotice({
                    ...noticeMachine(m, savedMap?.mapping),
                    machineName: m.name || m.id,
                    floorCode: m.floorCode,
                    leftMin: m.leftMin,
                    stuckMin,
                  })
                : {
                    text:
                      `【等衣】${m.name || m.id} 剩余 ${m.leftMin} 分钟，已 ${stuckMin} 分钟没变化，` +
                      '可能跳闸或断电，麻烦去现场确认一下',
                  }
            const result = await dt.sendSingle(target.dingUserId, notice)
            if (result?.ok) {
              entry.notifiedAt = nowMs
              alerts++
            }
          }
        } catch (e) {
          warn('烘干机跳闸通知失败:', safeErrorCategory(e))
        }
      }

    }
    next[m.id] = entry
  }

  await store.put(key, next).catch(() => {})
  return alerts
}

/** 记审计日志（拿不到 store 就静默跳过，绝不因为日志失败影响主流程） */
async function audit(store, ev) {
  try {
    const mod = await import('../packages/core/auditlog.js').catch(() => null)
    if (mod && typeof mod.logEvent === 'function') await mod.logEvent(store, ev)
  } catch {
    /* 静默 */
  }
}

/**
 * 由钉钉昵称生成默认昵称：去掉重复的「同学」再补一个，最多 16 字。
 * 例：测试用户 → 测试用户同学；李同学 → 李同学（不会变成「李同学同学」）
 */
// 昵称唯一：默认昵称（钉钉名/随机名）撞了就自动加序号，
// 手改昵称撞了直接拒绝 —— 群里 @ 人、留言板 @ 都靠昵称区分，重名很坑。
async function ensureUniqueNick(store, nick, excludeId = '') {
  const base = String(nick || '').trim().slice(0, 14) || '同学'
  const entries = await store.list('user:').catch(() => [])
  const taken = new Set(
    (Array.isArray(entries) ? entries : [])
      .map((e) => e && e.value)
      .filter((u) => u && u.id !== excludeId && u.nick)
      .map((u) => String(u.nick))
  )
  if (!taken.has(base)) return base
  for (let i = 2; i <= 99; i++) {
    const cand = base + i
    if (!taken.has(cand)) return cand
  }
  return base + Math.floor(Math.random() * 900 + 100)
}

async function isNickTaken(store, nick, excludeId = '') {
  const entries = await store.list('user:').catch(() => [])
  return (Array.isArray(entries) ? entries : []).some(
    (e) => e && e.value && e.value.id !== excludeId && String(e.value.nick) === String(nick)
  )
}

export function nickFromDing(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''
  const base = raw.replace(/同学$/, '').trim() || raw
  const nick = (base + '同学').slice(0, 16)
  // 钉钉昵称可能带违规词（广告号、辱骂），同步下来也不能直接用
  const chk = checkNick(nick)
  return chk.ok ? nick : '同学'
}

// 昵称对外打码：首字 + **（留言板等公开场景用）
function maskNick(nick) {
  const s = String(nick || '匿名')
  const chars = [...s]
  if (chars.length <= 1) return chars[0] + '**'
  return chars[0] + '**'
}

// ─────────────────────────────────────────────────────────────
// 账号池：从当前下标开始找第一个「不在冷却里」的账号
// ─────────────────────────────────────────────────────────────
const HAIER_ACCOUNT_COOLDOWN_MS = 10 * 60 * 1000

function pickFromPool(pool, state, now) {
  if (!pool || !pool.length) return null
  // 选择规则统一放在 packages/core/egress.js（代理池用同一套）
  const i = pickPoolIndex(pool.length, state, now)
  if (i < 0) return null
  return { index: i, headers: pool[i].headers }
}

async function estimateFinishAt(store, buildingId, machines) {
  const list = Array.isArray(machines) ? machines : []
  // 上游没有程序/结束时间时保留未知，不能把六分钟桶自洁猜成三十分钟标准洗。
  for(const m of list)if(m?.estimated){m.finishAt=null;delete m.estimated}
  const cleanupKey=`meta:estimateCleanup:${buildingId}`
  if(!await store.get(cleanupKey,false)){
    const legacy=await store.list(`est:${buildingId}:`)
    await Promise.all(legacy.map(({key})=>store.del(key)))
    await store.put(cleanupKey,true)
  }
  return list
}

function hhmmIn8(iso) {
  const ms = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms + 8 * 3600 * 1000)
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0')
}

// 洗完 → 私信占用者：告诉他洗好了，并且回一句「已取」就能销账
async function notifyIdleOccupants(env, store, events) {
  const idles = (events || []).filter((e) => e.type === 'becameIdle' && e.machine)
  if (!idles.length) return 0

  const buildingId = env.BUILDING_ID || 'b1'
  const occ = (await store.get(`occupancy:${buildingId}`, {}).catch(() => null)) || {}
  const savedMap = await store.get(`mapping:${buildingId}`, null).catch(() => null)
  const map = (savedMap && savedMap.mapping) || {}
  const slotById = {}
  for (const [slot, id] of Object.entries(map)) if (id) slotById[String(id)] = String(slot)

  const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
  if (!dingMod || typeof dingMod.createDingTalk !== 'function') return 0
  const dt = dingMod.createDingTalk(env)

  let sent = 0
  for (const e of idles) {
    const machineId = String(e.machine.id)
    const entry = occ[machineId]
    if (!entry || !entry.userId) continue

    const key = `idledm:${buildingId}:${machineId}`
    const last = Number((await store.get(key, 0).catch(() => 0)) || 0)
    if (Date.now() - last < 30 * 60 * 1000) continue

    const user = await store.get(`user:${entry.userId}`, null).catch(() => null)
    if (!user || user.disabled || user.blocked || !user.dingUserId || user.notifyOn === false) continue
    if (!isMachineDormEnabled(e.machine, await currentDormCatalog(store, env.SITE_BUILDINGS), map)) continue

    // 有登记任务时由任务提醒统一负责，避免状态事件与到期流程各发一条私信。
    const tasks = await store.get(`tasks:${entry.userId}`, [])
    if (Array.isArray(tasks) && tasks.some((task) =>
      String(task.machineId) === machineId && ownsTaskOccupancy(entry, task, entry.userId)
    )) continue

    const slot = slotById[machineId]
    const label = slot ? (/^d/i.test(slot) ? `${slot.slice(1)}号烘干机` : `${slot}号洗衣机`) : e.machine.name
    // 不再写「去拿」这种命令句：说清楚状态 + 一句可回的话就够了
    const { buildTakeNotice } = await import('../packages/core/notice.js')
    const notice = buildTakeNotice({ machineName: label, ...noticeMachine(e.machine, map), confirmed: true })
    const r = await dt.sendSingle(user.dingUserId, notice).catch(() => null)
    if (r && r.ok) {
      await store.put(key, Date.now()).catch(() => {})
      sent++
    }
  }
  return sent
}

// 机器报故障 → 私信当前占用者（每台 30 分钟最多一次）
//
// 群播报是「所有人都看到」，但真正需要知道的是正在用这台机器的人：
// 他的衣服还在里面，可能要先捞出来。所以这条单独私聊。
async function notifyFaultOccupants(env, store, events) {
  const faults = (events || []).filter((e) => e.type === 'fault' && e.machine)
  if (!faults.length) return 0

  const buildingId = env.BUILDING_ID || 'b1'
  const occ = (await store.get(`occupancy:${buildingId}`, {}).catch(() => null)) || {}
  const savedMap = await store.get(`mapping:${buildingId}`, null).catch(() => null)
  const map = (savedMap && savedMap.mapping) || {}
  const slotById = {}
  for (const [slot, id] of Object.entries(map)) if (id) slotById[String(id)] = String(slot)

  const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
  if (!dingMod || typeof dingMod.createDingTalk !== 'function') return 0
  const dt = dingMod.createDingTalk(env)

  let sent = 0
  for (const e of faults) {
    const machineId = String(e.machine.id)
    const entry = occ[machineId]
    if (!entry || !entry.userId) continue

    // 同一台 30 分钟内只私信一次，别在上游抖动时反复骚扰
    const key = `faultdm:${buildingId}:${machineId}`
    const last = Number((await store.get(key, 0).catch(() => 0)) || 0)
    if (Date.now() - last < 30 * 60 * 1000) continue

    const user = await store.get(`user:${entry.userId}`, null).catch(() => null)
    if (!user || !user.dingUserId || user.notifyOn === false) continue

    const slot = slotById[machineId]
    const where = slot ? `${slot} 号位` : e.machine.name
    const text = `【等衣】${where}报故障了，衣服先拿出来，别硬开。报给宿管后一般很快来修。`
    const r = await dt.sendSingle(user.dingUserId, text).catch(() => null)
    if (r && r.ok) {
      await store.put(key, Date.now()).catch(() => {})
      sent++
    }
  }
  return sent
}

// ─────────────────────────────────────────────────────────────
// 自检 + 管理员告警
// ─────────────────────────────────────────────────────────────
// 只私信给管理员（ADMIN_DING_USERID）：系统报错、同步失败、账号异常、看板空。
// 同类问题 1 小时最多一条，避免上游抖动时把人手机打爆。
const ALERT_COOLDOWN_MS = 60 * 60 * 1000

async function alertAdmin(env, store, kind, text) {
  const adminId = env.ADMIN_DING_USERID || env.DINGTALK_ADMIN_USERID
  if (!adminId) return false
  const key = `alert:${kind}`
  const last = Number((await store.get(key, 0).catch(() => 0)) || 0)
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false

  try {
    const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
    if (!dingMod || typeof dingMod.createDingTalk !== 'function') return false
    const dt = dingMod.createDingTalk(env)
    const r = await dt.sendSingle(adminId, text)
    if (r && r.ok) {
      await store.put(key, Date.now()).catch(() => {})
      return true
    }
  } catch (e) {
    warn('管理员告警发送失败:', safeErrorCategory(e))
  }
  return false
}

// 系统报错入口：别处 catch 到未预期异常时调它
export async function reportError(env, store, where, err) {
  const msg = String((err && err.message) || err || 'unknown').slice(0, 120)
  return alertAdmin(env, store, `error:${where}`, `【等衣·报错】${where}\n${msg}`)
}

/**
 * 自检：把「系统现在是不是正常」变成几条明确结论，有问题私信管理员。
 * 不发群 —— 这些是运维信息，不该打扰学生。
 */
export async function runSelfCheck(env, store) {
  const now = Date.now()
  const buildingId = env.BUILDING_ID || 'b1'
  const issues = []

  const sync = (await store.get('meta:sync', null).catch(() => null)) || {}
  const entry = await store.get(`machines:${buildingId}`, null).catch(() => null)
  const total = Number(entry?.board?.total) || 0

  if (!total) issues.push({ kind: 'board_empty', text: '看板里没有机器数据（上游可能整个挂了）' })

  const lastFetch = sync.lastFetchAt ? new Date(sync.lastFetchAt).getTime() : 0
  if (lastFetch && now - lastFetch > 20 * 60000) {
    issues.push({ kind: 'sync_stale', text: `已经 ${Math.round((now - lastFetch) / 60000)} 分钟没同步成功` })
  }
  if (Number(sync.failCount) >= 3) {
    issues.push({ kind: 'sync_fail', text: `连续 ${sync.failCount} 次同步失败：${sync.lastError || ''}` })
  }

  // 账号池
  const mod = await import('../packages/core/haier.js').catch(() => null)
  if (mod && typeof mod.buildPool === 'function') {
    const kvAccounts = (await store.get('meta:haierAccounts', null).catch(() => null)) || null
    const overrides = (await store.get('meta:haierTokens', null).catch(() => null)) || null
    const pool = mod.buildPool(env, kvAccounts, overrides)
    if (pool.length) {
      const expired = pool.filter((a) => {
        const exp = typeof mod.tokenExpiry === 'function' ? mod.tokenExpiry(a.headers) : null
        return exp && exp <= now
      })
      if (expired.length === pool.length) {
        // token 全过期不一定致命：状态接口匿名也能读（实测 200）。
        // 先匿名探一下，能读就不打扰管理员。
        const anonOk = await probeAnonReadable(env)
        if (!anonOk) {
          issues.push({ kind: 'token_expired', text: '账号池里的 token 全部过期了，匿名也读不到，同步会一直失败' })
        }
      }
      const poolState = (await store.get('meta:haierPool', null).catch(() => null)) || {}
      const cooling = Object.values(poolState.cool || {}).filter((t) => Number(t) > now)
      if (pool.length > 1 && cooling.length === pool.length) {
        issues.push({ kind: 'all_cooling', text: '所有账号都在冷却，上游可能整体被限流' })
      }
    }
  }

  const sent = []
  for (const it of issues.slice(0, 3)) {
    const ok = await alertAdmin(env, store, it.kind, `【等衣·自检】${it.text}`)
    if (ok) sent.push(it.kind)
  }
  await store
    .put('meta:selfCheck', { at: nowISO(), issues: issues.map((i) => i.kind), sent })
    .catch(() => {})
  return { issues, sent }
}

// 匿名能不能读到状态？只打最轻的一个端点，3 秒超时。
// 用途：token 全过期时判断「要不要叫醒管理员」——能匿名读就不算故障。
async function probeAnonReadable(env) {
  const base = String(env.HAIER_URL || '').replace(/\/+$/, '')
  const pid = env.HAIER_POSITION_ID
  if (!base || !pid) return false
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 3000) : null
    const r = await fetch(`${base}/position/floorCodeList?positionId=${encodeURIComponent(pid)}`, {
      signal: ctrl ? ctrl.signal : undefined,
    })
    if (timer) clearTimeout(timer)
    if (!r.ok) return false
    const j = await r.json().catch(() => null)
    return Boolean(j && j.code === 0 && Array.isArray(j.data) && j.data.length)
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// runSync：海乐拉取 → 归一化 → 看板 → diff → 落盘 → 到期提醒
// 返回 { fetched, events, notified }（额外带 error 便于排查）
// ─────────────────────────────────────────────────────────────
const syncJobs = new WeakMap()

// 同一存储/楼栋只运行一次同步；外部回写必须排队，不能被已有抓取吞掉。
export function runSync(env, store, opts = {}) {
  let jobs = syncJobs.get(store)
  if (!jobs) syncJobs.set(store, (jobs = new Map()))
  const key = env.BUILDING_ID || 'b1'
  const previous = jobs.get(key)
  if (previous && !Array.isArray(opts.raws)) return previous
  const job = Promise.resolve(previous).catch(() => null).then(() => runSyncOnce(env, store, opts))
  jobs.set(key, job)
  job.finally(() => {
    if (jobs.get(key) === job) jobs.delete(key)
  }).catch(() => {})
  return job
}

async function runSyncOnce(env, store, opts = {}) {
  env = await loadSiteRuntime(store,env)
  env.SITE_BUILDINGS=(await getSiteConfig(store)).buildings
  const out = { fetched: 0, events: [], notified: 0, error: null }
  const buildingId = env.BUILDING_ID || 'b1'
  const buildingName = env.BUILDING_NAME || '1 号楼'
  // 账号池状态要在 catch 里也能用（失败时给该账号打冷却）
  let pool = null
  let poolState = null
  let picked = null

  try {
    const haierMod = await import('../packages/core/haier.js').catch(() => null)
    const machinesMod = await import('../packages/core/machines.js').catch(() => null)
    if (
      !haierMod ||
      !machinesMod ||
      typeof haierMod.createHaierClient !== 'function' ||
      typeof haierMod.normalizeMachines !== 'function' ||
      typeof machinesMod.buildBoard !== 'function' ||
      typeof machinesMod.diffEvents !== 'function'
    ) {
      out.error = 'peer modules missing: packages/core/haier.js, packages/core/machines.js'
      await store.put('meta:sync', { lastFetchAt: nowISO(), failCount: 1, lastError: out.error }).catch(() => {})
      return out
    }

    // ── 数据来源 ──
    // 默认自己打上游（Edge 直连）；也可以由外部把原始设备列表塞进来
    // （CloudBase 定时函数用另一个出口 IP 抓完 POST 回来，见 docs/EGRESS.md 方案 3）。
    // 归一化、看板、diff、提醒全部还在这一侧，保证只有一份业务逻辑。
    const injected = Array.isArray(opts.raws) && opts.raws.length ? opts.raws : null
    if (opts.source) out.source = opts.source

    if (!injected) {
      // ── 账号池轮询 ──
      // 多个账号轮流打，避免单账号被限流打死；某个账号 401/403/405/429 就冷却 10 分钟。
      // 轮询下标和冷却表存在 meta:haierPool，跨请求/跨边缘节点保持一致。
      // 账号来源优先级：KV 批量导入 > 环境变量账号池 > 单账号 HAIER_HEADERS
      const kvAccounts = await store.get('meta:haierAccounts', null).catch(() => null)
      const kvOverrides = await store.get('meta:haierTokens', null).catch(() => null)
      pool =
        typeof haierMod.buildPool === 'function'
          ? haierMod.buildPool(env, kvAccounts, kvOverrides)
          : haierMod.parseAccountPool(env)
      poolState = (await store.get('meta:haierPool', null)) || { idx: 0, cool: {} }
      picked = pool && pool.length ? pickFromPool(pool, poolState, Date.now()) : null
      if (picked) out.account = picked.index + 1 // 只写序号，不泄露 token
    }
    const clientEnv = picked ? { ...env, HAIER_HEADERS: JSON.stringify(picked.headers) } : env

    const raws = injected || (await haierMod.createHaierClient(clientEnv).fetchStatus())
    const normalized = haierMod.normalizeMachines(raws, haierMod.resolveStateMap(env))
    const cleanupAt=Number(await store.get('assistant:lastPrune',0))
    if(Date.now()-cleanupAt>86400000){await pruneAssistantStorage(store);await store.put('assistant:lastPrune',Date.now())}
    const savedMapping = await store.get(`mapping:${buildingId}`, null)
    for (const machine of normalized) machine.kind = machineKind(machine, savedMapping?.mapping || {})
    // 未提供结束时间时保留未知，清除旧版本按典型程序生成的估时。
    await estimateFinishAt(store, buildingId, normalized)
    let board = machinesMod.buildBoard(normalized, { buildingId, buildingName })
    for (const m of board.floors.flatMap((f)=>f.machines)) m.dormBuilding=resolveMachineDorm(m,savedMapping?.mapping||{},env.SITE_BUILDINGS)
    const operations = await runOperations({store,board,env,notify:async(alert)=>{const uid=env.ADMIN_DING_USERID||env.DINGTALK_ADMIN_USERID;if(!uid)return {dm:{ok:false,error:'not_configured'}};const mod=await import('../packages/core/dingtalk.js');const r=await mod.createDingTalk(env).sendSingle(uid,{title:alert.title,text:alert.message});return {dm:{ok:!!r?.ok,error:r?.err||null}}},broadcast:async({board:summary})=>{
      const mod=await import('../packages/core/dingtalk.js'); const dt=mod.createDingTalk(env)
      const text='【等衣 · 整点洗衣房播报】\n'+mod.buildStatusReply(summary)+'\n\n数据来自海乐生活，请以现场为准。查看各楼机器、排队和代取请打开等衣。'
      if(env.DINGTALK_WEBHOOK)return dt.broadcast(text)
      const group=await store.get('ding:groupConv',null)
      return group?.conversationId ? dt.sendGroup(group.conversationId,text) : {ok:false,err:'group_not_configured'}
    }})
    board=operations.board
    out.operations=operations.broadcast
    out.fetched = Array.isArray(raws) ? raws.length : 0

    const prev = await store.get(`machines:${buildingId}`, null)
    const prevMachines = prev?.board?.floors?.flatMap((f) => f.machines) || []
    const nextMachines = board.floors.flatMap((f) => f.machines)
    out.events = machinesMod.diffEvents(prevMachines, nextMachines) || []

    await store.put(`machines:${buildingId}`, { board, rawUpdatedAt: nowISO() })

    // 预约与收藏共用新鲜快照；各自保存去重和投递状态，不影响主同步。
    const notifyUser = async (uid, notice) => {
      const user = await store.get(`user:${uid}`, null)
      if (!user?.dingUserId || user.disabled || user.blocked || user.notifyOn === false) return { ok: false, skipped: true }
      const catalog = await currentDormCatalog(store, env.SITE_BUILDINGS)
      const machine = notice.machineId && nextMachines.find((item) => String(item.id) === String(notice.machineId))
      if (machine ? !isMachineDormEnabled(machine, catalog, savedMapping?.mapping || {})
        : catalog.some((building) => building.code === user.dormBuilding && building.enabled === false)) return { ok: false, skipped: true }
      const mod = await import('../packages/core/dingtalk.js')
      return mod.createDingTalk(env).sendSingle(user.dingUserId, notice)
    }
    const reminderBoard = { board: enabledMachineBoard(board, await currentDormCatalog(store, env.SITE_BUILDINGS), savedMapping?.mapping || {}), mapping: savedMapping?.mapping || {} }
    const reminders = await Promise.allSettled([
      processQueueReminders({ store, board, env, notify: notifyUser }),
      processFavoriteReminders({ store, board: reminderBoard, env, notify: notifyUser }),
      processCommunityNotices({store,env,notify:(uid,notice)=>notifyCommunityUser(env,store,uid,notice)}),
      pruneCommunityMedia({store,now:Date.now(),limit:20}),
    ])
    out.queueReminders = reminders[0].status === 'fulfilled' ? reminders[0].value : { error: 'unavailable' }
    out.favoriteReminders = reminders[1].status === 'fulfilled' ? reminders[1].value : { error: 'unavailable' }
    out.communityNotices = reminders[2].status === 'fulfilled' ? reminders[2].value : { error: 'unavailable' }
    out.communityMediaGc = reminders[3].status === 'fulfilled' ? reminders[3].value : { error: 'unavailable' }

    // 这次用的账号没问题：解除它的冷却，下标往前拨一格，下次换下一个账号
    if (picked && pool && pool.length) {
      const cool = { ...((poolState && poolState.cool) || {}) }
      delete cool[picked.index]
      await store
        .put('meta:haierPool', {
          idx: (picked.index + 1) % pool.length,
          cool,
          size: pool.length,
          lastOkIndex: picked.index,
          lastOkAt: nowISO(),
        })
        .catch(() => {})
    }
    // lastAttemptAt：不管成败都记「最近一次尝试」，页面刷新按它判断要不要再打上游。
    // 只用 lastFetchAt（成功时间）会让失败时每次刷新都重试 → 越刷越被 WAF 拦。
    await store.put('meta:sync', {
      lastFetchAt: nowISO(),
      lastAttemptAt: Date.now(),
      failCount: 0,
      lastError: null,
      cooldownUntil: 0,
    })

    out.groupNotices = operations.broadcast?.sent ? 1 : 0

    // 故障不主动私信：状态只跟着看板更新，别拿故障去打扰人。
    // （「时间不动」那种卡住才通知，见 detectDryerStuck）

    // 洗完私信：告诉占用者「洗好了」，他回「已取」就能销账
    try {
      out.idleNotices = await notifyIdleOccupants(env, store, out.events)
    } catch (e) {
      warn('洗完私信失败:', safeErrorCategory(e))
      out.idleNotices = 0
    }

    // 到期未通知的任务：Web Push + 钉钉单聊，失败静默记录
    const webpushMod = await import('../packages/core/webpush.js').catch(() => null)
    const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
    const noticeMod = await import('../packages/core/notice.js').catch(() => null)
    const now = nowISO()
    const subs = await store.get('subs', [])
    const taskEntries = await store.list('tasks:')
    let notified = 0

    for (const { key, value } of taskEntries) {
      const userId = key.slice('tasks:'.length)
      const user = await store.get(`user:${userId}`, null)
      // 取衣提醒关闭时不推；旧用户没有这个字段，默认开启
      if (user && (user.disabled || user.blocked || user.notifyOn === false)) continue
      const lead = normalizeLead(user && user.notifyLeadMin)
      const notificationUpdates = new Map()
      for (const original of value) {
        const t = { ...original }
        if (t.done || t.notified || (t.notifyFailed && Date.now() - Date.parse(t.notifyAttemptAt || 0) < 1800000)) continue
        t.notifyAttemptAt = nowISO()
        const left = machinesMod.computeLeftMin(t.endAt, now)
        if (left === null || left > lead) continue
        const currentMachine = nextMachines.find((machine) => String(machine.id) === String(t.machineId)) || { id: t.machineId, name: t.machineName, dormBuilding: t.dormBuilding }
        if (!isMachineDormEnabled(currentMachine, await currentDormCatalog(store, env.SITE_BUILDINGS), savedMapping?.mapping || {})) continue
        let anyOk = false
        // 统一文案：钉钉用卡片（title + markdown），Web Push 用纯文本兜底
        const notice =
          noticeMod && typeof noticeMod.buildTakeNotice === 'function'
            ? noticeMod.buildTakeNotice({
                ...noticeMachine({ id: t.machineId, name: t.machineName, kind: t.kind }, savedMapping?.mapping || {}),
                confirmed: false,
                estimated: t.mode !== 'machine',
                machineName: t.machineName || t.machineId,
                floorCode: t.floorCode,
                leftMin: left > 0 ? left : null,
                endAt: t.endAt,
                leadMin: lead,
              })
            : {
                title: '等衣提醒',
                markdown: '',
                text:
                  left > 0
                    ? `【等衣】${t.machineName || t.machineId} 还有约 ${left} 分钟，准备去取`
                    : `【等衣】${t.machineName || t.machineId} 洗好了，快来取`,
              }
        const text = notice.text
        // 记下有没有推送订阅，写审计时用（作用域只在这条任务里）
        const userSubsCount = (Array.isArray(subs) ? subs : []).filter((s) => s.userId === userId).length

        // Web Push
        if (webpushMod && typeof webpushMod.createWebPush === 'function') {
          const userSubs = (Array.isArray(subs) ? subs : []).filter((s) => s.userId === userId)
          const wp = webpushMod.createWebPush(env)
          for (const s of userSubs) {
            try {
              // subs 结构：{ userId, endpoint, keys, createdAt }，而 webpush.send 需要 { endpoint, keys }
              const sub = s.subscription || { endpoint: s.endpoint, keys: s.keys }
              const r = await wp.send(sub, { type:'done', taskId:t.id, title:notice.title, body:text, text, tag:'task-'+t.id, url:'/#/task' })
              if (r && r.ok) anyOk = true
              if (r && r.gone) {
                // 端点失效，删除该订阅
                const idx = subs.indexOf(s)
                if (idx >= 0) subs.splice(idx, 1)
              }
            } catch {
              /* 静默 */
            }
          }
        }
        // 钉钉单聊（有 markdown 就发卡片，失败自动降级纯文本）
        if (dingMod && typeof dingMod.createDingTalk === 'function' && user && user.dingUserId) {
          try {
            const dt = dingMod.createDingTalk(env)
            const r = await dt.sendSingle(user.dingUserId, notice)
            if (r && r.ok) anyOk = true
          } catch {
            /* 静默 */
          }
        }
        // 两条通道都没发出去就别标记 notified：
        // 任务会在下一轮同步（30 秒后）再试一次。试满 3 次才彻底放弃，
        // 否则一次网络抖动就永久丢了这条提醒。
        if (anyOk) {
          t.notified = true
          notified++
        } else {
          t.notifyTries = (Number(t.notifyTries) || 0) + 1
          if (t.notifyTries >= 3) t.notifyFailed = true
        }
        notificationUpdates.set(t.id, { notified: t.notified, notifyAttemptAt: t.notifyAttemptAt, notifyTries: t.notifyTries, notifyFailed: t.notifyFailed })
        // 提醒结果也留痕：用户说「没收到通知」时，第一件事就是查这条
        await audit(store, {
          type: 'notify',
          action: left > 0 ? '取衣提醒（提前）' : '取衣提醒（到点）',
          actorId: userId,
          actorNick: user?.nick,
          target: t.machineName || t.machineId,
          level: anyOk ? 'info' : 'warn',
          detail: {
            left,
            endAt: t.endAt,
            channels: {
              push: Boolean(userSubsCount),
              dm: Boolean(user && user.dingUserId),
            },
            ok: anyOk,
          },
        })
      }
      if (notificationUpdates.size) await withTaskMutation(store, buildingId, async () => {
        const latest = await store.get(key, [])
        const merged = (Array.isArray(latest) ? latest : []).map((task) => notificationUpdates.has(task.id) && !task.done && !task.takenAt ? { ...task, ...notificationUpdates.get(task.id) } : task)
        await store.put(key, merged)
      }).catch(() => {})
    }
    if (Array.isArray(subs)) await store.put('subs', subs).catch(() => {})
    out.notified = notified
    // 跳闸检测是附加功能：它自己出错不能把整个同步标记成失败
    try {
      out.dryerAlerts = await detectDryerStuck(env, store, nextMachines)
    } catch (e) {
      warn('烘干机跳闸检测异常:', safeErrorCategory(e))
      out.dryerAlerts = 0
    }
  } catch (e) {
    out.error = safeErrorCategory(e)

    // 账号池：如果是鉴权/限流类失败，把这次用的账号冷却 10 分钟，
    // 下次自动换下一个。WAF 是按 IP 封的，轮账号救不了，但「按账号限流」能救；
    // 两种都会走到这里，冷却一下没坏处。
    if (picked && pool && pool.length > 1) {
      const authish = /HAIER HTTP (401|403|405|429)/.test(out.error)
      if (authish) {
        const cool = { ...((poolState && poolState.cool) || {}) }
        cool[picked.index] = Date.now() + 10 * 60 * 1000
        await store
          .put('meta:haierPool', {
            idx: (picked.index + 1) % pool.length,
            cool,
            size: pool.length,
            lastFailIndex: picked.index,
            lastFailAt: nowISO(),
          })
          .catch(() => {})
        out.accountCooled = picked.index + 1
      }
    }
    // 失败时保留上次成功时间，只累加失败次数，管理页才能看出「数据是旧的」。
    // 同时记 lastAttemptAt + cooldownUntil：
    // 上游 405 一般是 WAF 限流，失败后如果每个页面请求都立刻重试，
    // 只会让封禁更久（线上就这么把自己锁死过）。冷却期内一律不主动打上游，
    // 只靠 CloudBase 的 5 分钟定时器去试，恢复后自动写回。
    const prevMeta = (await store.get('meta:sync', null)) || {}
    const failCount = (Number(prevMeta.failCount) || 0) + 1
    const cooldownMs = Math.min(120000, 30000 * failCount) // 30s → 60s → 120s 封顶
    await store
      .put('meta:sync', {
        lastFetchAt: prevMeta.lastFetchAt || null,
        lastAttemptAt: Date.now(),
        failCount,
        lastError: out.error,
        cooldownUntil: Date.now() + cooldownMs,
      })
      .catch(() => {})
    // 同步失败是「看板变旧」的唯一原因，必须留痕（含具体端点，见 requestJson 的错误文案）
    await audit(store, {
      type: 'sync',
      action: '上游同步失败',
      level: 'error',
      target: '海乐上游',
      detail: { error: out.error, failCount, cooldownSec: Math.round(cooldownMs / 1000) },
    })
  }
  // 每次同步顺带自检：系统报错/账号异常/看板空 → 私信管理员。
  // 放在最后、且包住异常：自检本身出问题不能影响同步结果。
  try {
    out.selfCheck = await runSelfCheck(env, store)
  } catch (e) {
    warn('自检失败:', safeErrorCategory(e))
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// createApp 工厂
// ─────────────────────────────────────────────────────────────
export function createApp({ store, env }) {
  if (!store) throw new Error('createApp 需要 store')
  env = env || {}

  const app = new Hono()
  // CORS：前端（Vite 5173 / 独立静态站）跨域访问 API 必须放行
  app.use(
    '*',
    cors({
      origin: (origin) => origin || '*',
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'Idempotency-Key'],
      exposeHeaders: ['X-Event-ID', 'Idempotency-Replayed'],
      maxAge: 86400,
    })
  )

  const authenticateRequest=async c=>{const uid=await bearerUser(c,env);return uid?store.get('user:'+uid,null):null}
  app.use('/api/*',async(c,next)=>{
    await next()
    const vary=new Set((c.res.headers.get('Vary')||'').split(',').map(value=>value.trim()).filter(Boolean));vary.add('Authorization');vary.add('X-Admin-Token');c.header('Vary',[...vary].join(', '))
    if(c.req.header('authorization')||c.req.header('x-admin-token'))c.header('Cache-Control','private, no-store')
  })
  registerAuditMiddleware(app,{store,env,authenticate:authenticateRequest,checkSuperAdmin:c=>checkSuperAdmin(c,env)})
  registerRequestSafety(app,{store,env,authenticate:authenticateRequest})
  registerTaskMutationLock(app,{store,env})
  app.use('/api/user/*',async(c,next)=>{
    if (!['POST','PATCH','PUT','DELETE'].includes(c.req.method) && c.req.path!=='/api/user/dingtalk-avatar') return next()
    const uid=await bearerUser(c,env)
    return uid?withOperationLock(store,'user-profile:'+uid,next):next()
  })
  const isHighest = async (c) => await checkSuperAdmin(c, env) || (await getUserIdentity(store, await bearerUser(c, env))).role === 'super'
  const baseEnv={...env}
  app.use('/api/*',async(c,next)=>{const site=await getSiteConfig(store);env={...await loadSiteRuntime(store,baseEnv),SITE_BUILDINGS:site.buildings};await next()})


  // 看板数据超过这个时间就顺手刷一次，避免「后台每分钟才同步」造成的延迟。
  // 多个客户端同时来也只会有一次上游请求。
  const STALE_MS = Number(env.SYNC_STALE_MS) > 0 ? Number(env.SYNC_STALE_MS) : 30000
  // 首次没有缓存时必须等同步，但不能无限等 —— 上游一慢，首屏就白屏转圈。
  // 超过这个时间就先返回 503 让前端提示重试，同步在后台继续跑，下一次请求直接命中。
  // 6s → 2.5s：实测上游 P95 在 1.2s 左右，等 6 秒纯属让用户干瞪眼。
  const FIRST_WAIT_MS = Number(env.SYNC_WAIT_MS) > 0 ? Number(env.SYNC_WAIT_MS) : 2500
  let inflightSync = null

  // 给 promise 套一个超时，超时返回 false（不抛错，调用方自己决定降级）
  function withTimeout(promise, ms) {
    let timer
    return Promise.race([
      promise.then(() => true).catch(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
    ]).finally(() => clearTimeout(timer))
  }

  // Hono 在没有 ExecutionContext 的宿主上访问 c.executionCtx 会直接抛错
  // （Node 单测、本地 server 形态都是这样），必须包一层。
  function execCtxOf(c) {
    try {
      return (c && c.executionCtx) || null
    } catch {
      return null
    }
  }

  async function refreshIfStale(c, entry) {
    const hasBoard = Boolean(entry && entry.board)
    const meta = (await store.get('meta:sync', null).catch(() => null)) || {}
    const now = Date.now()
    // 失败冷却中：谁都别再打上游（CloudBase 的定时器除外，它直接调 runSync）
    const cool = Number(meta.cooldownUntil) || 0
    if (cool && now < cool) return false
    // 按「最近一次尝试」判断，而不是「最近一次成功」：
    // 失败时不推进 lastFetchAt，若拿它判断，每个刷新都会再打一次上游。
    const lastTry = Number(meta.lastAttemptAt) || 0
    const stale = !hasBoard || !lastTry || now - lastTry > STALE_MS
    if (!stale) return false

    const task =
      inflightSync ||
      (inflightSync = runSync(env, store).finally(() => {
        inflightSync = null
      }))

    // 关键：边缘函数在响应返回后随时可能被回收，光「发出去不管」的 Promise
    // 很可能跑到一半就被掐掉——同步没写库，提醒自然不会发。
    // 有 waitUntil 的运行时把它挂上去，让同步在响应之后继续跑完。
    const ctx = execCtxOf(c)
    let registered = false
    if (ctx && typeof ctx.waitUntil === 'function') {
      try {
        ctx.waitUntil(task)
        registered = true
      } catch {
        /* 某些运行时不支持，走下面兜底 */
      }
    }

    // 第一次没有任何数据，必须等；已有旧数据就先返回，让同步在后台跑
    if (!hasBoard) {
      await withTimeout(task, FIRST_WAIT_MS)
      return true
    }
    // 没有 waitUntil：短暂等一下，尽量让同步至少把提醒这一段跑完
    if (!registered) await withTimeout(task, 2500)
    return true
  }

  // 只要用户打开任意需要看板的页面，就顺带把同步推一下。
  // 之前只有 /api/machines 会触发，用户直接进「我的洗衣」就永远不触发，
  // 表现就是「洗完没人提醒」。
  function kickSync(c) {
    const entry = store.get(`machines:${env.BUILDING_ID || 'b1'}`, null)
    const ctx = execCtxOf(c)
    const job = entry
      .then((e) => refreshIfStale(c, e))
      .catch(() => null)
    if (ctx && typeof ctx.waitUntil === 'function') {
      try {
        ctx.waitUntil(job)
      } catch {
        /* 忽略 */
      }
    }
  }


  registerPermissionMiddleware(app,{store,env,authenticate:async c=>{const uid=await bearerUser(c,env);return uid?store.get('user:'+uid,null):null},checkSuperAdmin:c=>checkSuperAdmin(c,env)})

  // 身份、后台和私有活动始终禁止共享缓存。
  app.use('/api/*', async(c,next)=>{ await next(); if (!['/api/machines','/api/announcements','/api/push/key'].includes(c.req.path)) c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer') })
  app.use('/api/auth/claim',async(c,next)=>withOperationLock(store,'auth:claim',async()=>{await next()}))
  app.use('/api/admin/*',async(c,next)=>{
    if(c.req.path==='/api/admin/login'||await isHighest(c))return next()
    const uid=await bearerUser(c,env)
    if(uid){const role=(await store.get('meta:siteAdmins',[])).find(x=>x.userId===uid)?.role
      if(role==='operator' && !['GET','HEAD','OPTIONS'].includes(c.req.method))return apiErr('forbidden','运维账号仅可读取，修改请联系管理员',403)
      if(role && /^\/api\/admin\/(?:accounts|sync-url|diag-haier|assistant)/.test(c.req.path) && c.req.path!=='/api/admin/assistant')return apiErr('forbidden','此配置需要最高管理员会话',403)
      if(role && c.req.path==='/api/admin/assistant' && c.req.method!=='GET')return apiErr('forbidden','模型配置需要最高管理员会话',403)
    }
    await next()
  })
  app.use('/api/dingtalk/oauth-callback', async(c,next)=>{
    // Hono routes HEAD through GET handlers. Link probes and explicit prefetch
    // requests must not consume the one-use code before the browser arrives.
    const purpose=[c.req.header('Purpose'),c.req.header('Sec-Purpose')].filter(Boolean).join(' ')
    if(c.req.method==='HEAD' || /(?:^|[\s,;])prefetch(?:$|[\s,;])/i.test(purpose))return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}})
    const code=c.req.query('authCode')||c.req.query('code')||''
    const state=c.req.query('state')||''
    if (!code || !state || code.length>2048 || state.length>2048) return next()
    const authMod=await import('../packages/core/auth.js')
    let rec=await authMod.verifyTicket(state,env.AUTH_SECRET).catch(()=>null)
    if (rec?.role!=='login_state' || !/^[a-f0-9]{32,128}$/i.test(rec.d||'')) {
      const legacy=/^[a-z0-9]{16,80}$/i.test(state)?await store.get('oauthstate:'+state,null):null
      rec=legacy && /^[a-f0-9]{32,128}$/i.test(legacy.device||'') && Date.parse(legacy.expAt)>=Date.now()?{d:legacy.device,exp:Date.parse(legacy.expAt)}:null
    }
    if(!rec)return next()
    const hash=async(value)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('')
    const [deviceHash,stateHash,codeHash]=await Promise.all([hash(rec.d),hash(state),hash(code)])
    const key='oauthcallbacks:'+deviceHash
    // Serializes app instances sharing this store. The durable record also
    // catches replays on other instances once KV has propagated; eventual KV
    // alone cannot provide a distributed compare-and-set lock.
    return withOperationLock(store,key,async()=>{
      const now=Date.now(),saved=await store.get(key,[])
      const rows=(Array.isArray(saved)?saved:[]).filter(row=>row.expiresAt>now)
      const found=rows.find(row=>row.stateHash===stateHash)
      if(found){
        if(found.codeHash!==codeHash || !found.redirect){
          c.set('oauthReplayError',found.codeHash===codeHash?'state_processing':'state_used')
          return next()
        }
        c.header('Cache-Control','no-store')
        return c.redirect(new URL(c.req.url).origin+found.redirect)
      }
      const row={stateHash,codeHash,expiresAt:Math.min(rec.exp,now+10*60*1000)}
      const nextRows=[...rows,row].slice(-4)
      // Retain failures too: a timeout may already have consumed the one-use
      // upstream code, so refreshing must start a new authorization instead.
      await store.put(key,nextRows)
      await next()
      const location=c.res.headers.get('location')
      if(location){
        const redirect=new URL(location,new URL(c.req.url).origin)
        if(redirect.origin===new URL(c.req.url).origin && /^#\/login\?(?:k|e)=/.test(redirect.hash)){
          row.redirect='/'+redirect.hash
          await store.put(key,nextRows).catch(()=>{})
        }
      }
      c.header('Cache-Control','no-store')
    })
  })


  // 健康检查（公开）
  app.get('/api/health', (c) => json({ ok: true, mode: env.HAIER_MODE || 'mock' }))

  // 存储自检（管理员）：确认存储是否真的跨请求持久。
  // 关键点：不能在同一请求里「写完再读」就算通过 —— 单请求内存也能过。
  // 这里读上一次请求留下的探针值，能读到才算真持久。
  app.get('/api/debug/storage', async (c) => {
    const token = c.req.query('token') || c.req.header('x-admin-token') || ''
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
      return apiErr('forbidden', '需要管理员口令', 403)
    }
    const info = env.__STORE_INFO__ || { kind: 'unknown', name: null }
    const probeKey = 'probe:last'
    let previous = null
    let wrote = false
    try {
      previous = await store.get(probeKey, null)
      await store.put(probeKey, { at: nowISO(), n: (previous && previous.n ? previous.n : 0) + 1 })
      wrote = true
    } catch (e) {
      wrote = false
    }
    // 能读到上一次的值 → 跨请求持久成立
    const persisted = Boolean(previous && previous.at)
    return json({
      store: info,
      wrote,
      previousAt: previous ? previous.at : null,
      hits: previous ? (previous.n || 0) + 1 : 1,
      // 第一次调用必然是 false，再调一次就应为 true
      persistent: persisted,
      hint: persisted ? '存储已跨请求持久' : '首次调用或存储未持久：再请求一次这个地址，仍为 false 就说明没落盘',
    })
  })

  // 钉钉自检（管理员）：只回报「哪些变量有值」+ 真实换 token 的结果，
  // 不回显任何密钥。排查「配了但发不出去」时先看这里。
  app.get('/api/debug/dingtalk', async (c) => {
    const token = c.req.query('token') || c.req.header('x-admin-token') || ''
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
      return apiErr('forbidden', '需要管理员口令', 403)
    }
    const appKey=String(env.DINGTALK_APP_KEY||'').trim(),appSecret=String(env.DINGTALK_APP_SECRET||'').trim()
    const present = {
      appKey: Boolean(appKey),
      appSecret: Boolean(appSecret),
      robotCode: Boolean(env.DINGTALK_ROBOT_CODE),
      agentId: Boolean(env.DINGTALK_AGENT_ID),
      aesKey: Boolean(env.DINGTALK_AES_KEY),
      token: Boolean(env.DINGTALK_TOKEN),
      webhook: Boolean(env.DINGTALK_WEBHOOK),
    }
    const out = { present, oapi: null, newApi: null, robot: null }
    const credentialsOnly=c.req.query('credentialsOnly')==='1'
    const runtime={abortController:typeof globalThis.AbortController==='function',abortSignalTimeout:typeof globalThis.AbortSignal?.timeout==='function'}
    const {boundedDingTalkFetch,dingTalkResponseDiagnostics}=await import('../packages/core/dingtalk.js')
    const readDiagnostic=async(response)=>{
      let value=null,jsonParsed=false
      try{value=await response.json();jsonParsed=true}catch{/* Never retain raw response text. */}
      const object=value && typeof value==='object' && !Array.isArray(value)?value:null
      return {value:object,diagnostic:{...dingTalkResponseDiagnostics(response),jsonParsed}}
    }

    // 1) 旧版 gettoken —— 必须 GET（POST 会报 43001）
    if (present.appKey && present.appSecret) {
      try {
        const r = await boundedDingTalkFetch(
          `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(
            appKey
          )}&appsecret=${encodeURIComponent(appSecret)}`,
          { method: 'GET',redirect:'manual' }
        )
        const {value:j,diagnostic}=await readDiagnostic(r)
        const ok=r.ok && j?.errcode===0 && typeof j?.access_token==='string' && Boolean(j.access_token)
        out.oapi = { status:r.status,ok,err:ok?undefined:!j?'invalid_response':!r.ok || j.errcode!=null && j.errcode!==0?'upstream_rejected':'invalid_response',diagnostic,errcode:j?.errcode,errmsg:j?.errmsg||'' }
      } catch (e) {
        out.oapi = { ok: false, err: safeErrorCategory(e) }
      }
      // 2) 新版 oauth2/accessToken（api.dingtalk.com 系接口用）
      let newToken = ''
      try {
        const r = await boundedDingTalkFetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
          method: 'POST',
          redirect:'manual',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appKey,
            appSecret,
          }),
        })
        const {value:j,diagnostic}=await readDiagnostic(r)
        newToken = r.ok && typeof j?.accessToken==='string' ? j.accessToken : ''
        out.newApi = {
          status: r.status,
          ok: Boolean(newToken),
          err:newToken?undefined:!j?'invalid_response':!r.ok || j.code?'upstream_rejected':'invalid_response',
          diagnostic,
          code: j?.code || '',
          message: j?.message || '',
        }
      } catch (e) {
        out.newApi = { ok: false, err: safeErrorCategory(e) }
      }

      // Read-only credentials/outbound-connectivity diagnosis: never call a
      // messaging endpoint or echo the provider's text, credentials or tokens.
      if(credentialsOnly){
        const summary=(result)=>({ok:result?.ok===true,status:Number.isInteger(result?.status)?result.status:0,...(result?.diagnostic||{contentType:'missing',contentEncoding:'other',bodyBytes:0,bodyChunkType:'empty',jsonParsed:false}),...(!result?.ok?{err:result?.err||'invalid_response'}:{})})
        return json({present,runtime,oapi:summary(out.oapi),newApi:summary(out.newApi),robot:{skipped:true},eventId:c.get('eventId')},200,{'Cache-Control':'no-store'})
      }

      // 3) 机器人探测：故意用一个不存在的 userId。
      //    - robotCode 无效 → invalidParameter.robotCode.notExsit
      //    - 机器人正常、只是 userId 不存在 → staffId.notExisted（说明鉴权与 robot 都 OK）
      //    这样不会给任何真实用户发消息，也能判断机器人是否可用。
      if (present.robotCode && newToken) {
        try {
          const r = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
            method: 'POST',
            headers: {
              'x-acs-dingtalk-access-token': newToken,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              robotCode: env.DINGTALK_ROBOT_CODE,
              userIds: ['__weshirt_probe_not_a_real_user__'],
              msgKey: 'sampleText',
              msgParam: JSON.stringify({ content: 'probe' }),
            }),
          })
          const j = await r.json().catch(() => ({}))
          const code = j.code || ''
          out.robot = {
            status: r.status,
            // 只有「userId 不存在」才说明机器人和鉴权都正常
            ok: r.ok || code === 'staffId.notExisted',
            code,
            message: j.message || '',
            note:
              code === 'staffId.notExisted'
                ? '机器人可用（仅探测 userId 不存在）'
                : r.ok
                  ? '机器人可用'
                  : '机器人不可用',
          }
        } catch (e) {
          out.robot = { ok: false, err: safeErrorCategory(e) }
        }
      }
    }

    if(credentialsOnly)return json({present,runtime,oapi:{ok:false,status:0,err:'not_configured'},newApi:{ok:false,status:0,err:'not_configured'},robot:{skipped:true},eventId:c.get('eventId')},200,{'Cache-Control':'no-store'})
    out.hint =
      out.oapi && out.oapi.ok
        ? out.robot
          ? out.robot.ok
            ? 'appKey/appSecret 有效，机器人可用；绑定用户在钉钉里发「绑定 <码>」即可收到单聊'
            : 'appKey/appSecret 有效，但机器人不可用：到应用里「机器人」添加能力并发布上线'
          : 'appKey/appSecret 有效（未配置 robotCode，跳过机器人探测）'
        : 'appKey 或 appSecret 无效（钉钉 40095/40096），到「凭证与基础信息」重新复制'

    // 最近一次回调 + 已绑定人数：用来判断「钉钉有没有把消息送到我们这里」
    try {
      out.lastCallback = await store.get('ding:lastCallback', null)
      const binds = await store.list('userByDing:')
      out.boundUsers = Array.isArray(binds) ? binds.length : 0
      // 单聊 / 群聊各收到过多少条：判断「单聊能不能用」的唯一依据。
      // 没出现过的类型也要给 0，否则前端/测试会读到 undefined。
      const rawStats = (await store.get('ding:cbStats', null)) || {}
      out.cbStats = {
        dm: rawStats.dm || { count: 0, lastAt: null },
        group: rawStats.group || { count: 0, lastAt: null },
      }
      out.groupConv = (await store.get('ding:groupConv', null)) || null
    } catch (e) {
      out.lastCallback = null
      out.boundUsers = null
    }
    return json(out)
  })

  // 清理测试数据（管理员，运维用）。只删「明显是测试」的行，避免误伤真实数据：
  //   - 文案命中 TEST_TEXT 的留言
  //   - 昵称在 TEST_NICKS 里的用户所发内容
  // 默认 dry-run，必须显式带 apply=1 才真正落库。
  app.post('/api/admin/purge-test', async (c) => {
    const token = c.req.query('token') || c.req.header('x-admin-token') || ''
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
      return apiErr('forbidden', '需要管理员口令', 403)
    }
    try {
      const apply = c.req.query('apply') === '1'
      const buildingId = env.BUILDING_ID || 'b1'
      const TEST_TEXT = /回归测试|本地测试|线上测试|持久化验证|test-uuid|live-|persist-|local-test/
      const TEST_NICKS = new Set(['持久化验证', '线上测试'])

      const report = {
        applied: apply,
        testUserIds: [],
        messages: 0,
        occupancy: 0,
        queue: 0,
        tasks: 0,
        users: 0,
        uuidMappings: 0,
        probe: false,
      }
      const testUids = new Set()

      // 1) 留言：按文案/昵称识别，顺手收集这些测试用户
      const msgs = await store.get(`messages:${buildingId}`, [])
      const keptMsgs = []
      for (const m of Array.isArray(msgs) ? msgs : []) {
        if (TEST_TEXT.test(String(m.text || '')) || TEST_NICKS.has(m.nick)) {
          report.messages++
          if (m.userId) testUids.add(m.userId)
        } else {
          keptMsgs.push(m)
        }
      }

      // 2) 占用登记：只删测试用户的
      const occ = await store.get(`occupancy:${buildingId}`, {})
      const occMap = occ && typeof occ === 'object' ? { ...occ } : {}
      for (const [mid, v] of Object.entries(occMap)) {
        if (v && (testUids.has(v.userId) || TEST_NICKS.has(v.nick))) {
          delete occMap[mid]
          report.occupancy++
        }
      }

      // 3) 排队
      const ql = await store.get(`queue:${buildingId}`, [])
      const qArr = (Array.isArray(ql) ? ql : []).filter((q) => {
        if (testUids.has(q.userId) || TEST_NICKS.has(q.nick)) {
          report.queue++
          return false
        }
        return true
      })

      // 4) 这些用户的洗衣任务
      for (const uid of testUids) {
        const t = await store.get(`tasks:${uid}`, [])
        if (Array.isArray(t) && t.length) report.tasks += t.length
      }

      report.testUserIds = [...testUids]

      if (apply) {
        await store.put(`messages:${buildingId}`, keptMsgs)
        await store.put(`occupancy:${buildingId}`, occMap)
        await store.put(`queue:${buildingId}`, qArr)
        for (const uid of testUids) {
          if (await store.get(`user:${uid}`, null)) {
            await store.del(`user:${uid}`)
            report.users++
          }
          await store.del(`tasks:${uid}`)
        }
        // userByUuid:* → 指向测试用户的映射也一起清掉，免得 uuid 复用又长回来
        const maps = await store.list('userByUuid:')
        for (const { key, value } of maps) {
          if (testUids.has(value)) {
            await store.del(key)
            report.uuidMappings++
          }
        }
        if (await store.get('probe:last', null)) {
          await store.del('probe:last')
          report.probe = true
        }
      }

      return json(report)
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 匿名身份：生成/续用 user，返回 token
  // 会话续用（设备密钥换 token）
  //
  // 注意：这里**不再新建用户**。身份只能由钉钉登录产生。
  // 以前这里会「没有就建一个匿名用户」，导致换设备/清缓存就变成另一个人；
  // 现在没有设备密钥绑定就返回 need_login，前端引导去钉钉授权。
  app.post('/api/auth', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const seed = body && body.device
      const device = typeof seed === 'string' && /^[a-f0-9]{32,128}$/i.test(seed) ? seed.toLowerCase() : ''
      if (!device) return apiErr('need_login', '请先用钉钉登录', 401)

      const userId = await store.get(`userByDevice:${device}`, null)
      const user = userId ? await store.get(`user:${userId}`, null) : null
      if (!user) {
        // 设备密钥没绑定过（或用户被删了）→ 清掉脏绑定，让前端重新登录
        if (userId) await store.del(`userByDevice:${device}`)
        return apiErr('need_login', '请先用钉钉登录', 401)
      }

      const secret = authSecret(env)
      if (!secret)
        return apiErr('not_configured', '服务缺少 AUTH_SECRET 配置，暂时无法登录', 503)
      const token = await issueToken(user.id, secret)
      return json({ token, user: publicUser(user) })
    } catch (e) {
      return apiErr('auth_failed', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 退出登录：解绑当前设备密钥（下次打开需要重新用钉钉登录）
  app.post('/api/auth/logout', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const seed = body && body.device
      const device = typeof seed === 'string' && /^[a-f0-9]{32,128}$/i.test(seed) ? seed.toLowerCase() : ''
      if (device) await store.del(`userByDevice:${device}`)
      return json({ ok: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 用一次性码换身份（公开）：钉钉登录找回旧账号后，避免把 token 放在 URL 里
  app.post('/api/auth/claim', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const code = String((body && body.code) || '')
      if (code.length < 16 || code.length > 512) return apiErr('bad_code', '取回码不合法')

      // 新格式：签名票据（不依赖 KV）。老格式：claim:<code> 记录，保留兼容。
      let userId = ''
      try {
        const authMod = await import('../packages/core/auth.js')
        const t = await authMod.verifyTicket(code, env.AUTH_SECRET)
        if (t && t.u && t.role==='login_claim') {
          if(t.role==='login_claim') {
            if(!t.d || t.d !== body.device || !t.nonce) return apiErr('bad_code','登录设备不匹配，请重新登录',400)
            const usedKey='usedclaim:'+t.nonce
            if(await store.get(usedKey,null))return apiErr('bad_code','登录凭证已使用，请重新登录',400)
            await store.put(usedKey,{exp:t.exp})
          }
          userId=String(t.u)
        }
      } catch {
        /* 落到老格式 */
      }

      let merged = null
      if (!userId) {
        if (!/^[a-z0-9]{16,64}$/i.test(code)) return apiErr('bad_code', '取回码无效或已使用，请重新登录')
        const rec = await store.get(`claim:${code}`, null)
        if (!rec || !rec.userId) return apiErr('bad_code', '取回码无效或已使用，请重新登录')
        if (new Date(rec.expAt).getTime() < Date.now()) {
          await store.del(`claim:${code}`)
          return apiErr('bad_code', '取回码已过期，请重新登录')
        }
        // 一次性：先删再签发，避免重放
        await store.del(`claim:${code}`)
        userId = rec.userId
        merged = rec.merged || null
      }

      const user = await store.get(`user:${userId}`, null)
      if (!user) return apiErr('not_found', '账号不存在', 404)
      const secret = authSecret(env)
      if (!secret)
        return apiErr('not_configured', '服务缺少 AUTH_SECRET 配置，暂时无法登录', 503)
      const token = await issueToken(user.id, secret)
      return json({ token, user: publicUser(user), merged })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 取回码换身份（公开）
  // ⚠ 已下线：/api/auth/takecode
  //
  // 这条路由原来是「拿 6 位数字取回码换 token」。问题是：
  //   1) 只有 1e6 种可能，没有频控、没有过期、没有使用次数限制 —— 穷举就能登录任意账号；
  //   2) 前端早就改成签名票据（/api/auth/claim），这条已经没有任何调用方；
  //   3) takeCode 还印在用户资料里，等于把半把钥匙贴在墙上。
  // 保留一个明确的 410，方便旧客户端/脚本看到清晰原因，而不是 404 猜。
  app.post('/api/auth/takecode', async (c) =>
    apiErr('gone', '取回码登录已停用，请用钉钉登录', 410)
  )

  // 当前用户（鉴权）
  app.get('/api/auth/me', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      // 查不到就重建（不再返回 404）：见 getUserOrRebuild 注释
      const user = await getUserOrRebuild(store, userId)
      if (user.transient) return apiErr('account_out_of_sync', '账号资料正在同步，请稍后重试，当前昵称将保留', 409)
      return json({ user: publicUser(user) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 看板（公开；无看板时尝试补一次同步）
  app.get('/api/machines', async (c) => {
    try {
      const dorm = c.req.query('dorm') || ''
      if (dorm && !normalizeDormBuilding(dorm,env.SITE_BUILDINGS)) return apiErr('bad_param', '住宿楼无效')
      const buildingId = c.req.query('building') || env.BUILDING_ID || 'b1'
      let entry = await store.get(`machines:${buildingId}`, null)
      // 数据超过 STALE_MS（默认 30s）就顺带刷新，前端轮询即可拿到接近实时的状态
      if (await refreshIfStale(c, entry)) {
        entry = await store.get(`machines:${buildingId}`, null)
      }
      if (!entry || !entry.board) {
        return apiErr('board_unavailable', '看板正在同步，稍后再试', 503)
      }
      // 二次确认「已恢复」的机器：海乐仍报故障时，看板改成可再上报，不继续当故障机
      const [overrides, savedMapping, health] = await Promise.all([
        store.get(`faults:${buildingId}`, {}),
        store.get(`mapping:${buildingId}`, null),
        store.get(`operations:health:${buildingId}`, {}),
      ])
      const slotMap = savedMapping?.mapping || {}
      const map = overrides && typeof overrides === 'object' ? overrides : {}
      let board = applyMachineHealth(JSON.parse(JSON.stringify(entry.board)), health)
      for (const floor of board.floors || []) {
        for (const m of floor.machines || []) {
          m.kind = machineKind(m, slotMap)
          m.dormBuilding = resolveMachineDorm(m, slotMap,env.SITE_BUILDINGS)
          m.slot = Object.entries(slotMap).find(([, id]) => String(id) === String(m.id))?.[0] || null
          m.displayName = m.slot ? `${m.slot.replace(/^D/i,'')}号${m.kind==='dryer'?'烘干机':'洗衣机'}` : m.name
          const ov = map[m.id]
          if (ov && ov.state === 'recovered' && Date.now()-Date.parse(ov.recoveredAt)<3600000 && (m.state === 'faulty' || m.health?.suspectedFault)) {
            const upstream = m.upstreamState || 'unknown'
            m.state = ['idle','occupied','abnormal'].includes(upstream) ? upstream : 'unknown'
            m.health = { ...m.health, confirmedFault:false, recovering:false, suspectedFault:upstream==='faulty', label:upstream==='faulty'?'现场已报恢复，设备状态待复核':'' }
            m.faultOverride = 'recovered'
          }
        }
      }
      const occupancy=await store.get(`occupancy:${buildingId}`,{})
      const ownerIds=[...new Set(Object.values(occupancy||{}).map(o=>o?.userId).filter(id=>typeof id==='string'))]
      const tasksByUser=new Map(await Promise.all(ownerIds.map(async id=>[id,await store.get('tasks:'+id,[])])))
      board=applyRegisteredAvailability(board,{occupancy,tasksByUser})
      board.floors=(board.floors||[]).map(floor=>({...floor,machines:(floor.machines||[]).filter(machine=>!env.SITE_BUILDINGS.some(building=>building.enabled===false&&building.code===resolveMachineDorm(machine,slotMap,env.SITE_BUILDINGS)))})).filter(floor=>floor.machines.length)
      if (dorm) {
        board.floors = filterDormFloors({ ...board, slotMapping: slotMap }, dorm,env.SITE_BUILDINGS)
        board.dormBuilding = dorm
        board.buildingName = dormBuildingName(dorm,env.SITE_BUILDINGS)
      }
      const visible = board.floors.flatMap((floor) => floor.machines || [])
      board.total = visible.length
      board.idle = visible.filter((m) => m.state === 'idle').length
      board.occupied = visible.filter((m) => ['occupied', 'abnormal'].includes(m.state)).length
      board.faulty = visible.filter((m) => m.state === 'faulty').length
      board.unknown = visible.filter((m) => m.state === 'unknown').length
      // 公开数据，允许浏览器/边缘短暂缓存：
      // 多个用户同时打开看板时，5s 内只有一个人真的打到我们这套函数上。
      // stale-while-revalidate 让过期后先给旧数据、后台再刷，避免用户等着转圈。
      return json(
        { board, mapping: dorm && dorm !== 'guiyuan' ? {} : slotMap },
        200,
        { 'Cache-Control': 'public, max-age=5, stale-while-revalidate=25' }
      )
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 我的任务列表（鉴权）
  app.get('/api/tasks', async (c) => {
    try {
      // 打开「我的洗衣」也推动一次看板同步：
      // 提醒是同步里发的，如果只有 3D 页面才触发，直接进这个页面的用户就永远收不到。
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      kickSync(c)
      const [list, savedMapping, cachedBoard] = await Promise.all([
        store.get(`tasks:${userId}`, []),
        store.get(`mapping:${env.BUILDING_ID || 'b1'}`, null),
        store.get(`machines:${env.BUILDING_ID || 'b1'}`, null),
      ])
      const boardMachines = cachedBoard?.board?.floors?.flatMap((f) => f.machines) || []
      const now = nowISO()
      const nowMs = Date.now()
      const tasks = await Promise.all(
        (Array.isArray(list) ? list : []).map(async (t) => {
          const endMs = t.endAt ? new Date(t.endAt).getTime() : NaN
          const ended = Number.isFinite(endMs) && endMs <= nowMs
          return {
            id: t.id,
            ...taskDetailsView(t),
            machineId: t.machineId,
            machineName: t.machineName,
            kind: machineKind(boardMachines.find((m) => String(m.id) === String(t.machineId)) || { id: t.machineId, name: t.machineName, kind: t.kind }, savedMapping?.mapping || {}),
            mode:t.mode||'duration', minutes:t.minutes, timingSource:t.timingSource||(t.mode==='machine'?'upstream':'user'), estimated:t.estimated===true,
            ...(t.program==='self_clean'?{program:'self_clean'}:{}),
            startAt: t.startAt,
            endAt: t.endAt,
            leftMin: await computeLeftMin(t.endAt, now),
            // 结束后过了多少分钟（>=0）。前端靠它区分「即将完成」和「早就洗完了」，
            // 之前只给 leftMin（负数被夹成 0），三天前的任务也会显示「即将完成」。
            overdueMin: ended ? Math.floor((nowMs - endMs) / 60000) : 0,
            done: !!t.done,
            takenAt: t.takenAt || null,
            // 待取 / 已取：洗完没确认 = pending，确认过 = taken，还没洗完 = waiting
            takeState: t.done ? 'taken' : ended ? 'pending' : 'waiting',
          }
        })
      )
      return json({ tasks })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 确认已取衣：把任务标成完成，并清掉这台机器的占用登记
  // （和删除的区别：保留一条「已完成」记录，用户能看到自己什么时候取的）
  app.post('/api/tasks/:id/take', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const id = c.req.param('id')
      const list = await store.get(`tasks:${userId}`, [])
      const arr = Array.isArray(list) ? list : []
      const task = arr.find((t) => t.id === id)
      if (!task) return apiErr('not_found', '任务不存在或已删除', 404)

      task.done = true
      task.takenAt = nowISO()
      await store.put(`tasks:${userId}`, arr)

      // 清占用：只清「本来就是我占的」那台，别误删别人后来登记的记录
      const buildingId = env.BUILDING_ID || 'b1'
      if (task.machineId) {
        const occ = await store.get(`occupancy:${buildingId}`, {})
        const occMap = occ && typeof occ === 'object' ? occ : {}
        if (ownsTaskOccupancy(occMap[task.machineId], task, userId)) {
          delete occMap[task.machineId]
          await store.put(`occupancy:${buildingId}`, occMap)
        }
      }

      await audit(store, {
        type: 'task',
        action: '确认已取衣',
        actorId: userId,
        target: task.machineName || task.machineId,
        detail: { taskId: task.id, endAt: task.endAt },
      })
      return json({ ok: true, task })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 登记任务（鉴权）
  app.post('/api/tasks', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return apiErr('bad_param', '登记内容须为 JSON 对象')
      const { machineId, minutes, note, mode, useDisinfectant, selfCleaned, program } = body
      if(program!==undefined&&program!==null&&program!=='self_clean')return apiErr('bad_param','所选程序无效')
      if (!machineId) return apiErr('bad_param', '缺少 machineId')
      if (Object.hasOwn(body, 'note') && typeof note !== 'string') return apiErr('bad_param', '备注必须是文字')
      const noteText = normalizeTaskNote(note)
      if (Array.from(noteText).length > 200) return apiErr('bad_param', '备注最多 200 个字')
      if (Object.hasOwn(body, 'useDisinfectant') && typeof useDisinfectant !== 'boolean') return apiErr('bad_param', '是否使用消毒液须为布尔值')
      if (Object.hasOwn(body, 'selfCleaned') && typeof selfCleaned !== 'boolean') return apiErr('bad_param', '自清洁记录须为布尔值')
      const buildingId = env.BUILDING_ID || 'b1'
      const entry = await store.get(`machines:${buildingId}`, null)
      const savedMapping = await store.get(`mapping:${buildingId}`, null)
      const found = entry?.board?.floors
        ?.flatMap((f) => f.machines)
        ?.find((m) => String(m.id) === String(machineId))
      const kind = machineKind(found || { id: machineId }, savedMapping?.mapping || {})
      const isDryer = kind === 'dryer'

      // 机器必须真的在看板里，否则会写进一条「幽灵占用」（催取、看板都查不到）。
      // 但看板可能是空的（首次启动 / 上游挂了），那种情况不拦，别把人挡在门外。
      const boardKnown = Boolean(entry?.board?.floors?.length)
      if (boardKnown && !found) return apiErr('not_found', '这台机器不在当前楼栋的看板里', 404)
      const foundDorm=found&&resolveMachineDorm(found,savedMapping?.mapping||{},env.SITE_BUILDINGS)
      if(foundDorm&&env.SITE_BUILDINGS.some(building=>building.code===foundDorm&&building.enabled===false))return apiErr('building_disabled','此住宿楼已停用，请选择其他楼栋',403)

      // 两种登记方式：
      //   mode='machine' —— 按这台机器自己的剩余时间来提醒（默认，最符合直觉：
      //                    面板上写着「剩余 12 分钟」，通知就该在 12 分钟后响）
      //   否则按用户选的整数时长；不把程序时长锁死在几个预设档位。
      let mins = 0
      let endAt = null

      if (mode === 'machine') {
        // 以服务端看板数据为准，不信前端传的分钟数
        const finishMs = found?.finishAt ? new Date(found.finishAt).getTime() : NaN
        const left = Number(found?.leftMin)
        if (Number.isFinite(finishMs) && finishMs > Date.now()) {
          // 直接用上游的完成时间，比 now+left 更准（看板数据可能已经缓存了 30 秒）
          endAt = new Date(finishMs).toISOString()
          mins = Math.max(1, Math.round((finishMs - Date.now()) / 60000))
        } else if (Number.isFinite(left) && left > 0) {
          mins = Math.min(240, Math.max(1, Math.round(left)))
        } else {
          return apiErr('bad_param', '这台机器目前没有剩余时间，请选择时长')
        }
      } else if (isDryer) {
        const n = typeof minutes==='number'||typeof minutes==='string'&&/^\d+$/.test(minutes.trim()) ? Number(minutes) : NaN
        if (!Number.isInteger(n) || n < 10 || n > 180)
          return apiErr('bad_param', '烘干时长请填 10~180 分钟')
        mins = Math.round(n)
      } else {
        const n = typeof minutes==='number'||typeof minutes==='string'&&/^\d+$/.test(minutes.trim()) ? Number(minutes) : NaN
        if (!Number.isInteger(n)||n<1||n>180)
          return apiErr('bad_param', '洗衣或自洁时长请填 1–180 分钟整数')
        mins = n
      }
      if(program==='self_clean'&&(isDryer||mode==='machine'||mins!==6))return apiErr('bad_param','桶自洁请明确选择六分钟洗衣机程序')

      const startAt = nowISO()
      if (!endAt) endAt = new Date(Date.now() + mins * 60000).toISOString()

      // 机器名从看板取（取不到则回退 machineId）
      let machineName = machineId
      if (found) machineName = found.name || machineId

      // 并发优化：下面几次读互不依赖，一次性并发取，减少串行往返
      const [user, occ, qList] = await Promise.all([
        getUserOrRebuild(store, userId),
        store.get(`occupancy:${buildingId}`, {}),
        store.get(`queue:${buildingId}`, []),
      ])

      const current = occ && typeof occ === 'object' ? occ[machineId] : null
      if (current?.userId && current.userId !== userId && Date.parse(current.endAt) >= Date.now() - DAY_MS) return apiErr('machine_occupied', '这台机器已有他人登记，请刷新确认现场状态', 409)
      if (user.transient) return apiErr('account_out_of_sync', '账号资料正在同步，请稍后登记', 409)
      const task = {
        id: 't_' + randomCode(10),
        machineId,
        machineName,
        kind,
        // 楼层留着给通知文案用（「桂园1楼7号机 · 1 楼」比只写机器名清楚）
        floorCode: found?.floorCode || '',
        startAt,
        endAt,
        // 登记方式：machine=跟着机器剩余时间，duration=用户自己选的时长
        mode: mode === 'machine' ? 'machine' : 'duration',
        minutes: mins,
        timingSource:mode==='machine'?(found?.estimated?'estimate':'upstream'):'user',
        estimated:mode==='machine'&&found?.estimated===true,
        ...(program==='self_clean'?{program:'self_clean'}:{}),
        note: noteText,
        useDisinfectant: useDisinfectant === true,
        selfCleaned: selfCleaned === true,
        done: false,
        notified: false,
      }
      const list = await store.get(`tasks:${userId}`, [])
      const tasks = Array.isArray(list) ? list : []
      tasks.push(task)
      await store.put(`tasks:${userId}`, tasks)

      // 占用登记：记录"谁在这台机器上开洗"（面板展示头像+昵称打码+几分钟前）
      const occMap = occ && typeof occ === 'object' ? { ...occ } : {}
      occMap[machineId] = {
        taskId: task.id,
        userId,
        nick: user.nick,
        avatar: normalizeAvatar(user.avatar),
        avatarUrl: normalizeAvatarUrl(user.avatarUrl),
        startAt,
        endAt,
      }

      // 开洗（任意机器）= 自动退出自己的所有排队
      const qArr = Array.isArray(qList) ? qList : []
      const qNext = qArr.filter((q) => q.userId !== userId)

      // 上面三次写也并发落盘
      await Promise.all([
        store.put(`occupancy:${buildingId}`, occMap),
        qNext.length !== qArr.length ? store.put(`queue:${buildingId}`, qNext) : Promise.resolve(),
        // 有人重新登记这台机器 → 「提醒取衣」的累计次数与冷却清零
        store.del(`urgecount:${buildingId}:${machineId}`),
        store.del(`urge:${buildingId}:${machineId}`),
      ])

      await audit(store, {
        type: 'task',
        action: '登记洗衣',
        actorId: userId,
        actorNick: user.nick,
        target: `${machineName}（${machineId}）`,
        detail: {
          mode: task.mode,
          minutes: mins,
          endAt,
          hasNote: Boolean(noteText),
          useDisinfectant: task.useDisinfectant,
          selfCleaned: task.selfCleaned,
        },
      })
      return json({
        task: {
          id: task.id,
          ...taskDetailsView(task),
          machineId: task.machineId,
          machineName: task.machineName,
          kind: task.kind,
          mode:task.mode, minutes:task.minutes, timingSource:task.timingSource, estimated:task.estimated,
          startAt: task.startAt,
          endAt: task.endAt,
          leftMin: await computeLeftMin(task.endAt, startAt),
          done: false,
        },
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 删除任务（鉴权）
  app.delete('/api/tasks/:id', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const id = c.req.param('id')
      const list = await store.get(`tasks:${userId}`, [])
      const removed = (Array.isArray(list) ? list : []).find((t) => t.id === id)
      const next = (Array.isArray(list) ? list : []).filter((t) => t.id !== id)
      await store.put(`tasks:${userId}`, next)
      // 同步清掉该机的占用登记（如果占用者就是这个人）
      if (removed?.machineId) {
        const buildingId = env.BUILDING_ID || 'b1'
        const occ = await store.get(`occupancy:${buildingId}`, {})
        const occMap = occ && typeof occ === 'object' ? occ : {}
        if (ownsTaskOccupancy(occMap[removed.machineId], removed, userId)) {
          delete occMap[removed.machineId]
          await store.put(`occupancy:${buildingId}`, occMap)
        }
      }
      return json({ ok: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // Web Push 公钥（公开）：前端订阅时要用，之前只能靠页面注入变量，注入不到就永远订阅失败
  app.get('/api/push/key', (c) =>
    json({ key: env.VAPID_PUBLIC_KEY || '', enabled: Boolean(env.VAPID_PUBLIC_KEY) })
  )

  // Web Push 订阅（鉴权）
  app.post('/api/push/subscribe', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const subscription = body && body.subscription
      const pushMod = await import('../packages/core/webpush.js')
      const valid = await pushMod.validatePushSubscription(subscription)
      if (!valid.ok) return apiErr('bad_param','推送订阅无效，请重新开启通知')
      const subs = await store.get('subs', [])
      const arr = Array.isArray(subs) ? subs : []
      const idx = arr.findIndex((s) => s.endpoint === subscription.endpoint)
      const rec = { userId, endpoint: subscription.endpoint, keys: subscription.keys, createdAt: nowISO() }
      if (idx >= 0 && arr[idx].userId !== userId) return apiErr('conflict','此浏览器订阅仍属于另一账号，请先取消浏览器订阅后重试',409)
      if (idx >= 0) arr[idx] = rec
      else arr.push(rec)
      await store.put('subs', arr)
      return json({ ok: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 取消订阅（鉴权）
  app.post('/api/push/unsubscribe', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const endpoint = body && body.endpoint
      const subs = await store.get('subs', [])
      const arr = (Array.isArray(subs) ? subs : []).filter((s) => s.userId !== userId || s.endpoint !== endpoint)
      await store.put('subs', arr)
      return json({ ok: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 推送测试（鉴权）
  app.post('/api/push/test', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const webpushMod = await import('../packages/core/webpush.js').catch(() => null)
      let sent = 0
      let failed = 0
      if (webpushMod && typeof webpushMod.createWebPush === 'function') {
        const subs = await store.get('subs', [])
        const userSubs = (Array.isArray(subs) ? subs : []).filter((s) => s.userId === userId)
        const wp = webpushMod.createWebPush(env)
        for (const s of userSubs) {
          try {
            const r = await wp.send(s.subscription || {endpoint:s.endpoint,keys:s.keys}, {type:'test', title:'等衣 · 通知测试', body:'浏览器通知已连接，洗衣提醒将在这里显示。',url:'/#/settings'})
            if (r && r.ok) sent++
            else failed++
          } catch {
            failed++
          }
        }
      } else {
        failed = 0 // 模块未就绪：如实返回 0/0
      }
      return json({ sent, failed })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 故障二次确认：点「恢复正常」并确认后，忽略海乐故障态，机器重新可上报
  app.post('/api/faults/recover', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const machineId = body && body.machineId
      if (!machineId) return apiErr('bad_param', '缺少 machineId')
      const buildingId = env.BUILDING_ID || 'b1'
      const key = `faults:${buildingId}`
      const cur = await store.get(key, {})
      const map = cur && typeof cur === 'object' ? cur : {}
      const recoveredAt = nowISO()
      map[machineId] = { state: 'recovered', userId, recoveredAt }
      await store.put(key, map)
      return json({ ok: true, recoveredAt })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 标记机器（鉴权，30 分钟过期）
  app.post('/api/marks', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const { machineId, note } = body || {}
      if (!machineId) return apiErr('bad_param', '缺少 machineId')
      const expAt = new Date(Date.now() + MARKS_TTL_MS).toISOString()
      await store.put(`marks:${machineId}`, { userId, note: note || '', expAt })
      return json({ ok: true, expiresAt: expAt })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 占用查询（公开读；昵称打码）：每台机器当前是谁在用、几分钟前登记的
  app.get('/api/occupancy', async (c) => {
    try {
      const buildingId = c.req.query('building') || env.BUILDING_ID || 'b1'
      const dorm=c.req.query('dorm')||''
      if(dorm&&!normalizeDormBuilding(dorm,env.SITE_BUILDINGS))return apiErr('bad_param','住宿楼无效')
      const [occ,entry,mapping]=await Promise.all([store.get(`occupancy:${buildingId}`, {}),store.get(`machines:${buildingId}`,null),store.get(`mapping:${buildingId}`,null)])
      const machineDorms=new Map((entry?.board?.floors||[]).flatMap(floor=>floor.machines||[]).map(machine=>[String(machine.id),resolveMachineDorm(machine,mapping?.mapping||{},env.SITE_BUILDINGS)]))
      const occMap = occ && typeof occ === 'object' ? { ...occ } : {}
      const now = Date.now()
      const out = {}
      const machineFilter = c.req.query('machineId') || ''
      const taskCache = new Map()
      const removals = new Map()
      for (const [machineId, o] of Object.entries(occMap)) {
        if (machineFilter && machineId !== machineFilter) continue
        const machineDorm=machineDorms.get(machineId)
        if(dorm&&machineDorm!==dorm||env.SITE_BUILDINGS.some(building=>building.code===machineDorm&&building.enabled===false))continue
        // 到点自动过期
        if (!o || !o.endAt || new Date(o.endAt).getTime() < now - DAY_MS) {
          delete occMap[machineId]
          removals.set(machineId, o)
          continue
        }
        if(!taskCache.has(o.userId))taskCache.set(o.userId,await store.get(`tasks:${o.userId}`,[]))
        const tasks=taskCache.get(o.userId)
        const task=(Array.isArray(tasks)?tasks:[]).find((t)=>t.id===o.taskId || (!o.taskId && t.machineId===machineId && t.startAt===o.startAt))
        if(task?.done || task?.takenAt){delete occMap[machineId];removals.set(machineId,o);continue}
        out[machineId] = {
          userId: o.userId,
          suspectedUncollected: Boolean(task && Date.parse(task.endAt)<now-300000),
          care: task ? { ...taskDetailsView(task), source: 'user_report' } : null,
          nick: maskNick(o.nick),
          avatar: o.avatar || '',
          avatarUrl: normalizeAvatarUrl(o.avatarUrl),
          startMin: Math.max(0, Math.round((now - new Date(o.startAt).getTime()) / 60000)),
        }
      }
      if (removals.size) await withTaskMutation(store, buildingId, async () => {
        const latest = await store.get(`occupancy:${buildingId}`, {})
        const next = { ...(latest && typeof latest === 'object' ? latest : {}) }
        let changed = false
        for (const [id, old] of removals) {
          if (JSON.stringify(next[id]) === JSON.stringify(old)) { delete next[id]; changed = true }
        }
        if (changed) await store.put(`occupancy:${buildingId}`, next)
      })
      return json({ occupancy: out })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 催促（鉴权）：给占用者发钉钉 DING；每台机器 5 分钟内只能催一次
  app.post('/api/urge', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const machineId = (body && body.machineId) || ''
      if (!machineId) return apiErr('bad_param', '缺少 machineId')
      const buildingId = env.BUILDING_ID || 'b1'

      // 限频：每台机器 5 分钟一次
      const lastKey = `urge:${buildingId}:${machineId}`
      const countKey = `urgecount:${buildingId}:${machineId}`
      const last = await store.get(lastKey, 0)
      const waitMs = 5 * 60 * 1000
      const elapsed = Date.now() - Number(last || 0)
      if (elapsed < waitMs) {
        const leftSec = Math.ceil((waitMs - elapsed) / 1000)
        return apiErr('rate_limited', `刚提醒过了，${leftSec} 秒后可以再点（同一台 5 分钟一次）`, 429)
      }

      const occ = await store.get(`occupancy:${buildingId}`, {})
      const entry = occ && typeof occ === 'object' ? occ[machineId] : null
      if (!entry || !entry.userId) return apiErr('not_found', '这台机器没有登记中的占用记录', 404)
      if (entry.userId === userId) return apiErr('bad_param', '不能提醒自己')

      const target = await store.get(`user:${entry.userId}`, null)

      // 累计点击次数：每台机器独立计数，换人登记时清零（见 POST /api/tasks）
      const count = Number((await store.get(countKey, 0)) || 0) + 1
      await store.put(countKey, count)
      await store.put(lastKey, Date.now())

      // 尽量还发钉钉（对方绑了就有用）；发不出去也不算失败
      let dmSent = false
      let groupSent = false
      if (target && target.dingUserId && target.notifyOn !== false) {
        try {
          const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
          if (dingMod && typeof dingMod.createDingTalk === 'function') {
            const dt = dingMod.createDingTalk(env)
            const noticeMod = await import('../packages/core/notice.js').catch(() => null)
            // 机器名从看板取，通知里写机器名比写「你的衣服」有用得多
            const board = await store.get(`machines:${buildingId}`, null).catch(() => null)
            const m = board?.board?.floors
              ?.flatMap((f) => f.machines)
              ?.find((x) => x.id === machineId)
            const notice =
              noticeMod && typeof noticeMod.buildUrgeNotice === 'function'
                ? noticeMod.buildUrgeNotice({
                    machineName: m?.name || machineId,
                    floorCode: m?.floorCode,
                    count,
                  })
                : {
                    text: `【等衣】有人在等你取衣：${m?.name || machineId}，麻烦尽快取走`,
                  }
            const r = await dt.sendSingle(target.dingUserId, notice)
            dmSent = Boolean(r && r.ok)
          }
        } catch (e) {
          warn('urge 钉钉发送失败:', safeErrorCategory(e))
        }
      }

      // 累计第 3 次：不再直接给手机号，改为要求「确认无桶 + 两张照片」后单独申请
      // （见 POST /api/urge/reveal，会留档上报人 ID 与照片）
      await audit(store, {
        type: 'urge',
        action: '催促取衣',
        actorId: userId,
        target: `${machineId}`,
        detail: { count, dmSent, groupSent, needProof: count >= 3, to: entry.userId },
      })
      return json({
        ok: true,
        count,
        dmSent,
        groupSent,
        needProof: count >= 3,
        hint: count >= 3
          ? '已提醒 3 次，如需查看对方手机号，请按流程上传凭证'
          : groupSent || dmSent
            ? '已私信提醒对方'
            : '对方未接收私信提醒，需要时可继续申请凭证流程',
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 烘干机疑似跳闸：主动通知该机器的占用者（每台 30 分钟最多一次）
  app.post('/api/dryer/stuck', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const machineId = (body && body.machineId) || ''
      if (!machineId) return apiErr('bad_param', '缺少 machineId')
      const buildingId = env.BUILDING_ID || 'b1'

      const key = `dryerstuck:${buildingId}:${machineId}`
      const last = Number((await store.get(key, 0)) || 0)
      if (Date.now() - last < 30 * 60 * 1000) return json({ ok: true, skipped: true })

      const occ = await store.get(`occupancy:${buildingId}`, {})
      const entry = occ && typeof occ === 'object' ? occ[machineId] : null
      if (!entry || !entry.userId) return apiErr('not_found', '这台机器没有登记中的占用记录', 404)

      const target = await store.get(`user:${entry.userId}`, null)
      let dmSent = false
      if (target && target.dingUserId && target.notifyOn !== false) {
        try {
          const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
          if (dingMod && typeof dingMod.createDingTalk === 'function') {
            const dt = dingMod.createDingTalk(env)
            const noticeMod = await import('../packages/core/notice.js').catch(() => null)
            const board = await store.get(`machines:${buildingId}`, null).catch(() => null)
            const m = board?.board?.floors
              ?.flatMap((f) => f.machines)
              ?.find((x) => x.id === machineId)
            const notice =
              noticeMod && typeof noticeMod.buildStuckNotice === 'function'
                ? noticeMod.buildStuckNotice({
                    machineName: m?.name || machineId,
                    floorCode: m?.floorCode,
                    leftMin: m?.leftMin == null ? null : m.leftMin,
                    stuckMin: 8,
                  })
                : { text: `【等衣】${m?.name || machineId} 可能跳闸/断电，麻烦去现场确认一下` }
            const r = await dt.sendSingle(target.dingUserId, notice)
            dmSent = Boolean(r && r.ok)
          }
        } catch (e) {
          warn('dryer stuck 通知失败:', safeErrorCategory(e))
        }
      }
      await store.put(key, Date.now())
      return json({ ok: true, dmSent })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 查看占用者手机号：必须「确认周围无空桶 + 拍摄衣物占用 + 拍摄机器周围」，并留档
  app.post('/api/urge/reveal', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const machineId = String((body && body.machineId) || '')
      if (!machineId) return apiErr('bad_param', '缺少 machineId')
      if (body.confirmEmpty !== true)
        return apiErr('bad_param', '请先确认洗衣机周围没有空桶可放衣物')

      // 照片：允许 data URL 或 https 外链；data URL 放宽到 220KB（前端已压到 ~100KB）
      const isImg = (v) =>
        typeof v === 'string' &&
        ((/^data:image\/(png|jpe?g|webp);base64,/i.test(v) && v.length <= 220000) ||
          (/^https:\/\//i.test(v) && v.length <= 500))
      if (!isImg(body.photoOccupied))
        return apiErr('bad_param', '请上传「衣物占用」照片（拍到机器里的衣物）')
      if (!isImg(body.photoAround))
        return apiErr('bad_param', '请上传「机器周围」照片（拍清周围没有空桶）')

      const buildingId = env.BUILDING_ID || 'b1'
      const count = Number((await store.get(`urgecount:${buildingId}:${machineId}`, 0)) || 0)
      if (count < 3) return apiErr('bad_param', `需先累计提醒 3 次（当前 ${count} 次）`)

      const occ = await store.get(`occupancy:${buildingId}`, {})
      const entry = occ && typeof occ === 'object' ? occ[machineId] : null
      if (!entry || !entry.userId) return apiErr('not_found', '这台机器没有登记中的占用记录', 404)
      if (entry.userId === userId) return apiErr('bad_param', '不能查看自己的信息')

      const target = await store.get(`user:${entry.userId}`, null)
      const requester = await store.get(`user:${userId}`, null)
      const auditId = 'a' + randomCode(10)
      const at = nowISO()

      const audit = {
        auditId,
        at,
        buildingId,
        machineId,
        requesterId: userId,
        requesterNick: requester?.nick || '',
        occupierId: entry.userId,
        occupierNick: entry.nick || '',
        urgeCount: count,
        confirmEmpty: true,
        photoOccupiedKey: `urgephoto:${auditId}:occ`,
        photoAroundKey: `urgephoto:${auditId}:around`,
      }
      await store.put(`urgeaudit:${buildingId}:${machineId}:${Date.now()}-${auditId}`, audit)
      await store.put(`urgephoto:${auditId}:occ`, body.photoOccupied)
      await store.put(`urgephoto:${auditId}:around`, body.photoAround)

      // 懒清理：KV 没有 TTL，照片是最大的占用来源。
      // 每次新建留档顺手清一小批（默认最多 5 条审计的照片），成本恒定、
      // 不需要 cron 也不会拖慢本次请求。
      try {
        const auditMod = await import('../packages/core/audit.js').catch(() => null)
        if (auditMod && typeof auditMod.pruneAuditPhotos === 'function') {
          await auditMod.pruneAuditPhotos(store, { days: 30, max: 5 })
        }
      } catch (e) {
        warn('凭证照片懒清理失败:', safeErrorCategory(e))
      }

      // 通知：只发当事人和管理员，**不发群**。
      // 查手机号这件事本身敏感，播报出去等于把「谁在被查」公开，不合适。
      let adminNotified = false
      let notifyVia = ''
      try {
        const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
        if (dingMod && typeof dingMod.createDingTalk === 'function') {
          const dt = dingMod.createDingTalk(env)
          const adminText = [
            '【等衣·手机号查看申请】',
            `机器：${machineId}`,
            `申请人：${requester?.nick || userId}（${userId}）`,
            `被查人：${entry.nick || entry.userId}`,
            `已提醒次数：${count}`,
            `凭证编号：${auditId}`,
            `时间：${at}`,
          ].join('\n')
          const adminId = env.ADMIN_DING_USERID || env.DINGTALK_ADMIN_USERID
          if (adminId) {
            const r = await dt.sendSingle(adminId, adminText)
            if (r && r.ok) {
              adminNotified = true
              notifyVia = 'dm-admin'
            }
          }

          // 被查人也收到一条：让他知道有人要联系他，愿意的话自己留个言。
          // 不带申请人的手机号，也不带凭证照片。
          const victimDing = target?.dingUserId || entry?.dingUserId
          if (victimDing && target?.notifyOn !== false) {
            const victimText = [
              '【等衣】有人想联系你',
              `机器：${entry.machineName || machineId}`,
              `原因：你的衣物占用超过 ${count} 次催促`,
              '如果方便，去「等衣」留言板回一句，或尽快取走衣物。',
            ].join('\n')
            const r2 = await dt.sendSingle(victimDing, victimText)
            if (r2 && r2.ok) {
              adminNotified = true
              notifyVia += '+dm-user'
            }
          }
        }
      } catch (e) {
        warn('管理员通知失败:', safeErrorCategory(e))
      }

      return json({
        ok: true,
        phone: target?.mobile || null,
        auditId,
        adminNotified,
        notifyVia,
        hint: target?.mobile ? '已留档，可联系对方' : '对方未留手机号，只能留言',
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 管理端路由（用户/留言/机器/审计）在 server/admin.js，见文件末尾 registerAdminRoutes

  app.use('/api/user/profile',async(c,next)=>{
    const uid=await bearerUser(c,env)
    if(!uid)return next()
    return withOperationLock(store,'profile:'+uid,()=>next())
  })
  app.post('/api/user/profile', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const user = await getUserOrRebuild(store, userId)
      // 读不到真实记录时不要写：写下去就是一份空白账号，把钉钉身份冲掉
      if (user.transient)
        return apiErr('account_out_of_sync', '账号资料暂时读不到，请重新用钉钉登录一次', 409)
      if (body.dormBuilding !== undefined) {
        if (!normalizeDormBuilding(body.dormBuilding,env.SITE_BUILDINGS)) return apiErr('bad_param','请选择有效的住宿楼')
        if(user.dormBuilding&&body.dormBuilding!==user.dormBuilding){
          const count=Number.isInteger(user.dormChangeCount)?user.dormChangeCount:0
          if(count>=1)return apiErr('dorm_change_limit','自行修改住宿楼的次数已用完，请联系管理员修改',409)
          user.dormChangeCount=count+1
        }
        user.dormBuilding=body.dormBuilding
      }
      if (body.nick != null) {
        const nick = normalizeNick(body.nick, '')
        if (!nick) return apiErr('bad_param', '昵称不能为空')
        // 违规词在服务端兜底：昵称会出现在留言板/排队/大屏，属于公开内容
        const chk = checkNick(nick)
        if (!chk.ok) {
          const msg =
            chk.reason === 'too_long'
              ? '昵称最多 16 个字'
              : chk.reason === 'invalid'
                ? '昵称里要有文字或数字'
                : chk.reason === 'banned'
                  ? `昵称里有不允许的词：${chk.word}`
                  : '昵称不合法'
          return apiErr('bad_nick', msg)
        }
        // 重名：群里 @ 人、留言板都靠昵称区分，撞名会认错人
        if (await isNickTaken(store, nick, user.id)) {
          return apiErr('nick_taken', '这个名字有人用了，换一个')
        }
        user.nick = nick
        // 手动改过昵称 = 以他的为准，之后钉钉登录不再覆盖
        user.nickAuto = false
      }
      if (body.avatar != null) {
        const avatar = normalizeAvatar(String(body.avatar))
        if (!AVATAR_KEYS.includes(avatar)) return apiErr('bad_param', '头像不合法')
        user.avatar = avatar
        // 选了预设头像也算手动指定，钉钉头像不再覆盖
        user.avatarAuto = false
        // 注意：这里不清 avatarUrl —— 由前端显式传 avatarUrl:null 来清，
        // 否则「只改昵称也顺手传了 avatar」会把刚上传的照片清掉。
      }
      // 自定义头像：传 avatarUrl（data:image/... 或 https 链接），传 null 清空
      if (body.avatarUrl !== undefined) {
        if (body.avatarUrl === null || body.avatarUrl === '') {
          user.avatarUrl = null
        } else {
          const url = normalizeAvatarUrl(body.avatarUrl)
          if (!url) return apiErr('bad_param', '头像图片不合法或超过大小限制（约 45KB），请重新上传')
          user.avatarUrl = url
        }
      }
      await store.put(`user:${userId}`, user)
      return json({ user: publicUser(user) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })


  // 用户钉钉头像
  app.get('/api/user/dingtalk-avatar', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const user = await getUserOrRebuild(store, userId)
      if (!user.dingUserId) {
        return apiErr('bad_param', '还没绑定钉钉，先在设置页生成绑定码并在钉钉里发送「绑定 <码>」')
      }
      const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
      if (!dingMod || typeof dingMod.createDingTalk !== 'function') {
        return apiErr('internal', '钉钉模块未就绪', 500)
      }
      const dt = dingMod.createDingTalk(env)
      if (typeof dt.getUserProfile !== 'function') {
        return apiErr('internal', '钉钉模块版本过旧', 500)
      }
      const r = await dt.getUserProfile(user.dingUserId)
      // 三种情况要分开报，别混成一句「缺权限」把用户带偏：
      //   1. 调用失败        → 大概率真是权限/凭证问题
      //   2. 成功但没有头像  → 是这个钉钉账号自己没设头像（很常见），不是故障
      //   3. 成功且有头像    → 存下来
      if (!r?.ok) {
        return apiErr(
          'dingtalk',
          r?.err === 'not_configured'
            ? '钉钉凭证未配置'
            : `未能获取钉钉资料（${r?.err || 'unknown'}）。多为应用缺少「通讯录个人信息读权限」，去开发者后台加权限后重新发布。`,
          502
        )
      }
      if (!r.avatar) {
        return apiErr(
          'no_avatar',
          `钉钉账号「${r.nick || '该账号'}」没有设置头像，所以取不到。去钉钉「我的」里换一个头像，再点一次就有了；也可以继续用现在的默认头像。`,
          400
        )
      }
      // 直接把钉钉头像地址存下来（https 外链），下次直接显示
      user.avatarUrl = normalizeAvatarUrl(r.avatar)
      await store.put(`user:${userId}`, user)
      return json({ url: user.avatarUrl, user: publicUser(user) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 随机资料：给「换一个昵称/头像」用，不落库（前端选好了再 POST 保存）
  app.get('/api/user/random', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const cur = await store.get(`user:${userId}`, null)
      const field = c.req.query('field') || 'both'
      return json({
        nick: field === 'avatar' ? (cur && cur.nick) || randomNick() : randomNickExcept(cur && cur.nick),
        avatar: field === 'nick' ? normalizeAvatar(cur && cur.avatar) : randomAvatar(),
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 取衣提醒偏好（鉴权）：开关 + 提前分钟（0/3/5/10）
  app.post('/api/user/notify', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const body = await c.req.json().catch(() => ({}))
      const user = await getUserOrRebuild(store, userId)
      if (user.transient)
        return apiErr('account_out_of_sync', '账号资料暂时读不到，请重新用钉钉登录一次', 409)
      if (body.on != null) user.notifyOn = !!body.on
      if (body.leadMin != null) {
        const lead = Number(body.leadMin)
        if (!NOTIFY_LEADS.includes(lead)) return apiErr('bad_param', '提前分钟只能是 0、3、5、10')
        user.notifyLeadMin = lead
      }
      await store.put(`user:${userId}`, user)
      return json({ user: publicUser(user) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 给自己发一条测试提醒（鉴权）：Web Push + 钉钉私聊各发一次
  //
  // 为什么要这个：用户判断不了「没收到提醒」是没登记、还是通知通道坏了。
  // 点一下就知道，也顺便验证 Web Push 订阅还有没有效。
  app.post('/api/user/test-notify', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const user = await getUserOrRebuild(store, userId)
      const buildingId = env.BUILDING_ID || 'b1'

      // 拿一台真实机器来拼示例文案（没有就编一个），让用户看到的效果和真提醒一致
      const board = await store.get(`machines:${buildingId}`, null).catch(() => null)
      const m = board?.board?.floors?.flatMap((f) => f.machines)?.find((x) => x.state === 'occupied') ||
        board?.board?.floors?.flatMap((f) => f.machines)?.[0]

      const noticeMod = await import('../packages/core/notice.js').catch(() => null)
      const notice =
        noticeMod && typeof noticeMod.buildTakeNotice === 'function'
          ? noticeMod.buildTakeNotice({
              machineName: m?.name || '桂园1楼7号机（示例）',
              floorCode: m?.floorCode,
              leftMin: m?.leftMin != null && m.leftMin > 0 ? m.leftMin : 12,
              endAt: new Date(Date.now() + 12 * 60000).toISOString(),
            })
          : { title: '等衣测试提醒', markdown: '', text: '【等衣】这是一条测试提醒' }

      const out = { push: { ok: false, err: '' }, dm: { ok: false, err: '', skipped: false } }

      // Web Push
      try {
        const subs = (await store.get('subs', [])) || []
        const mine = (Array.isArray(subs) ? subs : []).filter((s) => s.userId === userId)
        if (!mine.length) {
          out.push.err = '没有订阅（先点「开启 Web Push」并允许通知）'
        } else {
          const mod = await import('../packages/core/webpush.js').catch(() => null)
          if (!mod || typeof mod.createWebPush !== 'function') out.push.err = '推送模块未就绪'
          else {
            const wp = mod.createWebPush(env)
            let ok = 0
            let gone = 0
            for (const s of mine) {
              const sub = s.subscription || { endpoint: s.endpoint, keys: s.keys }
              const r = await wp.send(sub, { type: 'done', text: notice.text }).catch(() => null)
              if (r && r.ok) ok++
              if (r && r.gone) {
                gone++
                const idx = subs.indexOf(s)
                if (idx >= 0) subs.splice(idx, 1)
              }
            }
            if (gone) await store.put('subs', subs).catch(() => {})
            out.push.ok = ok > 0
            if (!ok) out.push.err = gone ? '订阅已失效，重新开启推送' : '推送发送失败'
          }
        }
      } catch (e) {
        out.push.err = safeErrorCategory(e)
      }

      // 钉钉私聊
      try {
        if (!user.dingUserId) {
          out.dm.skipped = true
          out.dm.err = '还没绑定钉钉'
        } else {
          const mod = await import('../packages/core/dingtalk.js').catch(() => null)
          if (!mod || typeof mod.createDingTalk !== 'function') out.dm.err = '钉钉模块未就绪'
          else {
            const r = await mod.createDingTalk(env).sendSingle(user.dingUserId, notice)
            out.dm.ok = Boolean(r && r.ok)
            if (!out.dm.ok) out.dm.err = String((r && r.err) || '发送失败').slice(0, 80)
          }
        }
      } catch (e) {
        out.dm.err = safeErrorCategory(e)
      }

      await audit(store, {
        type: 'notify',
        action: '测试提醒',
        actorId: userId,
        actorNick: user.nick,
        level: out.push.ok || out.dm.ok ? 'info' : 'warn',
        detail: { push: out.push.ok, dm: out.dm.ok, pushErr: out.push.err || undefined },
      })

      const anyOk = out.push.ok || out.dm.ok
      return json({
        ok: anyOk,
        ...out,
        hint: anyOk
          ? '已发出：' + [out.dm.ok ? '钉钉私聊' : '', out.push.ok ? '浏览器推送' : ''].filter(Boolean).join(' + ')
          : '两条通道都没发出去，看下面的原因',
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 公告（公开读）
  app.get('/api/notices', async (c) => {
    try {
      const buildingId = c.req.query('building') || env.BUILDING_ID || 'b1'
      const list = await store.get(`notices:${buildingId}`, [])
      return json({ notices: Array.isArray(list) ? list : [] })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 生成绑定码（鉴权，10 分钟过期）
  app.post('/api/bindcode', async (c) => {
    try {
      const userId = await bearerUser(c, env)
      if (!userId) return apiErr('unauthorized', '登录过期了，刷新一下', 401)
      const code = randomKey(BINDCODE_LEN)
      const expAt = new Date(Date.now() + BINDCODE_TTL_MS).toISOString()
      await store.put(`bindcode:${code}`, { userId, expAt })
      return json({ code, expiresAt: expAt })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 钉钉登录：生成授权链接（**公开**——登录前本来就没有 token）
  //
  // 为什么彻底改成钉钉登录：匿名身份只靠 localStorage 的 token 维持，
  // 换设备 / 清缓存 / 换入口就会生成一个新用户，用户看到的是「我资料又变了」。
  // 钉钉身份稳定且有组织背书，用它当唯一身份来源，匿名用户这个概念直接消失。
  //
  // 会话关联靠 device secret（前端本地生成的 32 位随机串）：
  // 授权前把 device 写进 state，回调时再把 device 绑到 userId 上。
  app.get('/api/dingtalk/login-url', async (c) => {
    try {
      const appKey=typeof env.DINGTALK_APP_KEY==='string'?env.DINGTALK_APP_KEY.trim():''
      if (!appKey || !String(env.DINGTALK_APP_SECRET||'').trim()) return apiErr('not_configured', '钉钉应用未配置', 503)
      const raw = c.req.query('device') || ''
      const device = /^[a-f0-9]{32,128}$/i.test(raw) ? raw.toLowerCase() : ''
      if (!device) return apiErr('bad_param', '缺少设备标识，请重新打开页面')

      // state 用**签名票据**，不写 KV：KV 是最终一致的，刚写的 state 回调时可能读不到，
      // 表现出来就是「偶尔登录失败」。签名票据服务端自己就能验，跟存储无关。
      const authMod = await import('../packages/core/auth.js')
      const state = await authMod.issueTicket(
        { role:'login_state', d: device, nonce: randomKey(20), exp: Date.now() + 10 * 60 * 1000 },
        env.AUTH_SECRET
      )
      // 兼容老客户端：仍然留一条 KV 记录（不依赖它）
      await store
        .put(`oauthstate:${state}`, { device, expAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() })
        .catch(() => {})

      const origin = new URL(c.req.url).origin
      const redirect = `${origin}/api/dingtalk/oauth-callback`
      const url =
        'https://login.dingtalk.com/oauth2/auth' +
        `?redirect_uri=${encodeURIComponent(redirect)}` +
        '&response_type=code' +
        `&client_id=${encodeURIComponent(appKey)}` +
        '&scope=openid&prompt=consent' +
        `&state=${encodeURIComponent(state)}`
      return json({ url })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 钉钉登录回调（公开）
  //
  // 这是**唯一**能拿到身份的入口：钉钉身份 = 账号身份。
  // 没有「匿名用户」这条路了，所以不会出现「换个设备就变成另一个人」。
  app.get('/api/dingtalk/oauth-callback', async (c) => {
    const origin = new URL(c.req.url).origin
    // 失败也要留痕：以前只知道「登录失败」，不知道卡在哪一步，
    // 只能靠猜。现在每个分支都带 reason，管理端能直接查。
    const back = async (flag,diagnostic={}) => {
      const eventId=c.get('eventId'),status=Number.isInteger(diagnostic.status)?diagnostic.status:flag==='state_processing'?409:400
      await audit(store, {
        type: 'auth',
        action: '登录失败',
        level: 'warn',
        target: 'dingtalk',
        detail: { reason: flag,eventId,status,...(Number.isInteger(diagnostic.upstreamStatus)?{upstreamStatus:diagnostic.upstreamStatus}:{}),...(diagnostic.category?{category:diagnostic.category}:{}),...(diagnostic.requestId?{requestId:diagnostic.requestId}:{}) },
      })
      c.header('Cache-Control','no-store')
      return c.redirect(`${origin}/#/login?e=${encodeURIComponent(flag)}&eventId=${encodeURIComponent(eventId)}&status=${status}`)
    }
    try {
      const code = c.req.query('authCode') || c.req.query('code') || ''
      const state = c.req.query('state') || ''
      if (!code || !state || code.length>2048 || state.length>2048) return back('missing')
      if(c.get('oauthReplayError'))return back(c.get('oauthReplayError'))

      // state 里带的是 device（不是 userId）——登录前还没有用户
      // 先按签名票据验（不依赖 KV 一致性）；验不过再回退查老格式的 KV 记录。
      const authMod = await import('../packages/core/auth.js')
      let rec = await authMod.verifyTicket(state, env.AUTH_SECRET).catch(() => null)
      rec = rec?.role==='login_state' && /^[a-f0-9]{32,128}$/i.test(rec.d||'') ? {device:rec.d} : null
      if ((!rec || !rec.device) && /^[a-z0-9]{16,80}$/i.test(state)) {
        const kvRec = await store.get(`oauthstate:${state}`, null).catch(() => null)
        if (kvRec && /^[a-f0-9]{32,128}$/i.test(kvRec.device||'') && new Date(kvRec.expAt).getTime() >= Date.now()) rec = kvRec
      }
      if (!rec || !rec.device) return back('state_invalid')
      const deleteState = store.del(`oauthstate:${state}`).catch(() => {})

      const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
      if (!dingMod || typeof dingMod.createDingTalk !== 'function') return back('module')
      const dt = dingMod.createDingTalk(env)

      const t = await dt.exchangeUserCode(code)
      if (!t.ok) {
        warn('钉钉登录换 token 失败:', t.err, 'status='+t.status, 'event='+c.get('eventId'))
        const status=t.err==='invalid_code'?400:t.err==='not_configured'?503:t.status===0?0:t.status===429?503:502
        return back(t.err==='invalid_code'?'code_expired':t.err==='not_configured'?'not_configured':'token',{status,upstreamStatus:t.status,category:t.err,requestId:t.requestId})
      }
      const me = await dt.fetchUserMe(t.accessToken)
      if (!me.ok) {
        warn('钉钉登录取资料失败:', me.err)
        return back('profile',{status:502,category:me.err})
      }

      // unionId → userId，失败退回手机号 → userId
      const knownId = me.unionId ? await store.get(`userByUnionId:${me.unionId}`,null) : null
      const knownUser = knownId ? await store.get(`user:${knownId}`,null) : null
      let dingUserId = knownUser?.dingUnionId === me.unionId ? knownUser.dingUserId || '' : ''
      if (!dingUserId && me.unionId) {
        const r = await dt.getUserIdByUnionId(me.unionId)
        if (r.ok && r.userId) dingUserId = r.userId
        else if (!r.ok) warn('getbyunionid 失败:', r.err)
      }
      if (!dingUserId && me.mobile) {
        const r = await dt.getUserIdByMobile(me.mobile)
        if (r.ok && r.userId) dingUserId = r.userId
        else if (!r.ok) warn('getbymobile 失败:', r.err)
      }
      // 换不到企业内 userId 就没法发私聊，也就没法当身份用 —— 直接拒绝，别放半个账号进来
      if (!dingUserId) return back('no_userid')

      // 手机号兜底：/contact/users/me 不返回 mobile，用通讯录接口再查一次
      let mobile = me.mobile || knownUser?.mobile || ''
      if (!mobile && typeof dt.getUserProfile === 'function') {
        try {
          const prof = await dt.getUserProfile(dingUserId)
          if (prof?.ok && prof.mobile) mobile = prof.mobile
        } catch {
          /* 拿不到就算了 */
        }
      }

      const accountMod = await import('../packages/core/account.js').catch(() => null)
      if (!accountMod || typeof accountMod.findExistingUser !== 'function') return back('module')

      // 找现有账号：钉钉 userId → unionId → 手机号。找到就是「老用户登录」，
      // 这也顺带把之前丢身份的用户找回来（他们的老账号就挂在这个钉钉号上）。
      const found = knownUser && knownUser.dingUserId === dingUserId ? { user: knownUser, via:'unionid_index' } : await accountMod.findExistingUser(store, {
        dingUserId,
        unionId: me.unionId,
        mobile,
      })

      let user = found.user
      let isNew = false
      if (!user) {
        // 全新用户：昵称用钉钉昵称（比随机昵称友好），没有就随机
        const id = newUserId()
        user = buildUser(id, { takeCode: randomCode(6) })
        if (me.nick) user.nick = String(me.nick).slice(0, 16)
        isNew = true
        await store.put(`takeCode:${user.takeCode}`, user.id)
      } else {
        // 老用户：写回前**重新读一次**，尽量拿最新资料。
        // KV 是最终一致的，findExistingUser 拿到的可能是几秒前的副本，
        // 直接整对象写回去会把用户刚改的昵称/头像覆盖成旧值。
        const fresh = await store.get(`user:${user.id}`, null).catch(() => null)
        if (fresh) user = fresh
      }

      // 补齐钉钉侧资料（登录每次都刷新，保证昵称/头像跟钉钉一致）
      user.dingUserId = dingUserId
      if (me.nick) user.dingNick = me.nick
      if (mobile) user.mobile = String(mobile).slice(0, 20)
      if (me.unionId) user.dingUnionId = me.unionId

      // 昵称：**只在新建账号时**用钉钉昵称生成，老账号绝不再改。
      // 之前每次登录都刷一遍，用户自己改的名字会被钉钉名覆盖掉——
      // 「默认值」和「每次覆盖」是两回事，登录不该动用户已经定下的资料。
      if (isNew && me.nick) {
        const auto = nickFromDing(me.nick)
        if (auto) {
          // 同名会让人在群里/留言板分不清，重复就自动加序号
          user.nick = await ensureUniqueNick(store, auto)
          user.nickAuto = true
        }
      }

      // 头像同理：只有账号还没有头像（且没手动选过）时才补钉钉头像。
      if (me.avatarUrl && !isNew && !user.avatarUrl && user.avatarAuto !== false) {
        user.avatarUrl = normalizeAvatarUrl(me.avatarUrl)
        user.avatarAuto = true
      } else if (isNew && me.avatarUrl) {
        user.avatarUrl = normalizeAvatarUrl(me.avatarUrl)
        user.avatarAuto = true
      }

      // 写库可以并发，别一条条串行等（KV 每次写入都是一次往返）
      await Promise.all([
        store.put(`user:${user.id}`, user),
        store.put(`userByDing:${dingUserId}`, user.id),
        me.unionId ? store.put(`userByUnionId:${me.unionId}`, user.id) : Promise.resolve(),
        // 设备密钥绑定：以后同一台设备打开自动登录，不用再点授权
        store.put(`userByDevice:${rec.device}`, user.id),
      ])

      // 一次性取回码：**签名票据**，不落 KV。
      // 落 KV 的话，回调刚写完、浏览器立刻来换，可能因为最终一致读到 null，
      // 用户看到的就是「登录失败」。票据自带签名和过期时间，服务端算一下就行。
      const claim = await authMod.issueTicket(
        { role:'login_claim', u: user.id, d: rec.device, nonce: randomKey(20), exp: Date.now() + 5 * 60 * 1000 },
        env.AUTH_SECRET
      )

      // 登录审计：谁、从哪个钉钉号、新用户还是老用户、用了什么匹配方式
      const auditJob = audit(store, {
        type: 'auth',
        action: isNew ? '钉钉登录（新建账号）' : '钉钉登录',
        actorId: user.id,
        actorNick: user.nick,
        target: user.dingNick || dingUserId,
        detail: {
          via: found.via || 'new',
          dingTail: String(dingUserId).slice(-6),
          mobile: mobile || undefined,
        },
      })

      const auditContext=execCtxOf(c)
      if (auditContext?.waitUntil) auditContext.waitUntil(Promise.allSettled([auditJob,deleteState]))
      else auditJob.catch(()=>{})

      // 首次登录发个私聊回执，用户能确认「登进来的确实是这个钉钉号」。
      // **绝对不能 await**：sendSingle 里要先换一次 token 再发消息，两次串行往返
      // 会让用户盯着登录页卡将近一秒。发不出去也不影响登录，交给后台跑完即可。
      if (isNew) {
        const welcome = await import('../packages/core/notice.js')
        const text = welcome.buildWelcomeText({nick:user.nick})
        const job = Promise.resolve()
          .then(() => dt.sendSingle(dingUserId, text))
          .catch(() => null)
        // 有 waitUntil 就挂到响应之后执行（Edge Functions 支持）
        // 注意：`c.executionCtx` 在部分宿主（没有 ExecutionContext 的运行时）**会抛异常**。
        // 之前这里直接取，导致新建账号时整条回调 500：
        // 账号和审计都写成功了，用户却看到「登录失败」，再登一次（变成老用户，
        // 不走这个分支）就好了 —— 线上「第一次失败第二次成功」就是这个原因。
        let ctx = null
        try {
          ctx = c.executionCtx
        } catch {
          ctx = null
        }
        if (ctx && typeof ctx.waitUntil === 'function') {
          try {
            ctx.waitUntil(job)
          } catch {
            /* 某些运行时不允许，忽略 */
          }
        }
      }

      return c.redirect(`${origin}/#/login?k=${encodeURIComponent(claim)}`)
    } catch (e) {
      warn('钉钉登录回调异常:', safeErrorCategory(e))
      reportError(env, store, 'dingtalk-oauth', safeErrorCategory(e)).catch(() => {})
      return back('error',{status:500,category:safeErrorCategory(e)})
    }
  })

  // 钉钉回调（公开，验签）
  app.post('/api/dingtalk/callback', async (c) => {
    try {
      const aesKey = env.DINGTALK_AES_KEY
      const token = env.DINGTALK_TOKEN
      // 注意：这里不能因为 aes_key 缺失就提前返回 —— 机器人「HTTP 模式」推的是
      // **明文 JSON**，压根不需要 aes_key。缺 key 只影响密文（事件订阅）分支。
      const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
      if (!dingMod || typeof dingMod.verifyAndDecryptCallback !== 'function') {
        warn('dingtalk 模块未就绪，回调放行返回 {errcode:0}')
        return json({ errcode: 0 })
      }
      const body = await c.req.text()
      // 钉钉把 signature/timestamp/nonce 放在回调 URL 的查询参数里，不是请求头。
      // 这里归一成验签函数要的请求头字段名，请求头同名值优先。
      const q = c.req.query()
      const headers = Object.fromEntries(Object.entries(c.req.raw.headers).map(([k, v]) => [k, v]))
      headers.msg_signature = headers.msg_signature || q.msg_signature || q.signature
      headers.timestamp = headers.timestamp || q.timestamp || q.timeStamp
      headers.nonce = headers.nonce || q.nonce
      const dec = await dingMod.verifyAndDecryptCallback({ headers, body, aesKey, token })

      // 两种投递格式都要支持：
      //   a) 事件订阅 HTTP 推送 → {"encrypt": "..."} 密文（要验签解密）
      //   b) 机器人「消息接收模式 = HTTP」→ **明文 JSON** 直接推
      //      （senderPlatform / conversationId / text.content / senderStaffId / sessionWebhook）
      // 之前只处理了 a，导致机器人消息一来就判成 missing_encrypt，永远不回。
      let isPlainMode = false
      let plain = dec.ok ? dec.plain : null
      let failErr = dec.err
      if (!plain) {
        const maybeJson = (() => {
          try {
            return JSON.parse(body)
          } catch {
            return null
          }
        })()
        const looksLikeRobot =
          maybeJson &&
          (maybeJson.senderStaffId != null ||
            maybeJson.text != null ||
            maybeJson.msgtype != null ||
            maybeJson.conversationId != null)
        if (looksLikeRobot) {
          isPlainMode = true
          plain = maybeJson
          failErr = ''
        }
      }

      if (!plain) {
        // 关键：失败也要留痕，否则「钉钉到底发没发」永远查不出来
        await store
          .put('ding:lastCallback', {
            at: nowISO(),
            kind: 'decrypt_failed',
            err: String(failErr || 'unknown'),
            hasBody: Boolean(body && body.length),
            bodyLen: body ? body.length : 0,
            hasSig: Boolean(headers.msg_signature),
            hasTs: Boolean(headers.timestamp),
            hasNonce: Boolean(headers.nonce),
            preview: String(body || '').slice(0, 120),
          })
          .catch(() => {})
        warn('钉钉回调验签失败:', failErr)
        return json({ errcode: 0 }) // 放行，避免钉钉重试
      }

      // 钉钉要求的加密回包：控制台点「保存」时会推一条校验，必须回加密的 "success"，
      // 否则报「HTTP 请求结果校验返回字段值失败」。普通消息也回这个，钉钉才认。
      const tsForSign = headers.timestamp || q.timestamp || q.timeStamp
      const nonceForSign = headers.nonce || q.nonce
      const encryptedSuccess = async () => {
        if (typeof dingMod.buildEncryptedResponse !== 'function') return json({ errcode: 0 })
        try {
          const payload = await dingMod.buildEncryptedResponse({
            plainText: 'success',
            aesKey,
            ownerKey: env.DINGTALK_APP_KEY, // 企业内部应用：owner_key = Client ID
            token,
            timestamp: tsForSign,
            nonce: nonceForSign,
          })
          return json(payload)
        } catch (e) {
          warn('钉钉加密回包失败:', safeErrorCategory(e))
          return json({ errcode: 0 })
        }
      }

      // 明文（机器人 HTTP 回调）只需要 ack；密文（事件订阅）必须回加密 success
      const ack = async () => (isPlainMode ? json({ errcode: 0, errmsg: 'ok' }) : await encryptedSuccess())

      // URL 校验事件：直接回 success，不走指令逻辑
      const eventType = plain.eventType || plain.EventType || plain.type || ''
      if (!isPlainMode && eventType === 'check_url') {
        await store.put('ding:lastCallback', { at: nowISO(), eventType, kind: 'check_url' }).catch(() => {})
        return await encryptedSuccess()
      }

      // 记录最近一次真实回调，方便判断「钉钉到底有没有把消息送到我们这里」
      const trace = {
        at: nowISO(),
        kind: isPlainMode ? 'robot_plain' : 'event_encrypted',
        eventType,
        conversationType: plain.conversationType || '',
        msgtype: plain.msgtype || '',
        hasText: Boolean(plain?.text?.content),
        textPreview: String(plain?.text?.content || '').slice(0, 24),
        hasStaff: Boolean(plain?.senderStaffId),
        hasSenderId: Boolean(plain?.senderId),
        // 只记前 12 位，够判断形态（纯数字 = 可能是真 userId；$:LWCP_ 开头 = 联合 ID，不能发消息）
        senderIdPreview: plain?.senderId ? String(plain.senderId).slice(0, 12) : null,
        staffTail: plain?.senderStaffId ? String(plain.senderStaffId).slice(-4) : null,
        hasWebhook: Boolean(plain?.sessionWebhook),
        hasConversationId: Boolean(plain?.conversationId),
        // 群消息带 conversationId（形如 cidXXXX==），拿到它就能主动往这个群发消息，
        // 不必再让用户去建「自定义机器人 webhook」。
        conversationTitle: plain?.conversationTitle || '',
        cmd: null,
        replied: false,
        webhookErr: null,
        dmErr: null,
        replyErr: null, // 兼容旧字段
        bindRejected: null,
      }

      const content = plain?.text?.content || ''
      // 群里 @ 机器人的消息里**没有** senderStaffId，发信人是 senderId；
      // 只认 senderStaffId 会导致「绑定存了个空身份、回复也没有收件人」。
      const staffId = plain?.senderStaffId || plain?.senderId || ''

      // 统计单聊 / 群聊各收到多少条：用来回答「单聊到底能不能用」。
      // 钉钉到底推不推单聊消息取决于应用配置，我们只能记录事实，不能猜。
      try {
        const convType = String(plain.conversationType || '')
        if (convType === '1' || convType === '2') {
          const s = (await store.get('ding:cbStats', null)) || {}
          const k = convType === '1' ? 'dm' : 'group'
          const prev = s[k] || { count: 0, lastAt: null }
          s[k] = { count: (prev.count || 0) + 1, lastAt: nowISO() }
          await store.put('ding:cbStats', s)
        }
      } catch {
        /* 统计失败不影响主流程 */
      }

      // 记住群会话 id：之后「公共提醒」就靠它主动推送，不需要用户再配自定义机器人 webhook。
      // 只在群聊（conversationType === '2'）时记，单聊的 id 不能当群用。
      const convId = plain?.conversationId
      if (convId && String(plain.conversationType || '') === '2') {
        await store
          .put('ding:groupConv', {
            conversationId: String(convId),
            title: String(plain.conversationTitle || '').slice(0, 40),
            at: nowISO(),
          })
          .catch(() => {})
      }

      const parsed = dingMod.parseCommand ? dingMod.parseCommand(content) : { cmd: null, arg: null }
      const cmd = parsed.cmd
      const arg = parsed.arg
      trace.cmd = cmd

      // 先尝试按 bindcode:{arg} 绑定；非 bind 命令也可定位用户
      let user = null
      if (staffId) {
        const uid = await store.get(`userByDing:${staffId}`, null)
        if (uid) user = await store.get(`user:${uid}`, null)
      }

      // 回复文案：只读指令随时可用；写操作（绑定/提醒开关）在明文回调下一律拒绝，
      // 所以帮助文案按当前模式生成，不写用户点了会失败的命令。
      // 域名不写死：从本次请求的 origin 取，换域名/本地调试都不会给错地址。
      const siteHost = (() => {
        try {
          return new URL(c.req.url).host
        } catch {
          return ''
        }
      })()
      // 文案在 core 里生成，方便单测断言具体字符串（用户明确要求过这两句）
      const helpText =
        typeof dingMod.buildHelpText === 'function'
          ? dingMod.buildHelpText({ plainMode: isPlainMode, host: siteHost })
          : '📖 可用指令：查 / 帮助'
      const unknownReply =
        dingMod.UNKNOWN_COMMAND_REPLY || '指令错误，请回复「帮助」查看帮助'

      let reply = unknownReply
      if (isPlainMode && (cmd === 'claim' || cmd === 'taken')) {
        trace.bindRejected = 'plain_callback_unsigned'
        reply = '此消息未通过身份验签，请打开「等衣」网页登记或确认已取。'
      } else if (cmd === 'bind') {
        // 安全：明文回调（机器人 HTTP 模式）**没有签名**，senderStaffId 可以随便伪造。
        // 如果这里允许写绑定，攻击者只要猜中绑定码就能把别人的账号绑到自己钉钉上。
        // 所以明文回调一律不放行绑定，只走设置页的 OAuth 扫码（那条链路有 authCode 校验）。
        if (isPlainMode) {
          trace.bindRejected = 'plain_callback_unsigned'
          reply =
            '为安全起见，群里不再支持绑定。请打开「等衣」设置页，点「绑定钉钉」直接授权（一步就好）。'
        } else {
          const bc = await store.get(`bindcode:${arg}`, null)
          if (!staffId) {
            // 没拿到发信人身份就不写库，否则会存进一个空身份，看着「绑定成功」其实没绑上
            reply = '没识别出你的钉钉身份（缺少 senderId/senderStaffId），请重发一次或改用扫码'
          } else if (!bc || new Date(bc.expAt).getTime() < Date.now()) {
            reply = '绑定码无效或已过期，请在设置页重新获取'
          } else {
            const target = await store.get(`user:${bc.userId}`, null)
            if (target) {
              target.dingUserId = staffId
              // 存钉钉昵称，设置页用来显示「已绑定：张三」
              target.dingNick = plain?.senderNick || target.dingNick || ''
              await store.put(`user:${bc.userId}`, target)
              await store.put(`userByDing:${staffId}`, bc.userId)
              await store.del(`bindcode:${arg}`)
              user = target
              reply = dingMod.buildBindReply ? dingMod.buildBindReply(staffId, target, true) : '绑定成功'
              trace.bound = true
            }
          }
        }
      } else if (cmd === 'unbind') {
        if (isPlainMode) {
          trace.bindRejected = 'plain_callback_unsigned'
          reply = '为安全起见，群里不能改绑定状态。请到「等衣」设置页操作。'
        } else if (user) {
          user.dingUserId = null
          await store.put(`user:${user.id}`, user)
          await store.del(`userByDing:${staffId}`)
          reply = '已解绑钉钉'
        } else reply = '你尚未绑定'
      } else if (cmd === 'claim') {
        // 群里回复开洗通知 = 认领这台机器（等价于网页点「登记洗衣」）。
        // 仅通过签名校验的回调可写入，明文 senderStaffId 不能作为身份凭据。
        //
        // 编号一律用**机位号**（后台绑定里的 1~7 / D1 / D2），不用机器名里的号：
        // 机器名会随上游变、还会撞号，机位号是现场贴的、稳定的。
        const buildingId = env.BUILDING_ID || 'b1'
        if (!user) {
          reply = '先在「等衣」网页用钉钉登录一次，再来认领。'
        } else {
          const savedMap = await store.get(`mapping:${buildingId}`, null).catch(() => null)
          const map = (savedMap && savedMap.mapping) || {}

          let slot = arg ? String(arg).toUpperCase() : ''
          if (!slot) {
            // 回复消息时正文可能带着被引用的原文，里面是「3 号位」
            const m = String(content || '').match(/([1-9])\s*号位\b|([dD][12])\s*(?:号位|位)/)
            slot = m ? String(m[1] || m[2]).toUpperCase() : ''
          }

          if (!slot) {
            reply = '认领哪个机位？回复「认领 3」，3 是机位号（贴在机器上）。'
          } else {
            const entry = await store.get(`machines:${buildingId}`, null)
            const machines = entry?.board?.floors?.flatMap((f) => f.machines) || []

            let machineId = map[slot] || map[String(slot).toLowerCase()] || ''
            // 只认机位号：机器名里的「N号机」是上游给的，会撞号、会变，
            // 不再拿它做自动识别（用户明确要求去掉按机号自动录）。
            const target = machineId ? machines.find((m) => String(m.id) === String(machineId)) : null

            if (!target) {
              reply = `没找到 ${slot} 号位。先在后台机位里确认这台机器绑到哪个位。`
            } else if (target.state === 'idle') {
              reply = `${slot} 号位现在空着，等它开始转了再认领。`
            } else if (target.state === 'faulty') {
              reply = `${slot} 号位显示故障，先找宿管看看机器。`
            } else {
              // 走和网页完全相同的接口，保证校验/占用/提醒口径一致
              try {
                const token = await issueToken(user.id, authSecret(env))
                const res = await app.request('/api/tasks', {
                  method: 'POST',
                  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
                  body: JSON.stringify({ machineId: target.id, mode: 'machine' }),
                })
                const data = await res.json().catch(() => null)
                if (res.ok && data && data.ok !== false) {
                  const ends = hhmmIn8(target.finishAt)
                  reply = `认领好了，${slot} 号位${ends ? `，${ends} 结束` : ''}，洗完叫你。`
                  trace.claimed = target.id
                } else {
                  reply = (data && data.error && data.error.message) || '认领没成功，去网页试试。'
                }
              } catch (e) {
                reply = '认领失败：' + safeErrorCategory(e)
              }
            }
          }
        }
      } else if (cmd === 'taken') {
        // 回「已取」= 确认取走。私聊、群里都认，认的是**发消息的人**。
        if (!user) {
          reply = '先在「等衣」网页用钉钉登录一次，我才能知道这是你的衣服。'
        } else {
          const list = (await store.get(`tasks:${user.id}`, [])) || []
          const nowMs = Date.now()
          // 挑「已经洗完但还没确认」的任务；有多条就都确认掉
          const pending = list.filter((t) => {
            if (!t || t.done) return false
            const endMs = t.endAt ? new Date(t.endAt).getTime() : NaN
            return Number.isFinite(endMs) && endMs <= nowMs
          })
          if (!pending.length) {
            reply = '你这边没有待取的洗衣机。'
          } else {
            const names = []
            for (const t of pending) {
              t.done = true
              t.takenAt = nowISO()
              names.push(t.machineName || t.machineId)
            }
            await store.put(`tasks:${user.id}`, list)

            // 清占用：只清自己占的那台
            const buildingId = env.BUILDING_ID || 'b1'
            const occ = (await store.get(`occupancy:${buildingId}`, {})) || {}
            let changed = false
            for (const t of pending) {
              if (t.machineId && ownsTaskOccupancy(occ[t.machineId], t, user.id)) {
                delete occ[t.machineId]
                changed = true
              }
            }
            if (changed) await store.put(`occupancy:${buildingId}`, occ)

            await audit(store, {
              type: 'task',
              action: '确认取衣（钉钉）',
              actorId: user.id,
              actorNick: user.nick,
              target: names.join('、'),
              detail: { count: pending.length, via: String(plain?.conversationType || '') === '2' ? 'group' : 'dm' },
            })
            reply = `记上了：${names.join('、')}。`
          }
        }
      } else if (cmd === 'status') {
        const buildingId = env.BUILDING_ID || 'b1'
        const entry = await store.get(`machines:${buildingId}`, null)
        reply = dingMod.buildStatusReply ? dingMod.buildStatusReply(entry?.board) : '暂无看板数据'
      } else if (cmd === 'on') {
        if (isPlainMode) {
          trace.bindRejected = 'plain_callback_unsigned'
          reply = '为安全起见，群里不能改提醒设置。请到「等衣」设置页操作。'
        } else if (user) {
          user.notifyOn = true
          await store.put(`user:${user.id}`, user)
          reply = '已开启取衣提醒'
        } else reply = '你尚未绑定，先到设置页绑定钉钉'
      } else if (cmd === 'off') {
        if (isPlainMode) {
          trace.bindRejected = 'plain_callback_unsigned'
          reply = '为安全起见，群里不能改提醒设置。请到「等衣」设置页操作。'
        } else if (user) {
          user.notifyOn = false
          await store.put(`user:${user.id}`, user)
          reply = '已关闭取衣提醒'
        } else reply = '你尚未绑定'
      } else if (cmd === 'help') {
        reply = helpText
      } else if (!cmd) {
        // 任何没认出来的输入（含空消息、纯表情、图片消息）都给明确指引，
        // 别让用户面对沉默或含糊的「未识别」。
        trace.cmd = 'unknown'
        trace.textPreview = String(content).slice(0, 24)
      }

      // 群里绑定成功时，把「账号ID / staffId」这类信息走私聊，
      // 群里只回一句「已私聊」，避免把个人信息刷在群里。
      const isGroup = String(plain.conversationType || '') === '2'
      if (trace.bound && isGroup && staffId && typeof dingMod.createDingTalk === 'function') {
        try {
          const dm = await dingMod.createDingTalk(env).sendSingle(staffId, reply)
          if (dm && dm.ok) {
            trace.boundDetailDM = true
            reply = '✅ 绑定成功，账号详情已私聊发给你'
          } else {
            trace.boundDetailDM = false
          }
        } catch {
          trace.boundDetailDM = false
        }
      }

      // 回消息：优先 sessionWebhook（免 token、当场回），拿不到就用机器人单聊兜底
      // 注意：replyWebhook / sendSingle 都是 createDingTalk() 返回的**客户端方法**，
      // 不是模块导出。之前写成 dingMod.replyWebhook（undefined），导致群回复从未执行。
      const dtClient =
        typeof dingMod.createDingTalk === 'function' ? dingMod.createDingTalk(env) : null
      const dt = dtClient || {}

      if (plain.sessionWebhook && typeof dt.replyWebhook === 'function') {
        try {
          const rr = await dt.replyWebhook(plain.sessionWebhook, reply)
          if (!rr || rr.ok !== false) {
            trace.replied = true
          } else {
            trace.webhookErr = String((rr && rr.err) || 'failed')
          }
        } catch (e) {
          trace.webhookErr = 'throw:' + safeErrorCategory(e)
          warn('replyWebhook 失败:', safeErrorCategory(e))
        }
      } else {
        trace.webhookErr = plain.sessionWebhook ? 'no_reply_fn' : 'no_webhook'
      }

      if (!trace.replied && staffId && typeof dt.sendSingle === 'function') {
        try {
          const rr = await dt.sendSingle(staffId, reply)
          trace.replied = Boolean(rr && rr.ok)
          if (!trace.replied) {
            trace.dmErr = rr && rr.err ? String(rr.err) : 'send_failed'
            warn('sendSingle 兜底失败:', trace.dmErr)
          }
        } catch (e) {
          trace.dmErr = safeErrorCategory(e)
          warn('sendSingle 兜底异常:', trace.dmErr)
        }
      } else if (!trace.replied) {
        trace.dmErr = staffId ? 'no_client' : 'no_staff_id'
      }

      await store.put('ding:lastCallback', trace).catch(() => {})
      return await ack()
    } catch (e) {
      // 处理过程中抛错也要留痕，否则表现成「消息到了但毫无记录」，无法区分是没送达还是崩了
      try {
        await store.put('ding:lastCallback', {
          at: nowISO(),
          kind: 'handler_error',
          err: safeErrorCategory(e),
          eventId: c.get('eventId'),
          status: 500,
        })
      } catch {
        /* 连 trace 都写不了就只能靠日志了 */
      }
      warn('dingtalk callback error:', safeErrorCategory(e))
      return json({ errcode: 0 }) // 失败也放行
    }
  })

  // 上游配置仅供最高管理员诊断，用户端统一读取聚合快照。
  app.get('/api/upstream-info', async (c) => {
    if (!(await isHighest(c))) return apiErr('forbidden', '需要最高管理员权限', 403)
    const base = String(env.HAIER_URL || '').replace(/\/+$/, '')
    const positionId = env.HAIER_POSITION_ID || ''
    if (!base || !positionId) return apiErr('not_configured', '上游未配置', 503)
    let stateMap = { idle: [1], occupied: [2], faulty: [3] }
    try {
      const parsed = JSON.parse(env.HAIER_STATE_MAP || '')
      if (parsed && typeof parsed === 'object') stateMap = parsed
    } catch {
      /* 用默认 */
    }
    c.header('cache-control', 'no-store')
    return json({ base, positionId, stateMap })
  })

  // 管理：手动跑一次自检（口令）
  app.post('/api/admin/self-check', async (c) => {
    try {
      if (!(await checkAdmin(c, env, store))) return apiErr('forbidden', '口令不对', 403)
      const r = await runSelfCheck(env, store)
      return json({ ok: true, ...r, alertTo: env.ADMIN_DING_USERID ? '已配置' : '未配置 ADMIN_DING_USERID' })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 管理：总览状态（口令）
  app.get('/api/admin/status', async (c) => {
    try {
      // 管理口令优先走请求头，避免出现在 URL（历史记录 / 访问日志会留痕）
      // 也接受 12 小时会话票据
      if (!(await checkAdmin(c, env, store))) {
        return apiErr('forbidden', '口令不对', 403)
      }
      const buildingId = c.req.query('building') || env.BUILDING_ID || 'b1'
      const entry = await store.get(`machines:${buildingId}`, null)
      const board = entry && entry.board ? entry.board : null
      const savedMapping = await store.get(`mapping:${buildingId}`, null)
      const sync = (await store.get('meta:sync', null)) || null
      const notices = await store.get(`notices:${buildingId}`, [])
      const messages = await store.get(`messages:${buildingId}`, [])
      const users = await store.list('user:').catch(() => [])

      const floors = (board?.floors || []).map((f) => {
        const ms = f.machines || []
        const cnt = (s) => ms.filter((m) => m.state === s).length
        return {
          code: f.code,
          total: ms.length,
          idle: cnt('idle'),
          occupied: cnt('occupied'),
          faulty: cnt('faulty'),
        }
      })

      return json({
        ok: true,
        mode: env.HAIER_MODE || 'mock',
        building: {
          id: buildingId,
          name: env.BUILDING_NAME || (board && board.buildingName) || '',
        },
        haier: {
          positionId: env.HAIER_POSITION_ID || null,
          base: env.HAIER_URL || '',
          // 账号池：只回数量和序号，绝不回凭据
          ...(await (async () => {
            const mod = await import('../packages/core/haier.js').catch(() => null)
            const size = mod && typeof mod.parseAccountPool === 'function' ? mod.parseAccountPool(env).length : 1
            const st = (await store.get('meta:haierPool', null)) || null
            const cool = (st && st.cool) || {}
            return {
              poolSize: size,
              poolCurrent: st ? (Number(st.idx) || 0) + 1 : 1,
              poolCooling: Object.entries(cool)
                .filter(([, until]) => Number(until) > Date.now())
                .map(([i, until]) => ({
                  account: Number(i) + 1,
                  secondsLeft: Math.round((Number(until) - Date.now()) / 1000),
                })),
            }
          })()),
        },
        dingtalk: {
          configured: Boolean(env.DINGTALK_APP_KEY && env.DINGTALK_APP_SECRET),
          robot: Boolean(env.DINGTALK_ROBOT_CODE),
          webhook: Boolean(env.DINGTALK_WEBHOOK),
          callback: Boolean(env.DINGTALK_AES_KEY && env.DINGTALK_TOKEN),
        },
        sync,
        dormBuildings: summarizeDormBuildings(board, savedMapping?.mapping || {},env.SITE_BUILDINGS),
        board: board
          ? {
              total: board.total,
              idle: board.idle,
              occupied: board.occupied,
              faulty: board.faulty,
              updatedAt: board.updatedAt,
              floors,
            }
          : null,
        counts: {
          notices: Array.isArray(notices) ? notices.length : 0,
          messages: Array.isArray(messages) ? messages.length : 0,
          users: Array.isArray(users) ? users.length : 0,
        },
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // ── 机位绑定：3D 场景固定机位号 ↔ 真实设备 deviceId ──
  const SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', 'D1', 'D2']

  app.get('/api/mapping', async (c) => {
    try {
      const buildingId = c.req.query('building') || env.BUILDING_ID || 'b1'
      const saved = await store.get(`mapping:${buildingId}`, null)
      const mapping = saved && saved.mapping && typeof saved.mapping === 'object' ? saved.mapping : {}
      return json({ mapping, updatedAt: (saved && saved.updatedAt) || null })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  app.post('/api/mapping', async (c) => {
    try {
      if (!(await checkAdmin(c, env, store))) {
        return apiErr('forbidden', '口令不对', 403)
      }
      const body = await c.req.json().catch(() => ({}))
      const buildingId = (body && body.building) || env.BUILDING_ID || 'b1'
      const input = body && body.mapping
      if (!input || typeof input !== 'object') return apiErr('bad_param', '缺少 mapping')

      // 只认当前看板里存在的设备，避免手输出错绑到不存在的机器
      const entry = await store.get(`machines:${buildingId}`, null)
      const known = new Set(
        ((entry && entry.board && entry.board.floors) || [])
          .flatMap((f) => (f.machines || []).map((m) => String(m.id)))
      )

      const mapping = {}
      const boundIds = new Set()
      for (const key of SLOT_KEYS) {
        const v = input[key]
        if (v === undefined) continue
        if (v === null || v === '') {
          mapping[key] = null
          continue
        }
        const id = String(v)
        if (!SLOT_KEYS.includes(key)) return apiErr('bad_param', `机位 ${key} 不认识`)
        if (!known.has(id)) return apiErr('bad_param', `设备 ${id} 不在当前看板里`)
        if (boundIds.has(id)) return apiErr('bad_param','同一设备不能重复绑定多个机位')
        boundIds.add(id)
        mapping[key] = id
      }

      const updatedAt = nowISO()
      await store.put(`mapping:${buildingId}`, { mapping, updatedAt })
      return json({ ok: true, mapping, updatedAt })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 管理：覆盖配置（口令）
  app.post('/api/admin/config', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      // 这个接口的口令在 body 里（历史原因），所以单独校验，不套 checkAdmin
      const { adminToken, key, value } = body || {}
      if (!adminSecret(env) || adminToken !== adminSecret(env)) {
        return apiErr('forbidden', '口令不对', 403)
      }
      // 仅允许覆盖白名单 key
      const allowed = new Set(['meta:haier', 'meta:dingtalk'])
      if (!allowed.has(key)) return apiErr('bad_param', `不允许覆盖 ${key}`)
      await store.put(key, value)
      return json({ ok: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 手动同步（口令保护）。Edge 定时任务走 functions/api/cron/sync.js 直接调 runSync，
  // 不经由这个 HTTP 端点，所以这里可以强制要求口令，避免被外部刷接口打爆上游。
  //
  // 三种凭据：
  //   1) x-admin-token / ?token=  —— 管理员口令，权限大，别往外贴
  //   2) ?k=<同步密钥>            —— 由 AUTH_SECRET 派生、只能触发同步
  //   3) POST body {k}            —— 给 EdgeOne 的 edgeone.json schedules 用
  //      （定时触发器没法加请求头，只能把参数塞进 payload）
  app.all('/api/cron/sync', async (c) => {
    try {
      let k = c.req.query('k') || ''
      if (!k && (c.req.method === 'POST' || c.req.method === 'PUT')) {
        const body = await c.req.json().catch(() => null)
        if (body && typeof body.k === 'string') k = body.k
      }
      const adminOk = await checkAdmin(c, env, store)
      const keyOk = Boolean(k) && k === (await syncKeyOf(env))
      if (!adminOk && !keyOk) {
        // 记一笔：如果 EdgeOne 的定时触发器把 payload 丢了，我们会在这里看到
        // 「有人打了但没带 key」，据此判断是该改配置还是触发器根本没跑。
        await audit(store, {
          type: 'sync',
          action: '同步触发被拒',
          level: 'warn',
          target: c.req.path,
          detail: {
            method: c.req.method,
            hasQueryK: Boolean(c.req.query('k')),
            hasBodyK: Boolean(k),
            hasToken: Boolean(c.req.header('x-admin-token') || c.req.query('token')),
          },
        }).catch(() => {})
        return apiErr('forbidden', '口令不对', 403)
      }
      const r = await runSync(env, store)
      return json(r)
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 外部抓取回写（CloudBase 换出口后 POST 回来）。
  //
  // 为什么需要：EdgeOne 边缘函数的出口 IP 被上游 WAF 盯上时，换一个运行时
  // 就等于换了一个出口（见 docs/EGRESS.md 方案 3）。
  // 这里只收**原始设备列表**，归一化/看板/diff/提醒全在服务端做，
  // 所以外部节点没法直接伪造看板结构。
  app.post('/api/cron/ingest', async (c) => {
    try {
      let k = c.req.query('k') || ''
      const body = await c.req.json().catch(() => null)
      if (!body || typeof body !== 'object') return apiErr('bad_param', '需要 JSON body')
      if (!k && typeof body.k === 'string') k = body.k

      const adminOk = await checkAdmin(c, env, store)
      const keyOk = Boolean(k) && k === (await syncKeyOf(env))
      if (!adminOk && !keyOk) return apiErr('forbidden', '口令不对', 403)

      const list = Array.isArray(body.raws) ? body.raws : Array.isArray(body.machines) ? body.machines : null
      if (!list) return apiErr('bad_param', '需要 raws: [...]')
      if (!list.length) return apiErr('bad_param', 'raws 不能为空')
      if (list.length > 500) return apiErr('bad_param', 'raws 一次最多 500 条')

      // 每条只认这几个字段，多余的一律丢掉：
      // 外部节点只需要如实转述上游返回，不该能塞进任意结构。
      const raws = []
      for (const it of list) {
        if (!it || typeof it !== 'object') continue
        const id = String(it.id ?? it.deviceId ?? '').trim()
        if (!id) continue
        const state = Number(it.state)
        if (!Number.isFinite(state)) continue
        raws.push({
          id,
          name: typeof it.name === 'string' ? it.name.slice(0, 64) : '',
          floorCode: it.floorCode != null ? String(it.floorCode).slice(0, 8) : '',
          state,
          ...(normalizeMachineCategory(it.categoryCode)?{categoryCode:it.categoryCode}:{}),
          finishTime: it.finishTime ?? null,
        })
      }
      if (!raws.length) return apiErr('bad_param', 'raws 里没有一条合法设备')

      const r = await runSync(env, store, { raws, source: String(body.source || 'external').slice(0, 24) })
      await audit(store, {
        type: 'sync',
        action: '外部抓取回写',
        level: r.error ? 'warn' : 'info',
        target: r.source || 'external',
        detail: { count: raws.length, fetched: r.fetched, events: (r.events || []).length, error: r.error || null },
      }).catch(() => {})

      return json({ ok: !r.error, ...r })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 管理端扩展路由（用户 / 留言 / 机器 / 审计），拆在 admin.js
  registerSiteRoutes(app,{store,env,checkAdmin:c=>checkAdmin(c,env,store),checkSuperAdmin:c=>checkSuperAdmin(c,env)})
  registerAdminRoutes(app, { store, env, authorize:c=>checkAdmin(c,env,store) })
  const authenticate = async(c)=>{const uid=await bearerUser(c,env);return uid ? store.get(`user:${uid}`,null):null}
  const getBoard = async()=>{const bid=env.BUILDING_ID||'b1';const [entry,mapping]=await Promise.all([store.get(`machines:${bid}`,null),store.get(`mapping:${bid}`,null)]);return {board:entry?.board,mapping:mapping?.mapping||{},buildings:env.SITE_BUILDINGS}}
  registerPermissionRoutes(app,{store,authenticate,checkSuperAdmin:c=>checkSuperAdmin(c,env)})
  registerFavoriteRoutes(app,{store,env,authenticate,getBoard})
  registerQueueNoticeRoutes(app,{store,authenticate})
  registerAssistantRoutes(app,{store,env,authenticate,checkAdmin:(c)=>checkAdmin(c,env,store),getBoard:async()=>{const bid=env.BUILDING_ID||'b1';const [entry,mapping]=await Promise.all([store.get(`machines:${bid}`,null),store.get(`mapping:${bid}`,null)]);return {board:entry?.board,mapping:mapping?.mapping||{},buildings:env.SITE_BUILDINGS}}})
  registerOperationsRoutes(app,{store,env,authenticate,checkAdmin:(c)=>checkAdmin(c,env,store),checkSuperAdmin:c=>checkSuperAdmin(c,env),notify:(uid,notice)=>notifyCommunityUser(env,store,uid,notice)})
  registerInspectionRoutes(app,{store,env,authenticate,getBoard,checkSuperAdmin:c=>checkSuperAdmin(c,env),notifyBuilding:async({conversationId,inspection})=>{
    const mod=await import('../packages/core/dingtalk.js')
    const notice=['【等衣 · 楼栋巡检异常】',inspection.machineName,'志愿管理已现场上报异常，请前往洗衣房确认并协助处理。','巡检照片和备注请在管理页面查看。'].join('\n')
    return mod.createDingTalk(env).sendGroup(conversationId,notice)
  }})
  registerAnnouncementRoutes(app,{store,authenticate,checkAdmin:(c)=>checkAdmin(c,env,store)})
  registerSocialRoutes(app,{store,env,authenticate,notify:async(uid,notice)=>{const user=await store.get(`user:${uid}`,null);if(!user?.dingUserId || user.notifyOn===false)return {ok:false,skipped:true};const mod=await import('../packages/core/dingtalk.js');return mod.createDingTalk(env).sendSingle(user.dingUserId,notice)}})
  registerTelemetryRoutes(app, { store, checkAdmin: (c) => checkAdmin(c, env, store) })

  return app
}
