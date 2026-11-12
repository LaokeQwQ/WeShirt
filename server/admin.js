import { getSiteConfig } from './site.js'
import { deleteAssistantUserData } from './assistant.js'
// WeShirt · 管理后台接口（口令鉴权）
// 从 server/app.js 拆出来：app.js 已近 2000 行，管理端是一组独立职责的路由。
//
// 约定：
// - 所有路由都要过 checkAdmin（x-admin-token 请求头优先，兼容 ?token=）
// - 不回传任何密钥；手机号默认脱敏，只有明确要求才给全号
// - 删除类操作一律「先列清单、再删」，并在响应里回删除数量

import { json, apiErr, nowISO, safeErrorCategory } from '../packages/core/util.js'
import { normalizeAvatar, normalizeAvatarUrl } from '../packages/core/profile.js'
import { verifyAdminSession, issueAdminSession, verifyRequestUser } from '../packages/core/auth.js'
import { getUserIdentity } from '../packages/core/identity.js'
import { withOperationLock } from '../packages/core/operations.js'
import { resolveBroadcastTargets } from '../packages/core/group-broadcast.js'
import { DORM_BUILDINGS, normalizeDormBuilding, normalizeKnownDormBuilding, dormBuildingName, resolveMachineDorm } from '../packages/core/buildings.js'
import { computeLeftMin } from '../packages/core/machines.js'
import { resolveMachineKind } from '../packages/core/machine-kind.js'
import { getUserPermissions } from '../packages/core/permissions.js'
import { adminUsersCsv } from './admin-user-export.js'
import { machineLabels } from '../packages/core/machine-labels.js'
import { readCalibrationSettings, projectCalibratedBoard } from '../packages/core/machine-time-calibration.js'

// 管理鉴权：两种凭据都收
//   1) 原始 ADMIN_TOKEN —— 脚本/自检/同步密钥场景，长期有效，别外传
//   2) 12 小时会话票据 —— 后台页面用，过期自动失效
async function checkAdmin(c, env) {
  // 口令必须由环境变量提供；缺失时一律拒绝，**绝不回退到内置默认口令**
  const expect = String((env && env.ADMIN_TOKEN) || '').trim()
  if (expect.length < 8) return false
  const token = c.req.header('x-admin-token') || c.req.query('token')
  if (!token) return false
  if (token === expect) return true
  // 会话票据：签名对、没过期、role=admin
  const payload = await verifyAdminSession(token, (env && env.AUTH_SECRET) || '')
  return Boolean(payload && !payload.accessCodeId)
}

// 路径参数统一校验：只允许字母数字下划线连字符，避免拼进 KV key 时注入奇怪前缀
function safeId(v, max = 40) {
  const s = String(v || '')
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(s) || s.length > max) return null
  return s
}

// 手机号脱敏：13812345678 -> 138****5678
function maskPhone(v) {
  const s = String(v || '')
  if (s.length < 7) return s ? '***' : ''
  return s.slice(0, 3) + '****' + s.slice(-4)
}

function publicUserForAdmin(u, opts = {}) {
  if (!u) return null
  return {
    id: u.id,
    nick: u.nick,
    avatar: normalizeAvatar(u.avatar),
    avatarUrl: normalizeAvatarUrl(u.avatarUrl),
    createdAt: u.createdAt || null,
    dingBound: Boolean(u.dingUserId),
    dingUserId: u.dingUserId || null,
    dingNick: u.dingNick || null,
    mobile: opts.fullPhone ? u.mobile || null : maskPhone(u.mobile),
    notifyOn: u.notifyOn !== false,
    // 与前台同一套白名单，脏值不要直接透出去
    notifyLeadMin: [0, 3, 5, 10].includes(Number(u.notifyLeadMin)) ? Number(u.notifyLeadMin) : 0,
    karma: u.karma || 0,
    dormBuilding: normalizeKnownDormBuilding(u.dormBuilding, opts.buildings),
    dormBuildingName: dormBuildingName(u.dormBuilding, opts.buildings),
  }
}

