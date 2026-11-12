import { issueTicket, verifyAdminSession, timingSafeEqual } from './auth.js'
import { basePermissions, normalizePermissionOverrides } from './permissions.js'

const KEY = 'mobile:admin-access-codes:registry'
const HOUR = 3600000
export const ADMIN_ACCESS_DEFAULT_HOURS = 12
export const ADMIN_ACCESS_MAX_HOURS = 720
const idOK = value => typeof value === 'string' && /^ac_[a-f0-9]{32}$/.test(value)
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('')
const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('')
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }) }
const identity = Object.freeze({ role: 'admin', label: '临时管理员', buildings: [] })
const publicRow = row => ({ id: row.id, name: row.name, note: row.note, prefix: row.prefix, suffix: row.suffix, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt || null, role: 'admin', permissions: row.permissions })

/** Every authorization read uses the durable, linearizable store, never Edge KV. */
export function createAdminAccessCodes({ atomicStore, authSecret, now = Date.now } = {}) {
  const enabled = atomicStore?.consistency === 'linearizable' && atomicStore?.durable === true &&
    typeof atomicStore.get === 'function' && typeof atomicStore.compareAndSet === 'function' && String(authSecret || '').trim().length >= 16
  const ready = () => { if (!enabled) fail('access_codes_not_configured', '临时口令需要配置原子会话存储', 503) }
  async function read() {
    ready()
    try {
      const row = await atomicStore.get(KEY)
      if (row && (!Array.isArray(row.value?.codes) || row.value.codes.length > 100)) throw new Error()
      return row
    } catch { fail('access_codes_unavailable', '临时口令存储暂不可用', 503) }
  }
  async function update(edit) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await read(), codes = structuredClone(row?.value.codes || [])
      const result = await edit(codes)
      if (result.unchanged) return result.value
      if (new TextEncoder().encode(JSON.stringify({ codes })).length > 48000) fail('access_code_limit', '临时口令数量或权限内容过多，请先清理过期口令', 429)
      try {
        if (await atomicStore.compareAndSet(KEY, row?.version ?? null, { codes }, { expiresAt: now() + 90 * 24 * HOUR })) return result.value
      } catch { fail('access_codes_unavailable', '临时口令存储暂不可用', 503) }
    }
    fail('access_code_conflict', '口令列表正在更新，请重试', 409)
  }
  function access(row, buildings) {
    const base = basePermissions(identity, true)
    let overrides
    try { overrides = normalizePermissionOverrides(row.permissions || {}, base, buildings) }
    catch { fail('access_code_scope_invalid', '口令授权范围已变化，请联系总管', 403) }
    const permissions = { ...base, ...overrides }
    return { id: row.id, name: row.name, expiresAt: row.expiresAt, identity, permissions, base,
      adminVisible: Object.entries(permissions).some(([key, value]) => key.startsWith('admin') && value.view) }
  }
  async function active(id) {
    const row = (await read())?.value.codes.find(row => row.id === id)
    if (!row || row.revokedAt || row.expiresAt <= now()) fail('admin_access_expired', '临时管理员会话已撤销或过期，请重新登录', 401)
    return row
  }
  return {
    enabled,
    async list() { return ((await read())?.value.codes || []).map(publicRow).sort((a, b) => b.createdAt - a.createdAt) },
    async create(body, { actor, key, buildings }) {
      ready()
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['name', 'note', 'ttlHours', 'permissions'].includes(k))) fail('bad_param', '口令字段无效')
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60 || /[\p{Cc}]/u.test(body.name)) fail('bad_param', '名称须为 1–60 个字符')
      if (body.note != null && (typeof body.note !== 'string' || body.note.length > 240 || /[\p{Cc}]/u.test(body.note))) fail('bad_param', '备注不能超过 240 个字符')
      const ttlHours = body.ttlHours ?? ADMIN_ACCESS_DEFAULT_HOURS
      if (typeof ttlHours !== 'number' || !Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > ADMIN_ACCESS_MAX_HOURS) fail('bad_param', '有效期须大于 0 且最多 720 小时')
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) fail('idempotency_required', '请提供有效的请求标识')
      let permissions
      try { permissions = normalizePermissionOverrides(body.permissions || {}, basePermissions(identity, true), buildings) }
      catch (error) { fail('bad_param', error.message) }
      const requestHash = await hash(actor + '\n' + key), bodyHash = await hash(JSON.stringify({ name: body.name.trim(), note: body.note || '', ttlHours, permissions }))
      const id = 'ac_' + crypto.randomUUID().replace(/-/g, ''), code = 'wac1.' + id + '.' + secret()
      const createdAt = now(), value = { id, name: body.name.trim(), note: body.note || '', createdAt, expiresAt: createdAt + ttlHours * HOUR, revokedAt: null,
        prefix: code.slice(0, 11), suffix: code.slice(-6), digest: await hash(code), permissions, requestHash, bodyHash }
      return update(async codes => {
        const previous = codes.find(row => row.requestHash === requestHash)
        if (previous) fail(previous.bodyHash === bodyHash ? 'access_code_already_created' : 'idempotency_conflict', previous.bodyHash === bodyHash ? '此请求已创建口令，明文不会再次显示；未保存时请销毁后重建' : '请求标识已用于其他内容', 409)
        // Keep recent tombstones for replay detection; expired authorization is never accepted.
        for (let index = codes.length - 1; index >= 0; index--) if (codes[index].expiresAt < now() - 7 * 24 * HOUR) codes.splice(index, 1)
        if (codes.length >= 100) fail('access_code_limit', '临时口令过多，请等待过期记录清理', 429)
        codes.push(value)
        return { value: { code, accessCode: publicRow(value) } }
      })
    },
    async revoke(id) {
      if (!idOK(id)) fail('bad_param', '口令 ID 无效')
      return update(async codes => {
        const row = codes.find(row => row.id === id)
        if (!row) fail('not_found', '口令不存在', 404)
        if (row.revokedAt) return { unchanged: true, value: publicRow(row) }
        row.revokedAt = now()
        return { value: publicRow(row) }
      })
    },
    async login(code, buildings, sessionTtlMs) {
      if (typeof code !== 'string' || !/^wac1\.(ac_[a-f0-9]{32})\.[a-f0-9]{64}$/.test(code)) return null
      const id = code.split('.')[1], row = await active(id)
      if (!timingSafeEqual(await hash(code), row.digest)) fail('unauthorized', '口令不对', 401)
      const principal = access(row, buildings), expAt = Math.min(row.expiresAt, now() + sessionTtlMs)
      const session = await issueTicket({ role: 'admin', accessCodeId: id, exp: expAt, nonce: crypto.randomUUID() }, authSecret)
      return { session, expAt, ttlMs: expAt - now(), kind: 'temporary', role: 'admin', permissions: principal.permissions, identity }
    },
    async verifyRequest(c, buildings) {
      const token = c.req.header('x-admin-token') || c.req.query('token')
      if (!token) return null
      const payload = await verifyAdminSession(token, authSecret).catch(() => null)
      if (!payload) {
        // Untrusted decoding only identifies a credential that must fail closed;
        // it never grants permissions or accepts an expired/invalid signature.
        let hinted = token.startsWith('wac1.')
        try { hinted ||= Boolean(JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).accessCodeId) } catch { /* legacy credential */ }
        if (hinted) fail('admin_access_expired', '临时管理员会话无效或已过期', 401)
      }
      if (!payload?.accessCodeId) return null
      if (!idOK(payload.accessCodeId)) fail('unauthorized', '管理员会话无效', 401)
      const row = await active(payload.accessCodeId)
      return { ...access(row, buildings), expAt: Math.min(payload.exp, row.expiresAt) }
    },
  }
}
