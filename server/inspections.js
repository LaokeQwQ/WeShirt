import { json as baseJson, apiErr } from '../packages/core/util.js'
import { getUserIdentity, canInspect, canModerate } from '../packages/core/identity.js'
import { normalizeDormBuilding, resolveMachineDorm } from '../packages/core/buildings.js'
import { withOperationLock } from '../packages/core/operations.js'
import { getSiteConfig } from './site.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'

const GROUPS_KEY = 'operations:buildingGroups'
const MAX_BODY = 700 * 1024
const MAX_PHOTO = 500 * 1024
const MAX_DIMENSION = 4096
const MAX_PIXELS = 4000000
const RETENTION = 30 * 86400000
const COOLDOWN = 10 * 60000
const json = (data, status = 200, headers = {}) => baseJson(data, status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const photoKey = (id) => 'inspections:photo:' + id

async function readBody(c) {
  const advertised = Number(c.req.header('content-length'))
  if (advertised > MAX_BODY) return { error: apiErr('too_large', '巡检内容超过 700KB', 413) }
  try {
    if (!c.req.raw.body) return { error: apiErr('bad_param', '需要 JSON 内容') }
    const bytes = await readStreamBytes(c.req.raw.body, MAX_BODY)
    if (!bytes) return { error: apiErr('too_large', '巡检内容超过 700KB', 413) }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return { body }
  } catch { return { error: apiErr('bad_param', '需要有效 JSON 内容') } }
}

function imageDimensions(binary, mime) {
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const u16 = (at, little = false) => view.getUint16(at, little)
  const u32 = (at, little = false) => view.getUint32(at, little)
  const u24 = (at) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
  const size = (width, height) => {
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('照片最长边不能超过 4096 像素，总像素不能超过 400 万')
    return [width, height]
  }
  const invalid = () => { throw new Error('照片结构不完整或内容与类型不符，请重新选择静态照片') }
  if (mime === 'image/png') {
    if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => b === bytes[i])) return invalid()
    let dimensions, data = false
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = u32(at), type = binary.slice(at + 4, at + 8), end = at + length + 12
      if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) return invalid()
      if (at === 8 && (type !== 'IHDR' || length !== 13)) return invalid()
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) return invalid()
      if (type === 'IHDR') {
        if (dimensions || length !== 13) return invalid()
        dimensions = size(u32(at + 8), u32(at + 12))
        const depth = bytes[at + 16], color = bytes[at + 17]
        if (!({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color] || []).includes(depth) || bytes[at + 18] || bytes[at + 19] || bytes[at + 20] > 1) return invalid()
      }
      if (type === 'IDAT' && length) data = true
      if (type === 'IEND') return !length && end === bytes.length && data && dimensions ? dimensions : invalid()
      at = end
    }
    return invalid()
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return invalid()
    let dimensions
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 255) return invalid()
      while (bytes[at] === 255) at++
      const marker = bytes[at++]
      if (marker === 1 || marker >= 208 && marker <= 215) continue
      if (at + 2 > bytes.length) return invalid()
      const length = u16(at)
      if (length < 2 || at + length > bytes.length) return invalid()
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 11 || length !== 8 + 3 * bytes[at + 7]) return invalid()
        dimensions = size(u16(at + 5), u16(at + 3))
      }
      if (marker === 218) return dimensions && at + length < bytes.length - 2 ? dimensions : invalid()
      at += length
    }
    return invalid()
  }
  if (mime === 'image/webp') {
    if (bytes.length < 26 || binary.slice(0, 4) !== 'RIFF' || binary.slice(8, 12) !== 'WEBP' || u32(4, true) + 8 !== bytes.length) return invalid()
    let canvas, dimensions
    for (let at = 12; at + 8 <= bytes.length;) {
      const type = binary.slice(at, at + 4), length = u32(at + 4, true), data = at + 8, end = data + length
      if (end + (length % 2) > bytes.length || length % 2 && bytes[end] !== 0 || ['ANIM', 'ANMF'].includes(type)) return invalid()
      if (type === 'VP8X') {
        if (at !== 12 || length !== 10 || bytes[data] & 2) return invalid()
        canvas = size(u24(data + 4) + 1, u24(data + 7) + 1)
      } else if (type === 'VP8 ') {
        if (dimensions || length <= 10 || bytes[data] & 1 || binary.slice(data + 3, data + 6) !== '\x9d\x01\x2a') return invalid()
        dimensions = size(u16(data + 6, true) & 16383, u16(data + 8, true) & 16383)
      } else if (type === 'VP8L') {
        if (dimensions || length <= 5 || bytes[data] !== 47 || bytes[data + 4] >> 5) return invalid()
        dimensions = size((bytes[data + 1] | (bytes[data + 2] & 63) << 8) + 1, ((bytes[data + 2] >> 6) | bytes[data + 3] << 2 | (bytes[data + 4] & 15) << 10) + 1)
      }
      at = end + (length % 2)
      if (at === bytes.length) return dimensions && (!canvas || canvas.every((n, i) => n === dimensions[i])) ? dimensions : invalid()
    }
    return invalid()
  }
  if (mime === 'image/gif') {
    if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(binary.slice(0, 6))) return invalid()
    const dimensions = size(u16(6, true), u16(8, true))
    let at = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), images = 0
    const skipBlocks = () => {
      while (at < bytes.length) { const length = bytes[at++]; if (!length) return; at += length; if (at > bytes.length) return invalid() }
      return invalid()
    }
    while (at < bytes.length) {
      const kind = bytes[at++]
      if (kind === 59) return images === 1 && at === bytes.length ? dimensions : invalid()
      if (kind === 33) { if (at >= bytes.length) return invalid(); at++; skipBlocks() }
      else if (kind === 44) {
        if (++images > 1 || at + 9 > bytes.length) return invalid()
        const width = u16(at + 4, true), height = u16(at + 6, true)
        size(width, height)
        if (u16(at, true) + width > dimensions[0] || u16(at + 2, true) + height > dimensions[1]) return invalid()
        const packed = bytes[at + 8]
        at += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0)
        if (bytes[at] < 2 || bytes[at] > 8) return invalid()
        at++; skipBlocks()
      } else return invalid()
    }
  }
  return invalid()
}