export function registerAdminRoutes(app, { store, env, authorize }) {
  const guard = async (c) => ((await (authorize ? authorize(c) : checkAdmin(c,env))) ? null : apiErr('unauthorized', '口令不对', 401))
  // 用户数据操作与成员授权共用锁，避免校验后目标被同时晋升而绕过角色保护。
  const mutateUser = (c, id, action, operation) => withOperationLock(store, 'site-config', async () => {
    if(c.get('temporaryAdminAccess')){
      try{c.set('temporaryAdminAccess',await c.get('adminAccessCodes').verifyRequest(c,(await getSiteConfig(store)).buildings))}
      catch(error){return apiErr(error.code||'unauthorized',error.status?error.message:'临时会话暂不可用',error.status||503)}
    }
    // 最高管理员口令/会话保留恢复能力；用户 Bearer 必须重新检查当前服务端身份。
    const bootstrap = await checkAdmin(c, env)
    const saved = await store.get('meta:siteAdmins', [])
    const members = Array.isArray(saved) ? saved : []
    const target = members.find((row) => row?.userId === id)
    if (!bootstrap) {
      const uid = await verifyRequestUser(c, env.AUTH_SECRET).catch(() => null)
      const identity = c.get('temporaryAdminAccess')?.identity || await getUserIdentity(store, uid)
      if (!['super', 'admin'].includes(identity.role)) return apiErr('forbidden', '需要总管或管理员权限', 403)
      // 失效/停用的高权限成员也须保护，不能利用账号状态绕过授权表。
      if (identity.role === 'admin' && ['super', 'admin', 'operator'].includes(target?.role)) return apiErr('forbidden', '管理员不能修改或删除高权限成员的账号，请使用总管入口', 403)
      if (identity.role === 'super' && uid === id && ['delete', 'unlink'].includes(action)) {
        const others = await Promise.all(members.filter((row) => row?.role === 'super' && row.userId !== uid).map((row) => store.get('user:' + row.userId, null)))
        if (!others.some((user) => user && !user.disabled && !user.blocked)) return apiErr('last_super', '不能删除或解绑最后一位账号总管，请使用最高管理员入口操作', 403)
      }
    }
    const result = await operation()
    if (action === 'delete' && result.status >= 200 && result.status < 300 && target) await store.put('meta:siteAdmins', members.filter((row) => row?.userId !== id))
    return result
  })

  // 删除账号（含匿名/临时身份留下的孤儿账号）
  //
  // 只清「这个人自己的东西」：账号、钉钉索引、设备绑定、任务、占用、排队。
  // 留言不删（那是别人的上下文），但作者会显示成「匿名」。
  // 已绑定钉钉的真实账号默认拒绝，必须显式 force=1 —— 防止手滑删掉真人。
  app.delete('/api/admin/users/:id', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const id = safeId(c.req.param('id'))
      if (!id) return apiErr('bad_param', '用户 ID 不合法')
      return mutateUser(c, id, 'delete', async () => {
      const buildingId = c.req.query('building') || env.BUILDING_ID || 'b1'

      const u = await store.get(`user:${id}`, null)
      if (!u) return apiErr('not_found', '没有这个账号（可能已经删过了）', 404)
      if (u.dingUserId && c.req.query('force') !== '1') {
        return apiErr('need_force', '这是已绑定钉钉的真实账号，确认删除请带 force=1', 409)
      }

      await deleteAssistantUserData(store,id)
      await store.del(`user:${id}`)
      if (u.dingUserId) await store.del(`userByDing:${u.dingUserId}`).catch(() => {})
      if (u.dingUnionId) await store.del(`userByUnionId:${u.dingUnionId}`).catch(() => {})
      if (u.takeCode) await store.del(`takeCode:${u.takeCode}`).catch(() => {})
      await store.del(`tasks:${id}`).catch(() => {})

      // 设备绑定要扫一遍（key 是设备密钥，不在用户记录里）
      const devs = await store.list('userByDevice:').catch(() => [])
      let unbound = 0
      for (const e of Array.isArray(devs) ? devs : []) {
        if (e && e.value === id) {
          await store.del(e.key).catch(() => {})
          unbound++
        }
      }

      // 占用与排队：只删他占的那些
      const occ = (await store.get(`occupancy:${buildingId}`, {})) || {}
      let occChanged = 0
      for (const [mid, v] of Object.entries(occ)) {
        if (v && v.userId === id) {
          delete occ[mid]
          occChanged++
        }
      }
      if (occChanged) await store.put(`occupancy:${buildingId}`, occ).catch(() => {})

      const q = (await store.get(`queue:${buildingId}`, [])) || []
      const q2 = q.filter((x) => x && x.userId !== id)
      if (q2.length !== q.length) await store.put(`queue:${buildingId}`, q2).catch(() => {})

      await auditAdmin(c, {
        type: 'admin',
        action: '删除账号',
        target: id,
        detail: { nick: u.nick || '', dingBound: Boolean(u.dingUserId), unboundDevices: unbound, occupancy: occChanged },
      })
      return json({ ok: true, id, nick: u.nick || '', unboundDevices: unbound, occupancyCleared: occChanged })
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 后台登录：口令换 12 小时会话票据 ──
  //
  // 以前前端把口令原样存 localStorage，输一次就永久有效。现在：
  // 口令只用来换票据，票据有 exp，过期自动失效，也能主动退出。
  // 口令本身仍然可用（脚本/自检），但页面不再保存它。
  const sessionTtlMs = (() => {
    const h = Number(env.ADMIN_SESSION_HOURS)
    return (Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 7) : 12) * 3600 * 1000
  })()

  app.post('/api/admin/login', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const token = String(body.token || '').trim()
      const expect = String(env.ADMIN_TOKEN || '').trim()
      if (token.startsWith('wac1.')) {
        const service = c.get('adminAccessCodes')
        if (!service) return apiErr('not_configured', '临时口令尚未配置', 503)
        try {
          const result = await service.login(token, (await getSiteConfig(store)).buildings, sessionTtlMs)
          if (!result) return apiErr('unauthorized', '口令不对', 401)
          await auditAdmin(c, { type: 'admin', action: '临时口令登录', target: '临时管理员' })
          return json({ ok: true, ...result }, 200, { 'Cache-Control': 'no-store' })
        } catch(error) { return apiErr(error.code || 'unavailable', error.status ? error.message : '登录暂不可用', error.status || 503) }
      }
      if (expect.length < 8) return apiErr('not_configured', '后台口令未配置', 503)
      if (!token || token !== expect) {
        await auditAdmin(c, { type: 'admin', action: '后台登录失败', level: 'warn', target: c.req.header('cf-connecting-ip') || '' })
        return apiErr('unauthorized', '口令不对', 401)
      }
      const session = await issueAdminSession(env.AUTH_SECRET, sessionTtlMs)
      if (!session) return apiErr('not_configured', 'AUTH_SECRET 未配置或太短，无法签发会话', 503)
      await auditAdmin(c, { type: 'admin', action: '后台登录', target: '会话 12 小时' })
      return json({ ok: true, session, expAt: Date.now() + sessionTtlMs, ttlMs: sessionTtlMs })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 当前会话还剩多久（页面刷新后用它决定是否要重新登录）
  app.get('/api/admin/session', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const token = c.req.header('x-admin-token') || c.req.query('token')
      const payload = await verifyAdminSession(token, env.AUTH_SECRET || '')
      const rawOk = token && token === String(env.ADMIN_TOKEN || '').trim()
      const temporary = c.get('temporaryAdminAccess')
      return json({
        ok: true,
        kind: temporary ? 'temporary' : payload ? 'session' : rawOk ? 'token' : 'unknown',
        expAt: temporary ? temporary.expAt : payload ? payload.exp : null,
        ttlMs: temporary ? Math.max(0, temporary.expAt - Date.now()) : payload ? Math.max(0, payload.exp - Date.now()) : null,
        ...(temporary ? { role: 'admin', identity: temporary.identity, permissions: temporary.permissions, adminVisible: temporary.adminVisible } : {}),
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 退出：票据是无状态的，客户端丢弃即可；这里只记一条审计
  app.post('/api/admin/logout', async (c) => {
    await auditAdmin(c, { type: 'admin', action: '退出后台', target: '' })
    return json({ ok: true })
  })

  const buildingIdOf = (c) => c.req.query('building') || env.BUILDING_ID || 'b1'

  // 管理操作也要留痕：谁（哪个口令/来源）在什么时候干了什么
  async function auditAdmin(c, ev) {
    try {
      const mod = await import('../packages/core/auditlog.js').catch(() => null)
      if (!mod || typeof mod.logEvent !== 'function') return
      await mod.logEvent(store, {
        ...ev,
        type: ev.type || 'admin',
        actorNick: ev.actorNick || '管理员',
        detail: {
          ...(ev.detail || {}),
          ip: (c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || '').split(',')[0].trim() || undefined,
        },
      })
    } catch {
      /* 静默 */
    }
  }

  // ---------- 操作日志审计 ----------

  // 列表：?days=7&type=task&level=warn&actor=u_xxx&q=关键字&limit=200
  app.get('/api/admin/audit-logs', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const mod = await import('../packages/core/auditlog.js').catch(() => null)
      if (!mod || typeof mod.listEvents !== 'function')
        return apiErr('internal', '审计模块未就绪', 500)

      const r = await mod.listEvents(store, {
        days: c.req.query('days'),
        type: c.req.query('type') || '',
        level: c.req.query('level') || '',
        actorId: c.req.query('actor') || '',
        keyword: c.req.query('q') || '',
        limit: c.req.query('limit'),
      })
      return json({
        ...r,
        types: mod.AUDIT_TYPES,
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 导出 CSV（运维交付/留档用）：同样受口令保护，默认只给最近 7 天
  app.get('/api/admin/audit-logs.csv', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const mod = await import('../packages/core/auditlog.js').catch(() => null)
      if (!mod || typeof mod.listEvents !== 'function')
        return apiErr('internal', '审计模块未就绪', 500)
      const r = await mod.listEvents(store, {
        days: c.req.query('days') || 7,
        type: c.req.query('type') || '',
        level: c.req.query('level') || '',
        limit: 500,
      })
      const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`
      const rows = [['时间', '类型', '级别', '动作', '账号', '昵称', '对象', '详情'].join(',')]
      for (const e of r.events) {
        rows.push(
          [
            esc(e.at),
            esc(mod.AUDIT_TYPES[e.type] || e.type),
            esc(e.level),
            esc(e.action),
            esc(e.actorId),
            esc(e.actorNick),
            esc(e.target),
            esc(e.detail ? JSON.stringify(e.detail) : ''),
          ].join(',')
        )
      }
      // BOM 让 Excel 正确识别 UTF-8 中文
      return new Response('\ufeff' + rows.join('\r\n'), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="weshirt-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 短信验证码登录（半自动）：人自己收码，账号是本人的
  //
  // 只做「发码 / 校验」两次转发，接口地址来自 HAIER_LOGIN 配置。
  // 不做自动注册、不碰图形验证码、不发虚拟号。
  app.post('/api/admin/accounts/send-code', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const body = await c.req.json().catch(() => ({}))
      const phone = String(body.phone || '').trim()
      if (!/^1\d{10}$/.test(phone)) return apiErr('bad_param', '手机号要 11 位')

      const mod = await import('../packages/core/haier.js').catch(() => null)
      if (!mod || typeof mod.sendLoginCode !== 'function') return apiErr('internal', '海尔模块未就绪', 500)
      if (!mod.parseLoginConfig(env)) {
        return apiErr(
          'not_configured',
          '还没配置登录接口：把抓包得到的两条请求填进 HAIER_LOGIN（见 docs/EGRESS.md）',
          501
        )
      }

      // 同号码 60 秒一次，别把短信通道打爆（也会触发对方风控）
      const limit = (await store.get('meta:smsLimit', null)) || {}
      const last = Number(limit[phone]) || 0
      if (Date.now() - last < 60000) {
        return apiErr('too_many', `刚发过，等 ${Math.ceil((60000 - (Date.now() - last)) / 1000)} 秒`, 429)
      }

      await mod.sendLoginCode(env, phone)
      limit[phone] = Date.now()
      await store.put('meta:smsLimit', limit).catch(() => {})
      await auditAdmin(c, { type: 'sync', action: '发送登录验证码', target: phone.slice(0, 3) + '****' + phone.slice(-4) })
      return json({ ok: true, waitSec: 60 })
    } catch (e) {
      return apiErr('bad_gateway', '服务暂时不可用，请稍后重试', 502)
    }
  })

  app.post('/api/admin/accounts/login', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const body = await c.req.json().catch(() => ({}))
      const phone = String(body.phone || '').trim()
      const code = String(body.code || '').trim()
      const index = Number(body.index) || 1

      const mod = await import('../packages/core/haier.js').catch(() => null)
      if (!mod || typeof mod.verifyLoginCode !== 'function') return apiErr('internal', '海尔模块未就绪', 500)
      if (!mod.parseLoginConfig(env)) return apiErr('not_configured', '还没配置登录接口（HAIER_LOGIN）', 501)

      const size = mod.parseAccountPool(env).length
      if (!Number.isInteger(index) || index < 1 || index > size)
        return apiErr('bad_param', `账号序号要在 1~${size} 之间`)

      const r = await mod.verifyLoginCode(env, phone, code)
      const auth = typeof mod.normalizeAuth === 'function' ? mod.normalizeAuth(r.token) : r.token
      const exp = typeof mod.tokenExpiry === 'function' ? mod.tokenExpiry({ Authorization: auth }) : null

      // 免得上游给个过期 token 还把它写进池子
      if (exp && exp <= Date.now()) return apiErr('bad_gateway', '拿到的 token 已经过期，可能是接口返回了别的字段', 502)

      const overrides = (await store.get('meta:haierTokens', null)) || {}
      overrides[index - 1] = { token: auth, label: phone.slice(-4), at: new Date().toISOString() }
      await store.put('meta:haierTokens', overrides)

      await auditAdmin(c, {
        type: 'sync',
        action: '短信登录获取 token',
        target: `账号 ${index}`,
        detail: { phone: phone.slice(0, 3) + '****' + phone.slice(-4), exp: exp ? new Date(exp).toISOString() : null },
      })

      return json({ ok: true, ...(await accountList(env, store)) })
    } catch (e) {
      return apiErr('bad_gateway', '服务暂时不可用，请稍后重试', 502)
    }
  })

  // 账号存活检测：拿每个号的 token 打一下最轻的端点，看能不能用
  //
  // 「有多少个号」不等于「有多少个号能用」。token 过期、被限流、
  // 账号被停用，外观上都只是「同步失败」。这里逐个探一次，把结论摊开。
  app.post('/api/admin/accounts/probe', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const mod = await import('../packages/core/haier.js').catch(() => null)
      if (!mod) return apiErr('internal', '海尔模块未就绪', 500)

      const kvAccounts = (await store.get('meta:haierAccounts', null)) || null
      const overrides = (await store.get('meta:haierTokens', null)) || null
      const pool = typeof mod.buildPool === 'function' ? mod.buildPool(env, kvAccounts, overrides) : []
      const base = String(env.HAIER_URL || '').replace(/\/+$/, '')
      const pid = env.HAIER_POSITION_ID
      if (!base || !pid) return apiErr('not_configured', '缺 HAIER_URL / HAIER_POSITION_ID', 501)

      const probeOne = async (acc, i) => {
        const t0 = Date.now()
        try {
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
          const timer = controller ? setTimeout(() => controller.abort(), 6000) : null
          const res = await fetch(`${base}/position/floorCodeList?positionId=${encodeURIComponent(pid)}`, {
            headers: acc.headers,
            signal: controller ? controller.signal : undefined,
          })
          if (timer) clearTimeout(timer)
          const ms = Date.now() - t0
          // 401/403 = token 失效；405/429 = 被限流；其它非 2xx = 上游异常
          const alive = res.ok
          return {
            index: i + 1,
            label: acc.label || `账号 ${i + 1}`,
            alive,
            status: res.status,
            ms,
            hint: alive ? '可用' : res.status === 401 || res.status === 403 ? 'token 失效' : res.status === 405 || res.status === 429 ? '被限流' : `HTTP ${res.status}`,
          }
        } catch (e) {
          return {
            index: i + 1,
            label: acc.label || `账号 ${i + 1}`,
            alive: false,
            status: 0,
            ms: Date.now() - t0,
            hint: safeErrorCategory(e),
          }
        }
      }

      const results = await Promise.all(pool.map(probeOne))
      const summary = {
        at: nowISO(),
        total: results.length,
        alive: results.filter((r) => r.alive).length,
        results,
      }
      await store.put('meta:accountProbe', summary).catch(() => {})
      await auditAdmin(c, {
        type: 'sync',
        action: '账号存活检测',
        target: `${summary.alive}/${summary.total} 可用`,
      })
      return json({ ok: true, ...summary })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 账号池 token 管理 ──
  //
  // token 会过期，改环境变量要重新部署；这里把新 token 存进 KV 覆盖层，当场生效。
  // 只返回「还有几天过期」这类信息，**绝不回传 token 本身**。
  async function accountList(env, store) {
    const mod = await import('../packages/core/haier.js').catch(() => null)
    if (!mod || typeof mod.parseAccountPool !== 'function') return { size: 0, accounts: [] }
    const kvAccounts = (await store.get('meta:haierAccounts', null)) || null
    const overrides = (await store.get('meta:haierTokens', null)) || null
    const pool =
      typeof mod.buildPool === 'function' ? mod.buildPool(env, kvAccounts, overrides) : mod.parseAccountPool(env)
    const poolState = (await store.get('meta:haierPool', null)) || {}
    const probe = (await store.get('meta:accountProbe', null)) || null
    const probeByIndex = new Map(((probe && probe.results) || []).map((r) => [r.index, r]))
    const cool = poolState.cool || {}
    const now = Date.now()

    const accounts = pool.map((acc, i) => {
      const exp = typeof mod.tokenExpiry === 'function' ? mod.tokenExpiry(acc.headers) : null
      const p = probeByIndex.get(i + 1)
      return {
        index: i + 1,
        label: acc.label || `账号 ${i + 1}`,
        hasToken: Boolean(acc.headers && acc.headers.Authorization),
        expAt: exp ? new Date(exp).toISOString() : null,
        daysLeft: exp ? Math.floor((exp - now) / 86400000) : null,
        expired: Boolean(exp && exp <= now),
        source: Array.isArray(kvAccounts) && kvAccounts.length ? 'kv' : overrides && (overrides[i] || overrides[String(i)]) ? 'kv' : 'env',
        coolingSec: Number(cool[i]) > now ? Math.round((Number(cool[i]) - now) / 1000) : 0,
        // 最近一次存活检测的结论（没有就 null，表示还没测过）
        alive: p ? p.alive : null,
        probeStatus: p ? p.status : null,
        probeHint: p ? p.hint : null,
        probedAt: probe ? probe.at : null,
      }
    })
    return { size: pool.length, current: (Number(poolState.idx) || 0) + 1, accounts, probedAt: probe ? probe.at : null }
  }

  // 批量导入 token：一行一个，支持 "标签, Bearer xxx" 或纯 token
  app.post('/api/admin/accounts/import', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const body = await c.req.json().catch(() => ({}))
      const text = String(body.text || '')
      if (!text.trim()) return apiErr('bad_param', '需要 text（一行一个 token）')

      const mod = await import('../packages/core/haier.js').catch(() => null)
      if (!mod || typeof mod.parseTokenLines !== 'function') return apiErr('internal', '海尔模块未就绪', 500)

      const parsed = mod.parseTokenLines(text, { limit: 20 })
      if (!parsed.length) return apiErr('bad_param', '没解析出有效 token（每行至少 20 字符）')

      const now = Date.now()
      const valid = []
      const skipped = []
      for (const p of parsed) {
        const exp = typeof mod.tokenExpiry === 'function' ? mod.tokenExpiry({ Authorization: p.token }) : null
        if (exp && exp <= now) skipped.push(p.label || '未命名')
        else valid.push(p)
      }
      if (!valid.length) return apiErr('bad_param', `全是过期 token：${skipped.join('、')}`)

      await store.put('meta:haierAccounts', valid)
      // 旧的按序号覆盖层会让新池子错位，清掉
      await store.put('meta:haierTokens', {})
      await store.put('meta:haierPool', { idx: 0, cool: {} })

      await auditAdmin(c, {
        type: 'sync',
        action: '批量导入账号',
        target: `${valid.length} 个`,
        detail: { imported: valid.length, skipped },
      })
      return json({ ok: true, imported: valid.length, skipped, ...(await accountList(env, store)) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  app.get('/api/admin/accounts', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      return json(await accountList(env, store))
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 更新某个账号的 token（存 KV 覆盖层，立即生效，不需要重新部署）
  app.put('/api/admin/accounts', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const body = await c.req.json().catch(() => null)
      if (!body) return apiErr('bad_param', '需要 JSON body')

      const mod = await import('../packages/core/haier.js').catch(() => null)
      if (!mod || typeof mod.parseAccountPool !== 'function') return apiErr('internal', '海尔模块未就绪', 500)

      const size = mod.parseAccountPool(env).length
      const index = Number(body.index)
      if (!Number.isInteger(index) || index < 1 || index > size)
        return apiErr('bad_param', `账号序号要在 1~${size} 之间`)

      const token = String(body.token || '').trim()
      if (token.length < 20) return apiErr('bad_param', 'token 太短，像是没复制全')
      const auth = typeof mod.normalizeAuth === 'function' ? mod.normalizeAuth(token) : token

      // 能解出 exp 就顺手检查一下，过期的不收（存了也是白搭）
      const exp = typeof mod.tokenExpiry === 'function' ? mod.tokenExpiry({ Authorization: auth }) : null
      if (exp && exp <= Date.now()) return apiErr('bad_param', '这个 token 已经过期了，换一个新的')

      const overrides = (await store.get('meta:haierTokens', null)) || {}
      overrides[index - 1] = {
        token: auth,
        label: typeof body.label === 'string' ? body.label.slice(0, 16) : undefined,
        at: new Date().toISOString(),
      }
      await store.put('meta:haierTokens', overrides)

      await auditAdmin(c, {
        type: 'sync',
        action: '更新账号 token',
        level: 'info',
        target: `账号 ${index}`,
        detail: { exp: exp ? new Date(exp).toISOString() : null, label: body.label || null },
      })

      return json({ ok: true, ...(await accountList(env, store)) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 清掉某个账号：KV 批量池里删掉它，或回退环境变量基线
  app.delete('/api/admin/accounts', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const index = Number(c.req.query('index'))
      if (!Number.isInteger(index) || index < 1) return apiErr('bad_param', '需要 ?index=')

      const kvAccounts = (await store.get('meta:haierAccounts', null)) || null
      if (Array.isArray(kvAccounts) && kvAccounts.length) {
        if (index > kvAccounts.length) return apiErr('bad_param', '序号越界')
        kvAccounts.splice(index - 1, 1)
        await store.put('meta:haierAccounts', kvAccounts)
        await store.put('meta:haierPool', { idx: 0, cool: {} })
      } else {
        const overrides = (await store.get('meta:haierTokens', null)) || {}
        delete overrides[index - 1]
        await store.put('meta:haierTokens', overrides)
      }
      return json({ ok: true, ...(await accountList(env, store)) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 同步心跳 URL：拿去填外部定时器（每 5 分钟一次）
  // 为什么需要：提醒是在同步里发的，没人打开页面就不会同步，
  // 「衣服洗好了」自然也就不会推。这个 URL 只有触发同步的权限。
  app.get('/api/admin/sync-url', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const mod = await import('../packages/core/auth.js').catch(() => null)
      if (!mod || typeof mod.deriveSyncKey !== 'function')
        return apiErr('internal', '同步模块未就绪', 500)
      const key = await mod.deriveSyncKey(env.AUTH_SECRET)
      if (!key) return apiErr('not_configured', '缺少 AUTH_SECRET，无法生成同步密钥', 503)
      const origin = new URL(c.req.url).origin
      return json({
        url: `${origin}/api/cron/sync?k=${key}`,
        every: '5 分钟',
        hint: '把这个地址加到任意定时服务（cron-job.org / UptimeRobot 等），提醒就不再依赖“有人打开页面”。',
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 清理过期日志（默认保留 30 天，dry-run 优先）
  app.post('/api/admin/audit-logs/prune', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const keepDays = Math.max(1, Number(c.req.query('keepDays') || 30))
      const apply = c.req.query('apply') === '1'
      const mod = await import('../packages/core/auditlog.js').catch(() => null)
      if (!mod || typeof mod.pruneEvents !== 'function')
        return apiErr('internal', '审计模块未就绪', 500)

      if (!apply) {
        const entries = await store.list('auditlog:')
        const cutoff = mod.bjDate(Date.now() - keepDays * 86400000)
        const candidates = (Array.isArray(entries) ? entries : []).filter(
          (e) => e && e.key && e.key.slice('auditlog:'.length) < cutoff
        ).length
        return json({ ok: true, keepDays, candidates, removed: 0, applied: false })
      }
      const r = await mod.pruneEvents(store, { keepDays })
      await auditAdmin(c, { action: '清理过期日志', detail: { keepDays, removed: r.removed } })
      return json({ ok: true, keepDays, ...r, applied: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // ---------- 用户管理 ----------

  // CSV cannot rely on the JSON response filter. Batch items also re-read the
  // current permission ceiling under mutateUser's site-config lock.
  async function userResourceAccess(c, mode, buildings) {
    const temporary = c.get('temporaryAdminAccess')
    if (!temporary && await checkAdmin(c, env)) return { allowed: true, scope: null, role: 'super' }
    let access = temporary
    if (!access) {
      const uid = await verifyRequestUser(c, env.AUTH_SECRET).catch(() => null)
      access = await getUserPermissions(store, uid ? await store.get('user:' + uid, null) : null, buildings)
    }
    const row = access?.permissions?.adminUsers
    const scope = row?.[mode + 'Buildings']
    return { allowed: row?.[mode] === true, scope: scope === null ? null : Array.isArray(scope) ? scope : [], role: access?.identity?.role }
  }

  app.get('/api/admin/users.csv', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const buildings = (await getSiteConfig(store)).buildings
      const access = await userResourceAccess(c, 'view', buildings)
      if (!access.allowed) return apiErr('forbidden', '没有用户导出权限', 403)
      const dorm = c.req.query('dorm') || '', q = String(c.req.query('q') || '').trim().toLowerCase()
      if (q.length > 100 || dorm && dorm !== 'unbound' && !normalizeKnownDormBuilding(dorm, buildings)) return apiErr('bad_param', '用户筛选条件无效')
      if (dorm && access.scope !== null && !access.scope.includes(dorm)) return apiErr('forbidden', '该楼栋不在授权查看范围内', 403)
      const entries = await store.list('user:')
      const users = (Array.isArray(entries) ? entries : []).map((entry) => entry?.value).filter((user) => {
        if (!user?.id) return false
        const code = normalizeKnownDormBuilding(user.dormBuilding, buildings)
        return (access.scope === null || access.scope.includes(code)) &&
          (!dorm || (dorm === 'unbound' ? !code : code === dorm)) &&
          (!q || `${user.id} ${user.nick || ''} ${user.dingUserId || ''} ${user.dingNick || ''}`.toLowerCase().includes(q))
      }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      if (users.length > 2000) return apiErr('too_large', '单次最多导出 2000 人，请缩小搜索或楼栋范围', 413)
      await auditAdmin(c, { action: '导出脱敏用户列表', detail: { count: users.length, dorm: dorm || null, filtered: Boolean(q) } })
      return new Response(adminUsersCsv(users.map((user) => publicUserForAdmin(user, { buildings }))), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'private, no-store',
          'content-disposition': `attachment; filename="weshirt-users-${new Date().toISOString().slice(0, 10)}.csv"` },
      })
    } catch { return apiErr('internal', '用户导出失败，请稍后重试', 500) }
  })

  app.post('/api/admin/users/batch', async (c) => {
    const bad = await guard(c)
    if (bad) return bad
    if (Number(c.req.header('content-length')) > 8192) return apiErr('too_large', '批量请求过长', 413)
    let body
    try {
      const raw = await c.req.text()
      if (new TextEncoder().encode(raw).length > 8192) return apiErr('too_large', '批量请求过长', 413)
      body = JSON.parse(raw)
    } catch { return apiErr('bad_param', '需要有效 JSON 对象') }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some((key) => !['ids', 'action', 'dormBuilding', 'notifyOn', 'confirmed'].includes(key)) || body.confirmed !== true ||
      !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 50 || body.ids.some((id) => typeof id !== 'string' || !safeId(id)) || new Set(body.ids).size !== body.ids.length ||
      !['setDorm', 'setNotify', 'delete'].includes(body.action)) return apiErr('bad_param', '请选择 1–50 个不同用户并确认批量操作')
    const buildings = (await getSiteConfig(store)).buildings
    if (body.action === 'setDorm' && body.dormBuilding !== null && !normalizeDormBuilding(body.dormBuilding, buildings) ||
      body.action === 'setNotify' && typeof body.notifyOn !== 'boolean') return apiErr('bad_param', '批量修改内容无效')
    const eventId = c.get('eventId') || 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    const results = []
    for (const id of body.ids) {
      let response
      try {
        response = await mutateUser(c, id, body.action === 'delete' ? 'delete' : 'edit', async () => {
          const user = await store.get('user:' + id, null)
          if (!user) return apiErr('not_found', '用户不存在', 404)
          const catalog = (await getSiteConfig(store)).buildings
          const access = await userResourceAccess(c, 'operate', catalog)
          const code = normalizeKnownDormBuilding(user.dormBuilding, catalog)
          if (!access.allowed || access.scope !== null && (!access.scope.includes(code) || body.action === 'setDorm' && !access.scope.includes(body.dormBuilding)))
            return apiErr('forbidden', '目标或新住宿楼不在授权操作范围内', 403)
          if (body.action === 'delete') {
            const tasks = await store.get('tasks:' + id, [])
            const occupancy = await store.get('occupancy:' + buildingIdOf(c), {})
            if ((Array.isArray(tasks) ? tasks : []).some((task) => !task.done) || Object.values(occupancy || {}).some((entry) => entry?.userId === id))
              return apiErr('active_laundry', '该用户仍有未取衣任务或机器登记，请先处理后再删除', 409)
            return deleteManagedUser(c, id, user)
          }
          const next = { ...user }
          if (body.action === 'setDorm') {
            if (body.dormBuilding !== null && !normalizeDormBuilding(body.dormBuilding, catalog)) return apiErr('bad_param', '目标住宿楼已停用或不存在')
            next.dormBuilding = normalizeDormBuilding(body.dormBuilding, catalog)
          } else next.notifyOn = body.notifyOn
          await store.put('user:' + id, next)
          await auditAdmin(c, { action: '批量修改用户', target: id, detail: { action: body.action, eventId,
            ...(body.action === 'setDorm' ? { dormBuilding: next.dormBuilding } : { notifyOn: next.notifyOn }) } })
          return json({ ok: true })
        })
      } catch { response = apiErr('internal', '此用户操作未完成，请刷新后核对', 500) }
      const data = await response.json().catch(() => ({}))
      const ok = response.status >= 200 && response.status < 300
      results.push({ id, ok, status: response.status, ...(ok ? {} : { error: { ...data.error, eventId } }) })
      if (!ok) await auditAdmin(c, { action: '批量用户操作未完成', target: id, level: 'warn', detail: { action: body.action, status: response.status, code: data.error?.code, eventId } })
    }
    const succeeded = results.filter((item) => item.ok).length
    await auditAdmin(c, { action: '批量用户操作汇总', detail: { action: body.action, count: results.length, succeeded, failed: results.length - succeeded, eventId } })
    return json({ total: results.length, succeeded, failed: results.length - succeeded, results, eventId }, 200, { 'cache-control': 'private, no-store' })
  })

  async function deleteManagedUser(c, id, user) {
    const bid = buildingIdOf(c)
    const list = await store.get('messages:' + bid, [])
    const kept = (Array.isArray(list) ? list : []).filter((message) => message.userId !== id)
    const removedMessages = (Array.isArray(list) ? list.length : 0) - kept.length
    if (user.dingUserId) await store.del('userByDing:' + user.dingUserId)
    if (user.dingUnionId) await store.del('userByUnionId:' + user.dingUnionId)
    if (user.takeCode) await store.del('takeCode:' + user.takeCode)
    await deleteAssistantUserData(store, id)
    for (const entry of await store.list('userByDevice:')) if (entry?.value === id) await store.del(entry.key)
    if (removedMessages) await store.put('messages:' + bid, kept)
    const queue = await store.get('queue:' + bid, [])
    if (Array.isArray(queue)) await store.put('queue:' + bid, queue.filter((item) => item?.userId !== id))
    await store.del('tasks:' + id)
    await store.del('access:user:' + id)
    await store.del('user:' + id)
    await auditAdmin(c, { action: '删除用户', target: id, level: 'warn', detail: { removedMessages, dingBound: Boolean(user.dingUserId) } })
    return json({ ok: true, removedMessages })
  }

  // 列表：支持 q 搜索（昵称 / 账号 ID / 钉钉 ID），limit 默认 200
  app.get('/api/admin/users', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const q = String(c.req.query('q') || '').trim().toLowerCase()
      const dorm = c.req.query('dorm') || ''
      const buildings = (await getSiteConfig(store)).buildings
      if (dorm && dorm !== 'unbound' && !normalizeKnownDormBuilding(dorm,buildings)) return apiErr('bad_param', '住宿楼筛选无效')
      const requestedLimit = Number(c.req.query('limit') || 200)
      const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 200
      const operation = await userResourceAccess(c, 'operate', buildings)
      const viewing = await userResourceAccess(c, 'view', buildings)
      if (!viewing.allowed) return apiErr('forbidden', '没有用户查看权限', 403)
      const members = await store.get('meta:siteAdmins', [])
      // store.list() 返回 [{ key, value }]，不是字符串数组
      const entries = await store.list('user:')
      const items = []
      for (const e of Array.isArray(entries) ? entries : []) {
        const u = e && e.value
        if (!u || typeof u !== 'object') continue
        const userDorm = normalizeKnownDormBuilding(u.dormBuilding,buildings)
        if (viewing.scope !== null && !viewing.scope.includes(userDorm)) continue
        if (dorm && (dorm === 'unbound' ? Boolean(userDorm) : userDorm !== dorm)) continue
        if (q) {
          const hay = `${u.id} ${u.nick} ${u.dingUserId || ''} ${u.dingNick || ''}`.toLowerCase()
          if (!hay.includes(q)) continue
        }
        const role = (Array.isArray(members) ? members : []).find((member) => member?.userId === u.id)?.role
        items.push({ ...publicUserForAdmin(u, { buildings }), canOperate: operation.allowed &&
          (operation.scope === null || operation.scope.includes(userDorm)) &&
          !(operation.role === 'admin' && ['super', 'admin', 'operator'].includes(role)) })
      }
      // 新用户排前面
      items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      return json({ total: items.length, items: items.slice(0, limit), buildings,
        bulk: { max: 50, operate: operation.allowed, operateBuildings: operation.scope } })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 单个用户详情（含全量手机号，管理员明确要看时用）
  app.get('/api/admin/user/:id', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const id = safeId(c.req.param('id'))
      if (!id) return apiErr('bad_param', 'id 不合法')
      const u = await store.get(`user:${id}`, null)
      if (!u) return apiErr('not_found', '用户不存在', 404)
      return json({ user: publicUserForAdmin(u, { fullPhone: c.req.query('phone') === '1', buildings: (await getSiteConfig(store)).buildings }) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 修改用户：昵称重置 / 解除钉钉绑定 / 开关提醒
  app.post('/api/admin/user/:id', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const id = safeId(c.req.param('id'))
      if (!id) return apiErr('bad_param', 'id 不合法')
      if (Number(c.req.header('content-length')) > 4096) return apiErr('too_large', '用户资料内容过长', 413)
      const raw = await c.req.text()
      if (new TextEncoder().encode(raw).length > 4096) return apiErr('too_large', '用户资料内容过长', 413)
      let body
      try { body = JSON.parse(raw) } catch { return apiErr('bad_param', '需要有效 JSON 对象') }
      const fields = ['dormBuilding', 'nick', 'unbindDing', 'notifyOn', 'karma']
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) return apiErr('bad_param', '包含不支持的用户资料字段')
      if (Object.hasOwn(body, 'nick') && typeof body.nick !== 'string' || Object.hasOwn(body, 'unbindDing') && typeof body.unbindDing !== 'boolean' || Object.hasOwn(body, 'notifyOn') && typeof body.notifyOn !== 'boolean' || Object.hasOwn(body, 'karma') && (typeof body.karma !== 'number' || !Number.isFinite(body.karma))) return apiErr('bad_param', '用户资料字段类型无效')
      return mutateUser(c, id, body.unbindDing === true ? 'unlink' : 'edit', async () => {
      const u = await store.get(`user:${id}`, null)
      if (!u) return apiErr('not_found', '用户不存在', 404)

      const buildings = (await getSiteConfig(store)).buildings
      if (Object.prototype.hasOwnProperty.call(body, 'dormBuilding')) {
        if (body.dormBuilding !== null && !normalizeDormBuilding(body.dormBuilding,buildings)) return apiErr('bad_param', '请选择有效的住宿楼，清除请传 null')
        u.dormBuilding = normalizeDormBuilding(body.dormBuilding,buildings)
      }

      if (typeof body.nick === 'string' && body.nick.trim()) {
        u.nick = body.nick.trim().slice(0, 16)
      }
      if (body.unbindDing === true) {
        if (u.dingUserId) await store.del(`userByDing:${u.dingUserId}`)
        u.dingUserId = null
        u.dingNick = null
      }
      if (typeof body.notifyOn === 'boolean') u.notifyOn = body.notifyOn
      if (typeof body.karma === 'number') u.karma = body.karma

      await store.put(`user:${id}`, u)
      await auditAdmin(c, { action: '修改用户资料', target: id, detail: { dormBuilding: u.dormBuilding || null, unbindDing: body.unbindDing === true } })
      return json({ user: publicUserForAdmin(u, { buildings }) })
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 删除用户：连带清掉 userByDing 索引，并把他在留言板里的留言一并移除
  app.delete('/api/admin/user/:id', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const id = safeId(c.req.param('id'))
      if (!id) return apiErr('bad_param', 'id 不合法')
      return mutateUser(c, id, 'delete', async () => {
      const u = await store.get(`user:${id}`, null)
      if (!u) return apiErr('not_found', '用户不存在', 404)
      if (u.dingUserId) await store.del(`userByDing:${u.dingUserId}`)
      await deleteAssistantUserData(store,id)
      await store.del(`user:${id}`)

      // 顺手清留言（否则留言板上会留下无主昵称）
      const bid = buildingIdOf(c)
      const list = await store.get(`messages:${bid}`, [])
      const arr = Array.isArray(list) ? list : []
      const kept = arr.filter((m) => m.userId !== id)
      const removedMessages = arr.length - kept.length
      if (removedMessages) await store.put(`messages:${bid}`, kept)

      // 任务与提醒计数也一并清掉，避免任务里挂着已删用户
      await store.del(`tasks:${id}`)

      await auditAdmin(c, {
        action: '删除用户',
        target: `${u.nick || ''}（${id}）`,
        level: 'warn',
        detail: { removedMessages, dingBound: Boolean(u.dingUserId) },
      })
      return json({ ok: true, removedMessages })
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // ---------- 留言板管理 ----------

  app.get('/api/admin/messages', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const bid = buildingIdOf(c)
      const list = await store.get(`messages:${bid}`, [])
      const arr = Array.isArray(list) ? list : []
      // 管理端看完整昵称（前台是打码的）
      return json({ total: arr.length, items: arr.slice().reverse() })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 删除单条留言
  app.delete('/api/admin/message/:id', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const id = safeId(c.req.param('id'))
      if (!id) return apiErr('bad_param', 'id 不合法')
      const bid = buildingIdOf(c)
      const list = await store.get(`messages:${bid}`, [])
      const arr = Array.isArray(list) ? list : []
      const kept = arr.filter((m) => m.id !== id)
      if (kept.length === arr.length) return apiErr('not_found', '留言不存在', 404)
      await store.put(`messages:${bid}`, kept)
      return json({ ok: true, total: kept.length })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 清空留言板
  app.delete('/api/admin/messages', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const bid = buildingIdOf(c)
      const list = await store.get(`messages:${bid}`, [])
      const n = Array.isArray(list) ? list.length : 0
      await store.put(`messages:${bid}`, [])
      return json({ ok: true, removed: n })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // ---------- 机器 / 机器状态 ----------

  // 机器总览：上游状态 + 本地占用 + 排队人数，合成一张表
  app.get('/api/admin/machines', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const bid = buildingIdOf(c)
      const dorm = c.req.query('dorm') || ''
      const buildings = (await getSiteConfig(store)).buildings
      if (dorm && dorm !== 'unbound' && !normalizeKnownDormBuilding(dorm,buildings)) return apiErr('bad_param', '住宿楼筛选无效')
      const [entry, occ, queue, mapping] = await Promise.all([
        store.get(`machines:${bid}`, null), store.get(`occupancy:${bid}`, {}),
        store.get(`queue:${bid}`, []), store.get(`mapping:${bid}`, null),
      ])
      const board = entry?.board ? projectCalibratedBoard(entry.board, await readCalibrationSettings(store,bid)) : null
      const slotMap = mapping?.mapping || {}
      const slotsById = new Map()
      for (const [slot, id] of Object.entries(slotMap)) {
        if (!id) continue
        const key = String(id)
        if (!slotsById.has(key)) slotsById.set(key, [])
        slotsById.get(key).push(slot)
      }
      const queueCounts = new Map()
      for (const q of Array.isArray(queue) ? queue : []) {
        const key = String(q.machineId)
        queueCounts.set(key, (queueCounts.get(key) || 0) + 1)
      }
      const now = nowISO()

      const rows = []
      const floors = board && Array.isArray(board.floors) ? board.floors : []
      for (const f of floors) {
        for (const m of f.machines || []) {
          const machineDorm = resolveMachineDorm(m, slotMap, buildings)
          if (dorm && (dorm === 'unbound' ? Boolean(machineDorm) : machineDorm !== dorm)) continue
          const o = occ?.[m.id] || null
          const slots = slotsById.get(String(m.id)) || []
          const kind = resolveMachineKind(m,slotMap)
          const currentLeft = m.finishAt ? computeLeftMin(m.finishAt, now) : m.leftMin
          const leftMin = currentLeft == null ? null : Math.max(0, currentLeft)
          rows.push({
            ...machineLabels(m, slotMap),
            id: m.id,
            name: m.name || '',
            floor: m.floorCode || f.code || '',
            kind,
            dormBuilding: machineDorm,
            dormBuildingName: dormBuildingName(machineDorm, buildings),
            slots,
            state: m.state,
            leftMin,
            remainMin: leftMin,
            finishAt: m.finishAt || null,
            platformFinishAt:m.platformFinishAt, timeOffsetMinutes:m.timeOffsetMinutes, calibration:m.calibration,
            timeSource:m.timeSource, timeStale:m.timeStale,
            estimated: Boolean(m.estimated),
            endAt: m.finishAt || null,
            // 本地登记信息
            occupiedBy: o ? { userId: o.userId, nick: o.nick, endAt: o.endAt } : null,
            queueCount: queueCounts.get(String(m.id)) || 0,
          })
        }
      }
      return json({
        updatedAt: entry ? entry.rawUpdatedAt || entry.at || null : null,
        mapping,
        total: rows.length,
        rows,
      })
    } catch (e) {
      if(e?.code==='machine_store_unavailable')return apiErr(e.code,'机器数据暂不可用，请稍后重试',503)
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 强制清掉某台机器的本地占用登记（上游状态不动）
  app.post('/api/admin/machine/:id/clear-occupancy', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const id = safeId(c.req.param('id'))
      if (!id) return apiErr('bad_param', 'id 不合法')
      const bid = buildingIdOf(c)
      const occ = (await store.get(`occupancy:${bid}`, {})) || {}
      if (!occ[id]) return apiErr('not_found', '这台机器没有本地登记', 404)
      delete occ[id]
      await store.put(`occupancy:${bid}`, occ)
      // 顺带清掉提醒计数，避免下次登记时带着旧计数
      await store.del(`urgecount:${bid}:${id}`)
      await store.del(`urge:${bid}:${id}`)
      await auditAdmin(c, {
        action: '清除占用登记',
        target: id,
        level: 'warn',
        detail: { wasUser: occ[id] && occ[id].userId },
      })
      return json({ ok: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 清掉某台机器的排队
  app.post('/api/admin/machine/:id/clear-queue', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const id = safeId(c.req.param('id'))
      if (!id) return apiErr('bad_param', 'id 不合法')
      const bid = buildingIdOf(c)
      const queue = (await store.get(`queue:${bid}`, [])) || []
      const arr = Array.isArray(queue) ? queue : []
      const kept = arr.filter((q) => q.machineId !== id)
      const removed = arr.length - kept.length
      await store.put(`queue:${bid}`, kept)
      return json({ ok: true, removed })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 回填手机号/昵称/头像：给「绑定早于兜底逻辑」的用户补齐资料
  // 只处理已绑钉钉的用户，逐个用 topapi/v2/user/get 拉一次；apply=1 才写库
  app.post('/api/admin/backfill-ding-profile', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const apply = c.req.query('apply') === '1'
      const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
      if (!dingMod || typeof dingMod.createDingTalk !== 'function')
        return apiErr('internal', '钉钉模块未就绪', 500)
      const dt = dingMod.createDingTalk(env)

      const entries = await store.list('user:')
      const report = { scanned: 0, bound: 0, filled: 0, applied: apply, items: [] }
      for (const e of Array.isArray(entries) ? entries : []) {
        const u = e && e.value
        if (!u || !u.id) continue
        report.scanned++
        if (!u.dingUserId) continue
        report.bound++
        const needPhone = !u.mobile
        const needNick = !u.dingNick
        if (!needPhone && !needNick) continue
        const prof = await dt.getUserProfile(u.dingUserId).catch(() => null)
        if (!prof || !prof.ok) {
          report.items.push({ id: u.id, ok: false, err: prof?.err || 'fetch_failed' })
          continue
        }
        const patch = {}
        if (needPhone && prof.mobile) patch.mobile = String(prof.mobile).slice(0, 20)
        if (needNick && prof.nick) patch.dingNick = prof.nick
        if (!Object.keys(patch).length) {
          report.items.push({ id: u.id, ok: false, err: 'no_data' })
          continue
        }
        report.filled++
        report.items.push({ id: u.id, ok: true, patch: Object.keys(patch).join('+') })
        if (apply) {
          Object.assign(u, patch)
          await store.put(`user:${u.id}`, u)
        }
      }
      return json(report)
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 上游出网自检：逐个端点打一遍，看清楚是哪一步、什么状态码
  // 只看聚合的 "HAIER HTTP 405" 无法定位（Edge 出网和本机出网可能不同）
  // ?account=2 —— 用账号池里的第 2 个账号探测，用来判断「是不是某个号被限流」
  app.get('/api/admin/diag-haier', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const mod = await import('../packages/core/haier.js').catch(() => null)
      if (!mod || typeof mod.diagnoseHaier !== 'function')
        return apiErr('internal', '海尔模块未就绪', 500)

      let probeEnv = env
      let account = 0
      const size = typeof mod.parseAccountPool === 'function' ? mod.parseAccountPool(env).length : 1
      if (c.req.query('account')) {
        const want = Number(c.req.query('account'))
        if (!Number.isInteger(want) || want < 1 || want > size)
          return apiErr('bad_param', `账号序号要在 1~${size} 之间`)
        account = want
        const pool = mod.parseAccountPool(env)
        probeEnv = { ...env, HAIER_HEADERS: JSON.stringify(pool[want - 1].headers) }
      }

      const out = await mod.diagnoseHaier(probeEnv)
      const sync = await store.get('meta:sync', null)
      const poolState = (await store.get('meta:haierPool', null)) || null
      // 只回序号和冷却时间，绝不回 token
      const pool = {
        size,
        current: poolState ? (Number(poolState.idx) || 0) + 1 : 1,
        cooling: Object.entries((poolState && poolState.cool) || {})
          .filter(([, until]) => Number(until) > Date.now())
          .map(([i, until]) => ({ account: Number(i) + 1, secondsLeft: Math.round((Number(until) - Date.now()) / 1000) })),
      }
      return json({ ...out, account: account || null, pool, sync })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 重置回调统计（口令）：排查通道时难免手动打几条模拟回调，
  // 留着会把统计污染成假数据，所以给一个显式重置口。
  // ?group=1 连「记下的群会话」一起清（模拟回调会写进假 conversationId，
  // 不清掉会让群通道看起来「已就绪」，实际发不到真群）。
  app.post('/api/admin/reset-callback-stats', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const withGroup = c.req.query('group') === '1'
      await store.del('ding:cbStats')
      await store.del('ding:lastCallback')
      if (withGroup) await store.del('ding:groupConv')
      return json({ ok: true, groupCleared: withGroup })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 提醒通道自检：私聊 / 群消息 / webhook 各自是否可用
  // 只看 admin/status 里的 robot:true 说明不了问题——那只代表凭证齐全，
  // 不代表真能发出去（历史上就栽在"配置齐全但发送失败"上）。
  app.get('/api/admin/notify-check', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
      if (!dingMod || typeof dingMod.createDingTalk !== 'function')
        return apiErr('internal', '钉钉模块未就绪', 500)
      const dt = dingMod.createDingTalk(env)

      const conv = await store.get('ding:groupConv', null).catch(() => null)
      const targets = await resolveBroadcastTargets(store, env)
      const operationsConfig = await store.get('operations:config', null)
      const cbStats = (await store.get('ding:cbStats', null).catch(() => null)) || {}
      const adminId = env.ADMIN_DING_USERID || env.DINGTALK_ADMIN_USERID || ''
      const boundUsers = []
      const entries = await store.list('user:').catch(() => [])
      for (const e of Array.isArray(entries) ? entries : []) {
        const u = e && e.value
        if (u && u.dingUserId) boundUsers.push({ id: u.id, nick: u.nick, dingUserId: u.dingUserId })
      }

      return json({
        // 配置层面（只说明"填了没填"）
        configured: {
          appKey: Boolean(env.DINGTALK_APP_KEY),
          appSecret: Boolean(env.DINGTALK_APP_SECRET),
          robotCode: Boolean(env.DINGTALK_ROBOT_CODE),
          webhook: Boolean(env.DINGTALK_WEBHOOK),
          adminDingUserId: Boolean(adminId),
        },
        // 通道层面（说明"能不能发"）
        channels: {
          // 私聊：需要 robotCode + 有 dingUserId 的收件人
          dm: { ready: Boolean(env.DINGTALK_ROBOT_CODE && boundUsers.length), boundUsers: boundUsers.length },
          // 群消息：webhook 优先，其次是回调里记录的 conversationId
          group: {
            automatic: operationsConfig?.broadcast?.enabled !== false && targets.length > 0,
            buildings: targets.map(t => ({ code: t.dormBuilding, name: t.name })),
            ready: Boolean(env.DINGTALK_WEBHOOK || (conv && conv.conversationId)),
            via: env.DINGTALK_WEBHOOK ? 'webhook' : conv && conv.conversationId ? 'conversation' : '',
            conversationId: conv && conv.conversationId ? String(conv.conversationId).slice(0, 12) + '…' : null,
            conversationTitle: conv && conv.title ? conv.title : null,
            updatedAt: conv && conv.at ? conv.at : null,
          },
        },
        boundUsers,
        // 机器人实际收到过多少条单聊 / 群聊消息：回答「能不能私聊发指令」
        callbacks: {
          dm: cbStats.dm || { count: 0, lastAt: null },
          group: cbStats.group || { count: 0, lastAt: null },
        },
        // 最近一次回调的原始结论：排查「钉钉到底有没有打进来」的唯一依据。
        // 场景群机器人保存配置时会推一条校验请求，保存失败通常卡在这里。
        lastCallback: await store.get('ding:lastCallback', null).catch(() => null),
        // 最近一次群播报的原文：用户质疑「为什么发了这些」时直接对账
        lastDigest: await store.get('ding:lastDigest', null).catch(() => null),
        hint: '整点群播报按楼栋配置，默认每天 8:00–22:00；状态较上次未变不发送。未绑定楼栋的群仅用于手动测试或回复查询。',
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 发一条测试提醒（口令）：验证通道是否真的可用
  // to: 'self' 发给自己钉钉；'group' 发到记录的群
  // sample=take 发一条**真实的取衣通知卡片**（markdown），不是干巴巴的「通道自检」
  app.post('/api/admin/notify-test', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const to = String(c.req.query('to') || 'both')
      const sample = String(c.req.query('sample') || '')

      let text = `[等衣·通道自检] ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 收到即代表通道正常。`
      if (sample === 'take') {
        const noticeMod = await import('../packages/core/notice.js').catch(() => null)
        const bid = buildingIdOf(c)
        const board = await store.get(`machines:${bid}`, null).catch(() => null)
        const m =
          board?.board?.floors?.flatMap((f) => f.machines)?.find((x) => x.state === 'occupied') ||
          board?.board?.floors?.flatMap((f) => f.machines)?.[0]
        text =
          noticeMod && typeof noticeMod.buildTakeNotice === 'function'
            ? noticeMod.buildTakeNotice({
                machineName: (m?.name || '桂园1楼7号机') + '（测试）',
                floorCode: m?.floorCode,
                leftMin: 12,
                endAt: new Date(Date.now() + 12 * 60000).toISOString(),
              })
            : { text: '【等衣】测试取衣提醒' }
      }
      const out = { to, sample: sample || 'plain', dm: null, group: null }

      const dingMod = await import('../packages/core/dingtalk.js').catch(() => null)
      if (!dingMod || typeof dingMod.createDingTalk !== 'function')
        return apiErr('internal', '钉钉模块未就绪', 500)
      const dt = dingMod.createDingTalk(env)

      if (to === 'self' || to === 'both') {
        const adminId = env.ADMIN_DING_USERID || env.DINGTALK_ADMIN_USERID
        if (!adminId) out.dm = { ok: false, err: 'no_admin_ding_userid' }
        else {
          const r = await dt.sendSingle(adminId, text)
          out.dm = { ok: Boolean(r && r.ok), err: r && r.err ? String(r.err).slice(0, 120) : null }
        }
      }

      // 群消息只支持纯文本（webhook / sendGroup 的 msgKey 都是 sampleText），
      // 卡片模式只对私聊生效，这里取纯文本兜底内容。
      const plain = typeof text === 'string' ? text : text.text
      if (to === 'group' || to === 'both') {
        if (env.DINGTALK_WEBHOOK) {
          const r = await dt.broadcast(plain)
          out.group = { ok: Boolean(r && r.ok), via: 'webhook', err: r && r.err ? String(r.err).slice(0, 120) : null }
        } else {
          const conv = await store.get('ding:groupConv', null).catch(() => null)
          if (!conv || !conv.conversationId) {
            out.group = { ok: false, via: '', err: 'no_group_channel' }
          } else if (typeof dt.sendGroup !== 'function') {
            out.group = { ok: false, via: '', err: 'no_sendGroup' }
          } else {
            const r = await dt.sendGroup(conv.conversationId, plain)
            out.group = { ok: Boolean(r && r.ok), via: 'conversation', err: r && r.err ? String(r.err).slice(0, 120) : null }
          }
        }
      }
      return json({ ok: true, ...out })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // ---------- 上报事件审计 ----------

  // 手机号查看申请留档（含照片引用）；默认不带照片本体，避免列表过大
  app.get('/api/admin/urge-audits', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const limit = Math.min(300, Math.max(1, Number(c.req.query('limit') || 100)))
      const entries = await store.list('urgeaudit:')
      const items = []
      for (const e of Array.isArray(entries) ? entries : []) {
        if (e && e.value) items.push(e.value)
      }
      items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
      return json({ total: items.length, items: items.slice(0, limit) })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 单张凭证照片（data URL 原样返回，前端直接塞 img src）
  app.get('/api/admin/urge-audit/:auditId/photo/:kind', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const auditId = c.req.param('auditId')
      const kind = c.req.param('kind')
      if (!/^[a-zA-Z0-9]+$/.test(auditId)) return apiErr('bad_param', 'auditId 不合法')
      if (kind !== 'occ' && kind !== 'around') return apiErr('bad_param', 'kind 只能是 occ/around')
      const data = await store.get(`urgephoto:${auditId}:${kind}`, null)
      if (!data) return apiErr('not_found', '照片不存在或已清理', 404)
      return json({ dataUrl: data })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 审计概览：给后台首页一个总览数字
  app.get('/api/admin/audit-summary', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const bid = buildingIdOf(c)
      const entries = await store.list('urgeaudit:')
      const audits = []
      for (const e of Array.isArray(entries) ? entries : []) {
        if (e && e.value) audits.push(e.value)
      }
      const today = nowISO().slice(0, 10)
      const todayCount = audits.filter((a) => String(a.at).startsWith(today)).length

      // 按机器聚合，找出被申请最多的机器
      const byMachine = {}
      for (const a of audits) byMachine[a.machineId] = (byMachine[a.machineId] || 0) + 1
      const top = Object.entries(byMachine)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([machineId, n]) => ({ machineId, count: n }))

      const msgList = await store.get(`messages:${bid}`, [])
      return json({
        auditsTotal: audits.length,
        auditsToday: todayCount,
        topMachines: top,
        messages: Array.isArray(msgList) ? msgList.length : 0,
      })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  // 清理过期凭证照片（默认 dry-run，apply=1 才真删）
  app.post('/api/admin/purge-audit-photos', async (c) => {
    try {
      const bad = await guard(c)
      if (bad) return bad
      const days = Math.max(1, Number(c.req.query('days') || 30))
      const apply = c.req.query('apply') === '1'
      const auditMod = await import('../packages/core/audit.js').catch(() => null)
      if (!auditMod || typeof auditMod.pruneAuditPhotos !== 'function')
        return apiErr('internal', '审计模块未就绪', 500)

      if (!apply) {
        // dry-run：把 max 设成极大值只统计，不真删
        const entries = await store.list('urgeaudit:')
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
        let candidates = 0
        for (const e of Array.isArray(entries) ? entries : []) {
          const v = e && e.value
          if (!v || !v.auditId) continue
          const at = new Date(v.at).getTime()
          if (!Number.isNaN(at) && at < cutoff) candidates++
        }
        return json({ ok: true, days, candidates, removed: 0, applied: false })
      }

      const r = await auditMod.pruneAuditPhotos(store, { days, max: 0 })
      return json({ ok: true, days, candidates: r.expired, removed: r.removed, applied: true })
    } catch (e) {
      return apiErr('internal', '服务暂时不可用，请稍后重试', 500)
    }
  })

  return app
}
