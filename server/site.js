import { json, apiErr } from '../packages/core/util.js'
import { verifyToken } from '../packages/core/auth.js'
import { DORM_BUILDINGS } from '../packages/core/buildings.js'
import { withOperationLock } from '../packages/core/operations.js'
import { getUserIdentity } from '../packages/core/identity.js'

const SITE_KEY = 'meta:site'
const ADMINS_KEY = 'meta:siteAdmins'
const CREDENTIALS = Object.freeze({ appKey: 'DINGTALK_APP_KEY', appSecret: 'DINGTALK_APP_SECRET', robotCode: 'DINGTALK_ROBOT_CODE', agentId: 'DINGTALK_AGENT_ID', aesKey: 'DINGTALK_AES_KEY', token: 'DINGTALK_TOKEN', webhook: 'DINGTALK_WEBHOOK', webhookSecret: 'DINGTALK_WEBHOOK_SECRET' })
const DEFAULT_SITE = { name: '等衣', iconUrl: '', schoolLabel: '', schoolId: '', buildings: DORM_BUILDINGS }
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

function text(value, name, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name}格式无效，最多 ${max} 字`)
  const result = value.trim()
  if (required && !result) throw new Error(`${name}不能为空`)
  return result
}
export function validateSiteIcon(value) {
  const url = text(value, '图标地址', 500)
  if (!url) return ''
  // 站内路径不得退化为协议相对地址；URL仅允许HTTPS，浏览器不会执行data/javascript。
  if (/^\/(?!\/)/.test(url) && !/[\\\s]/.test(url)) return url
  try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.href } catch { /* 统一报错 */ }
  throw new Error('图标仅支持 HTTPS 地址或以 / 开头的站内路径')
}
function validateBuildings(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error('住宿楼须有 1~30 项')
  const codes = new Set(), names = new Set()
  return value.map((item) => {
    if (!isObject(item) || typeof item.code !== 'string' || item.code === 'public' || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.code)) throw new Error('楼栋代号须为小写字母开头的 1~32 位字母、数字、下划线或横线，且不能使用 public')
    const name = text(item.name, '楼栋名称', 30, true)
    if (codes.has(item.code) || names.has(name)) throw new Error('楼栋代号和名称不能重复')
    codes.add(item.code); names.add(name)
    if (own(item, 'enabled') && typeof item.enabled !== 'boolean') throw new Error('楼栋启用状态须为布尔值')
    return { code: item.code, name, ...(item.enabled === false ? { enabled: false } : {}) }
  })
}
function normalizeSite(input = {}) {
  const site = { ...DEFAULT_SITE }
  if (own(input, 'name')) site.name = text(input.name, '站点名称', 40, true)
  if (own(input, 'iconUrl')) site.iconUrl = validateSiteIcon(input.iconUrl)
  if (own(input, 'schoolLabel')) site.schoolLabel = text(input.schoolLabel, '学校显示名', 60)
  if (own(input, 'schoolId')) {
    site.schoolId = text(input.schoolId, '学校 ID', 100)
    if (site.schoolId && !/^[A-Za-z0-9_-]+$/.test(site.schoolId)) throw new Error('学校 ID 只支持字母、数字、下划线或横线')
  }
  site.buildings = validateBuildings(input.buildings || DEFAULT_SITE.buildings)
  return site
}
export async function getSiteConfig(store) {
  const saved = await store.get(SITE_KEY, {})
  try { return normalizeSite(isObject(saved) ? saved : {}) } catch { return normalizeSite() }
}
function publicSite(site) { return { name: site.name, iconUrl: site.iconUrl, schoolLabel: site.schoolLabel, buildings: site.buildings.filter(building=>building.enabled!==false) } }

export async function checkSiteAdmin(c, store, secret) {
  const key = String(secret || '').trim()
  if (key.length < 16) return false
  const bearer = (c.req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!bearer) return false
  const userId = await verifyToken(bearer[1], key).catch(() => null)
  if (!userId) return false
  const identity = await getUserIdentity(store, userId)
  return ['super', 'admin'].includes(identity.role) || identity.role === 'operator' && ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
}
async function superAllowed(c, check) { return typeof check === 'function' ? Boolean(await check(c)) : check === true }
export async function isSiteAdmin(c, { store, env = {}, superAdminCheck }) {
  return await superAllowed(c, superAdminCheck) || checkSiteAdmin(c, store, env.AUTH_SECRET)
}
async function siteAccess(c, { store, env, checkSuperAdmin, checkAdmin }) {
  const bearer = (c.req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)
  const userId = bearer && String(env.AUTH_SECRET || '').length >= 16 ? await verifyToken(bearer[1], env.AUTH_SECRET).catch(() => null) : null
  const identity = userId ? await getUserIdentity(store, userId) : { role: 'user' }
  if (await superAllowed(c, checkSuperAdmin)) return { allowed: true, superAdmin: true, bootstrap: identity.role !== 'super', role: 'super', userId }
  if (userId && await store.get('user:' + userId, null)) {
    const { role } = identity
    if (['super', 'admin', 'operator'].includes(role)) return { allowed: true, superAdmin: role === 'super', bootstrap: false, role, userId }
  }
  // 兼容现有后台会话（x-admin-token / 管理会话票据）：它可以改品牌和楼栋，
  // 但不自动获得成员与密钥管理能力；这两项仍须 bootstrap 最高入口。
  return { allowed: Boolean(await checkAdmin?.(c)), superAdmin: false, role: 'admin', userId: null }
}

export async function loadSiteRuntime(store, env = {}) {
  const [site, saved] = await Promise.all([getSiteConfig(store), store.get('meta:dingtalk', {})])
  const runtime = { ...env }
  for (const [field, key] of Object.entries(CREDENTIALS)) {
    // 同时读取早期管理配置保存的环境变量名，兼容已有部署。
    const value = isObject(saved) && own(saved, field) ? saved[field] : isObject(saved) && own(saved, key) ? saved[key] : undefined
    if (typeof value === 'string') runtime[key] = value
  }
  if (site.schoolId) {
    let payload = {}
    try { payload = typeof env.HAIER_PAYLOAD === 'string' ? JSON.parse(env.HAIER_PAYLOAD || '{}') : env.HAIER_PAYLOAD || {} } catch { /* 管理设置替换非法旧JSON */ }
    runtime.HAIER_PAYLOAD = JSON.stringify({ ...(isObject(payload) ? payload : {}), schoolId: site.schoolId })
    runtime.HAIER_SCHOOL_ID = site.schoolId
  }
  return runtime
}
function credentialFlags(runtime) { return Object.fromEntries(Object.entries(CREDENTIALS).map(([field, key]) => [field, Boolean(runtime[key])])) }
function validateCredentials(input) {
  if (!isObject(input) || Object.keys(input).some((key) => !own(CREDENTIALS, key))) throw new Error('钉钉配置字段无效')
  const result = {}
  for (const [field, value] of Object.entries(input)) {
    const cleaned = text(value, '钉钉配置', field === 'webhook' ? 2000 : 500)
    if (field === 'webhook' && cleaned) {
      let url
      try { url = new URL(cleaned) } catch { throw new Error('Webhook 地址无效') }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Webhook 必须是 HTTPS 地址')
    }
    result[field] = cleaned
  }
  return result
}

export function registerSiteRoutes(app, { store, env = {}, checkAdmin, checkSuperAdmin }) {
  const access = (c) => siteAccess(c, { store, env, checkAdmin, checkSuperAdmin })
  const adminResult = async (permission) => {
    const [site, list, runtime] = await Promise.all([getSiteConfig(store), store.get(ADMINS_KEY, []), loadSiteRuntime(store, env)])
    const admins = await Promise.all(list.map(async (entry) => {
      const user = await store.get('user:' + entry.userId, null)
      return { userId: entry.userId, nick: String(user?.nick || '已失效用户').slice(0, 1) + '**', role: entry.role, buildings: entry.role === 'volunteer' && Array.isArray(entry.buildings) ? entry.buildings.filter((code) => site.buildings.some((b) => b.code === code)) : [], at: entry.at || null, active: Boolean(user && !user.disabled && !user.blocked) }
    }))
    return { site, admins, credentials: credentialFlags(runtime), permissions: { superAdmin: permission.superAdmin, manageSite: permission.superAdmin || permission.role === 'admin', manageAdmins: permission.superAdmin, manageVolunteers: permission.superAdmin || permission.role === 'admin', manageCredentials: permission.superAdmin }, role: permission.role }
  }
  app.get('/api/site', async () => json(publicSite(await getSiteConfig(store))))
  app.get('/api/admin/site', async (c) => {
    const permission = await access(c)
    if (!permission.allowed) return apiErr('unauthorized', '需要管理员登录', 401)
    return json(await adminResult(permission))
  })
  app.patch('/api/admin/site', async (c) => {
    const permission = await access(c)
    if (!permission.allowed) return apiErr('unauthorized', '需要管理员登录', 401)
    const raw = await c.req.text()
    if (raw.length > 16000) return apiErr('bad_param', '配置内容过长')
    let body
    try { body = JSON.parse(raw) } catch { return apiErr('bad_param', '配置 JSON 无效') }
    if (!isObject(body)) return apiErr('bad_param', '配置格式无效')
    const allowed = new Set(['name', 'iconUrl', 'schoolLabel', 'schoolId', 'buildings', 'credentials', 'admin', 'removeAdmin'])
    if (Object.keys(body).some((key) => !allowed.has(key))) return apiErr('bad_param', '包含不支持的配置字段')
    const siteFields = ['name', 'iconUrl', 'schoolLabel', 'schoolId', 'buildings']
    if (siteFields.some((key) => own(body, key)) && !(permission.superAdmin || permission.role === 'admin')) return apiErr('forbidden', '运维员不能修改网站设置', 403)
    if (own(body, 'credentials') && !permission.superAdmin) return apiErr('forbidden', '修改密钥需要总管权限', 403)
    if (['admin', 'removeAdmin'].some((key) => own(body, key)) && !(permission.superAdmin || permission.role === 'admin')) return apiErr('forbidden', '需要总管或管理员权限', 403)
    return withOperationLock(store, 'site-config', async () => {
      let nextSite, nextCredentials, nextAdmins
      try {
        const current = await getSiteConfig(store)
        nextSite = normalizeSite({ ...current, ...Object.fromEntries(siteFields.filter((key) => own(body, key)).map((key) => [key, body[key]])) })
        if (own(body, 'credentials')) nextCredentials = validateCredentials(body.credentials)
        const admins = (await store.get(ADMINS_KEY, [])) || []
        nextAdmins = admins.slice()
        if (own(body, 'admin')) {
          const entry = body.admin
          if (!isObject(entry) || Object.keys(entry).some((key) => !['userId', 'role', 'buildings'].includes(key)) || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.userId || '') || !['super', 'admin', 'operator', 'volunteer'].includes(entry.role)) throw new Error('须指定有效用户 ID 和 super/admin/operator/volunteer 角色')
          const existing = nextAdmins.find((row) => row.userId === entry.userId)
          if (!permission.superAdmin && (entry.role !== 'volunteer' || existing && existing.role !== 'volunteer')) return apiErr('forbidden', '管理员只能添加或修改志愿管理，不能更改高权限成员', 403)
          if (!permission.bootstrap && existing?.role === 'super' && entry.role !== 'super' && entry.userId === permission.userId && nextAdmins.filter((row) => row.role === 'super').length <= 1) throw new Error('不能自行降级最后一位账号总管，请使用最高管理员入口操作')
          let buildings = []
          if (entry.role === 'volunteer') {
            if (!Array.isArray(entry.buildings) || !entry.buildings.length || entry.buildings.length > 30 || entry.buildings.some((code) => typeof code !== 'string' || !nextSite.buildings.some((b) => b.code === code)) || new Set(entry.buildings).size !== entry.buildings.length) throw new Error('志愿管理须指定至少一个有效且不重复的住宿楼')
            buildings = entry.buildings.slice()
          } else if (own(entry, 'buildings') && (!Array.isArray(entry.buildings) || entry.buildings.length)) throw new Error('仅志愿管理可指定楼栋范围')
          const user = await store.get('user:' + entry.userId, null)
          if (!user || !(user.dingUserId || user.dingUnionId || user.provider === 'dingtalk')) throw new Error('只能添加已通过钉钉登录的真实用户')
          const index = nextAdmins.findIndex((row) => row.userId === entry.userId)
          const saved = { userId: entry.userId, role: entry.role, buildings, at: new Date().toISOString() }
          if (index < 0) { if (nextAdmins.length >= 100) throw new Error('管理员数量已达上限'); nextAdmins.push(saved) } else nextAdmins[index] = saved
        }
        if (own(body, 'removeAdmin')) {
          if (typeof body.removeAdmin !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.removeAdmin) || body.removeAdmin === 'bootstrap') throw new Error('不能删除最高管理员入口')
          const existing = nextAdmins.find((entry) => entry.userId === body.removeAdmin)
          if (!permission.superAdmin && existing?.role !== 'volunteer') return apiErr('forbidden', '管理员只能移除志愿管理', 403)
          if (!permission.bootstrap && existing?.role === 'super' && body.removeAdmin === permission.userId && nextAdmins.filter((row) => row.role === 'super').length <= 1) throw new Error('不能自行删除最后一位账号总管，请使用最高管理员入口操作')
          nextAdmins = nextAdmins.filter((entry) => entry.userId !== body.removeAdmin)
        }
      } catch (e) { return apiErr('bad_param', e.message) }
      // 所有字段和目标用户都先验证，避免一个非法字段留下半份配置。
      await store.put(SITE_KEY, nextSite)
      if (nextCredentials) await store.put('meta:dingtalk', { ...await store.get('meta:dingtalk', {}), ...nextCredentials })
      if (own(body, 'admin') || own(body, 'removeAdmin')) await store.put(ADMINS_KEY, nextAdmins)
      return json({ ok: true, ...await adminResult(permission) })
    })
  })
}