export function validateInspectionPhoto(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PHOTO / 3) * 4 + 40) throw new Error('照片须为不超过 500KB 的 PNG、JPEG、WebP 或 GIF 图片')
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match || match[2].length % 4 !== 0) throw new Error('照片必须是有效的光栅图片，不能使用 SVG 或外部地址')
  let binary
  try { binary = atob(match[2]); if (btoa(binary) !== match[2]) throw new Error() } catch { throw new Error('照片编码无效') }
  if (!binary.length || binary.length > MAX_PHOTO) throw new Error('照片不能超过 500KB')
  imageDimensions(binary, match[1])
  return value
}

function validConversationId(value) {
  return typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9_:+@.=/\-]+$/.test(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !value.startsWith('//')
}

export async function getBuildingGroups(store, buildings = null) {
  const catalog = buildings || (await getSiteConfig(store)).buildings
  const saved = await store.get(GROUPS_KEY, {})
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  return Object.fromEntries(catalog.filter((b) => b.code !== 'public' && validConversationId(saved[b.code])).map((b) => [b.code, saved[b.code]]))
}

export function registerInspectionRoutes(app, { store, env = {}, authenticate, getBoard, checkSuperAdmin, notifyBuilding, now = () => Date.now(), notificationTimeoutMs = 12000 }) {
  const bid = env.BUILDING_ID || 'b1'
  const historyKey = 'inspections:' + bid
  const cleanupKey = 'inspections:cleanup:' + bid
  const access = async (c) => {
    const value = await authenticate?.(c)
    const user = typeof value === 'string' ? await store.get('user:' + value, null) : value
    if (await checkSuperAdmin?.(c)) return { user, identity: { role: 'super', label: '总管', buildings: [] } }
    if (!user?.id) return null
    return { user, identity: await getUserIdentity(store, user.id) }
  }
  const context = async (c) => {
    const [supplied, mapping, site] = await Promise.all([getBoard ? getBoard(c) : store.get('machines:' + bid, null), store.get('mapping:' + bid, {}), getSiteConfig(store)])
    const board = supplied?.board || supplied
    const slotMap = supplied?.mapping?.mapping || supplied?.mapping || mapping?.mapping || board?.slotMapping || {}
    const machines = (board?.floors || []).flatMap((floor) => floor.machines || []).map((m) => ({ id: String(m.id), name: String(m.displayName || m.name || m.id), kind: m.kind === 'dryer' ? 'dryer' : 'washer', state: m.state || 'unknown', dormBuilding: resolveMachineDorm(m, slotMap, site.buildings) }))
    return { machines, buildings: site.buildings.filter((b) => b.code !== 'public' && b.enabled !== false) }
  }
  // History stores metadata only. Cleanup is bounded to fifty photo deletes per request;
  // unfinished deletes remain in a durable queue for a subsequent read or write.
  const cleanHistory = async (deleteLimit = 50) => {
    const stored = await store.get(historyKey, [])
    const list = Array.isArray(stored) ? stored : []
    const alive = list.filter((entry) => validId(entry?.id) && Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= now() - RETENTION && Date.parse(entry.at) <= now() + 60000).slice(-200)
    const keep = new Set(alive.map((entry) => entry.id))
    const pending = await store.get(cleanupKey, [])
    const garbage = [...new Set([...(Array.isArray(pending) ? pending : []), ...list.filter((entry) => !keep.has(entry?.id)).map((entry) => entry?.id)].filter(validId))]
    const batch = garbage.slice(0, deleteLimit)
    const deleted = await Promise.allSettled(batch.map((id) => store.del(photoKey(id))))
    const retry = batch.filter((_, index) => deleted[index].status === 'rejected')
    await store.put(cleanupKey, [...retry, ...garbage.slice(deleteLimit)])
    await store.put(historyKey, alive)
    return alive
  }
  const publicInspection = (entry) => ({ id: entry.id, machineId: entry.machineId, machineName: entry.machineName, dormBuilding: entry.dormBuilding, status: entry.status, note: entry.note, at: entry.at, inspector: entry.inspector, hasPhoto: true, notification: entry.notification })

  app.get('/api/user/identity', async (c) => {
    const actor = await access(c)
    if (!actor) return apiErr('unauthorized', '请先登录', 401)
    c.header('Cache-Control', 'no-store')
    return json({ identity: actor.identity })
  })

  app.get('/api/inspections', async (c) => {
    const actor = await access(c)
    if (!actor) return apiErr('unauthorized', '请先登录', 401)
    const { machines, buildings } = await context(c)
    const allowed = buildings.filter((b) => canInspect(actor.identity, b.code))
    if (!allowed.length) return apiErr('forbidden', '没有巡检权限', 403)
    const dorm = c.req.query('dorm') || ''
    if (dorm && !normalizeDormBuilding(dorm, buildings)) return apiErr('bad_param', '住宿楼无效')
    if (dorm && !canInspect(actor.identity, dorm)) return apiErr('forbidden', '未获该楼巡检权限', 403)
    const allowedCodes=new Set(allowed.map(building=>building.code))
    const scoped = (code) => allowedCodes.has(code) && (!dorm || code === dorm) && canInspect(actor.identity, code)
    const rows = await withOperationLock(store, historyKey, () => cleanHistory())
    c.header('Cache-Control', 'no-store')
    return json({ identity: actor.identity, buildings: allowed, machines: machines.filter((m) => scoped(m.dormBuilding)), inspections: rows.filter((entry) => scoped(entry.dormBuilding)).slice().reverse().map(publicInspection) })
  })

  app.get('/api/inspections/:id/photo', async (c) => {
    const actor = await access(c)
    if (!actor) return apiErr('unauthorized', '请先登录', 401)
    if (!canModerate(actor.identity) && actor.identity.role !== 'volunteer') return apiErr('forbidden', '没有巡检权限', 403)
    const { buildings } = await context(c)
    const rows = await withOperationLock(store, historyKey, () => cleanHistory())
    const entry = rows.find((row) => row.id === c.req.param('id'))
    if (!entry) return apiErr('not_found', '巡检记录不存在或已过期', 404)
    if (!normalizeDormBuilding(entry.dormBuilding, buildings) || !canInspect(actor.identity, entry.dormBuilding)) return apiErr('forbidden', '未获该楼巡检权限', 403)
    const photoData = await store.get(photoKey(entry.id), null)
    if (!photoData) return apiErr('not_found', '照片不存在或已过期', 404)
    c.header('Cache-Control', 'private, no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    return json({ photoData }, 200, { 'cache-control': 'private, no-store' })
  })

  app.post('/api/inspections', async (c) => {
    const actor = await access(c)
    if (!actor) return apiErr('unauthorized', '请先登录', 401)
    if (!canModerate(actor.identity) && actor.identity.role !== 'volunteer') return apiErr('forbidden', '没有巡检权限', 403)
    const { body, error } = await readBody(c)
    if (error) return error
    if (Object.keys(body).some((key) => !['machineId', 'status', 'note', 'photoData', 'dorm'].includes(key)) || !validId(body.machineId) || !['normal', 'issue'].includes(body.status) || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.note)) return apiErr('bad_param', '请填写有效机器、巡检结果和 1–500 字备注或异常说明')
    let photo
    try { photo = validateInspectionPhoto(body.photoData) } catch (e) { return apiErr('bad_param', e.message) }
    // Share the site mutation lock only during the short authorization/save phase.
    // An upload that started before revocation must not retain its old scope.
    const prepared = await withOperationLock(store, 'site-config', () => withOperationLock(store, historyKey, async () => {
      const currentActor = await access(c)
      const { machines, buildings } = await context(c)
      const machine = machines.find((m) => m.id === body.machineId)
      if (!machine) return apiErr('not_found', '机器已下线，请刷新', 404)
      if (!normalizeDormBuilding(machine.dormBuilding, buildings)) return apiErr('unavailable', '机器楼栋尚未确认，不能提交巡检', 409)
      if (!currentActor || !canInspect(currentActor.identity, machine.dormBuilding)) return apiErr('forbidden', '未获该机器所在楼栋的巡检权限', 403)
      const list = await cleanHistory()
      const clock = now()
      const entry = { id: 'inspection_' + crypto.randomUUID(), machineId: machine.id, machineName: machine.name, dormBuilding: machine.dormBuilding, status: body.status, note: body.note.trim(), at: new Date(clock).toISOString(), inspector: { userId: currentActor.user?.id || null, nick: String(currentActor.user?.nick || '最高管理员').slice(0, 30) }, notification: { status: body.status === 'normal' ? 'not_required' : 'unconfigured' } }
      let delivery = null
      if (body.status === 'issue') {
        const groups = await getBuildingGroups(store, buildings)
        const conversationId = groups[machine.dormBuilding]
        const cooldownKey = 'inspections:cooldown:' + bid + ':' + machine.id
        const previous = Number(await store.get(cooldownKey, 0))
        if (conversationId && typeof notifyBuilding === 'function') {
          if (previous > 0 && clock - previous < COOLDOWN) entry.notification = { status: 'cooldown', retryAt: new Date(previous + COOLDOWN).toISOString() }
          else {
            await store.put(cooldownKey, clock)
            entry.notification = { status: 'sending', at: entry.at }
            delivery = { buildingCode: machine.dormBuilding, conversationId, inspection: publicInspection(entry) }
          }
        }
      }
      await store.put(photoKey(entry.id), photo)
      await store.put(historyKey, [...list, entry])
      await cleanHistory(0)
      return { entry, delivery }
    }))
    if (prepared instanceof Response) return prepared
    let entry = prepared.entry
    if (prepared.delivery) {
      // No history/site lock is held while the external channel is in flight.
      const controller = new AbortController()
      let timer
      const timeout = Math.max(1, Math.min(12000, Number(notificationTimeoutMs) || 12000))
      const result = await Promise.race([
        Promise.resolve().then(() => notifyBuilding({ ...prepared.delivery, signal: controller.signal })).catch(() => ({ ok: false, reason: 'delivery_error' })),
        new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ ok: false, reason: 'timeout' }) }, timeout) }),
      ]).finally(() => clearTimeout(timer))
      const notification = { status: result?.ok === true ? 'sent' : 'failed', at: new Date(now()).toISOString(), ...(result?.reason === 'timeout' ? { reason: 'timeout' } : {}) }
      entry = await withOperationLock(store, historyKey, async () => {
        // Merge by ID into the latest history, preserving intervening submissions.
        const rows = (await store.get(historyKey, [])) || []
        const index = rows.findIndex((row) => row.id === prepared.entry.id)
        const updated = { ...(index >= 0 ? rows[index] : prepared.entry), notification }
        if (index >= 0) await store.put(historyKey, rows.map((row, i) => i === index ? updated : row))
        return updated
      })
    }
    return json({ ok: true, inspection: publicInspection(entry) })
  })

  app.get('/api/admin/building-groups', async (c) => {
    const actor = await access(c)
    if (!actor) return apiErr('unauthorized', '请先登录', 401)
    if (!canModerate(actor.identity)) return apiErr('forbidden', '需要总管或管理员权限', 403)
    const buildings = (await getSiteConfig(store)).buildings.filter((b) => b.code !== 'public')
    const groups = await getBuildingGroups(store, buildings)
    c.header('Cache-Control', 'no-store')
    return json({ buildings, groups: Object.entries(groups).map(([buildingCode, conversationId]) => ({ buildingCode, conversationId })) })
  })

  app.patch('/api/admin/building-groups', async (c) => {
    const actor = await access(c)
    if (!actor) return apiErr('unauthorized', '请先登录', 401)
    if (!canModerate(actor.identity)) return apiErr('forbidden', '需要总管或管理员权限', 403)
    const { body, error } = await readBody(c)
    if (error) return error
    const buildings = (await getSiteConfig(store)).buildings.filter((b) => b.code !== 'public')
    if (Object.keys(body).some((key) => !['buildingCode', 'conversationId'].includes(key)) || !normalizeDormBuilding(body.buildingCode, buildings) || typeof body.conversationId !== 'string' || body.conversationId !== '' && !validConversationId(body.conversationId)) return apiErr('bad_param', '请填写有效楼栋和不超过 256 字的群会话 ID，不能填写 URL')
    return withOperationLock(store, GROUPS_KEY, async () => {
      const groups = await getBuildingGroups(store, buildings)
      if (body.conversationId) groups[body.buildingCode] = body.conversationId
      else delete groups[body.buildingCode]
      await store.put(GROUPS_KEY, groups)
      c.header('Cache-Control', 'no-store')
      return json({ ok: true, groups: Object.entries(groups).map(([buildingCode, conversationId]) => ({ buildingCode, conversationId })) })
    })
  })
}
