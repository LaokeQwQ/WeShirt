import { apiErr, json } from '../packages/core/util.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'
import { withOperationLock } from '../packages/core/operations.js'

const REASONS = new Set(['spam', 'abuse', 'privacy', 'unsafe', 'other'])
const STATES = new Set(['open', 'reviewing', 'resolved', 'dismissed'])
const CLOSED = new Set(['resolved', 'dismissed'])
const clean = (value) => value.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim()
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }) }
const array = (value) => Array.isArray(value) ? value : []
const permitted = (requester, channel, mode) => {
  if (!['super', 'admin'].includes(requester.identity?.role)) return false
  const rule = requester.rules?.adminMessages
  return !rule || rule[mode] === true && (rule[mode + 'Buildings'] === null || rule[mode + 'Buildings']?.includes(channel))
}
const publicReceipt = (row) => ({ id: row.id, status: row.status, at: row.at })
const publicReport = ({ reporterId, ...row }, requester) => ({ ...row, permissions: { canHandle: permitted(requester, row.channel, 'operate') } })

// Reuse community's current identity, channel ACL and legacy message resolution.
// Reports live separately from messages so deletion cannot remove the evidence.
export function registerCommunityReportRoutes(app, { store, bid, actor, context, messageChannel, requireChannel, now = () => Date.now() }) {
  const key = 'community:reports:' + bid
  const wrap = (action) => async (c) => {
    try { return json(await action(c), 200, { 'Cache-Control': 'no-store' }) }
    catch (error) { return apiErr(error.code || 'unavailable', error.status ? error.message : '举报暂不可用，请稍后重试', error.status || 503) }
  }
  async function body(c) {
    if (Number(c.req.header('content-length')) > 4096) fail('too_large', '举报内容过长', 413)
    const bytes = await readStreamBytes(c.req.raw.body, 4096)
    if (!bytes) fail('too_large', '举报内容过长', 413)
    let value
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('bad_param', '请提交有效的举报内容') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('bad_param', '请提交有效的举报内容')
    return value
  }
  function text(value, max, label) {
    if (value == null) return ''
    if (typeof value !== 'string' || Array.from(value).length > max) fail('bad_param', label + '最多' + max + '字')
    return clean(value)
  }
  async function manager(c) {
    const requester = await actor(c, false, false, true)
    if (!['super', 'admin'].includes(requester.identity?.role)) fail(requester.user?.id ? 'forbidden' : 'unauthorized', '需要管理员权限', requester.user?.id ? 403 : 401)
    return requester
  }
  app.post('/api/messages/:id/report', wrap(async (c) => {
    await actor(c, true, false, true)
    const input = await body(c), reason = input.reason
    if (!REASONS.has(reason)) fail('bad_param', '请选择举报原因')
    const detail = text(input.detail, 300, '补充说明')
    if (reason === 'other' && !detail) fail('bad_param', '请补充举报原因')
    return withOperationLock(store, key, async () => {
      const [requester, ctx] = await Promise.all([actor(c, true, false, true), context()])
      const message = array(await store.get('messages:' + bid, [])).find((row) => row.id === c.req.param('id') && !row.deleted)
      if (!message) fail('not_found', '这条消息已不存在', 404)
      const channel = messageChannel(message, ctx)
      requireChannel(requester, channel, ctx, 'operate')
      if (message.userId === requester.user.id) fail('bad_param', '自己的消息可直接删除')
      const rows = array(await store.get(key, [])).filter((row) => !CLOSED.has(row.status) || now() - Date.parse(row.updatedAt || row.at) < 90 * 86400000)
      const duplicate = rows.find((row) => row.messageId === message.id && row.reporterId === requester.user.id)
      if (duplicate) return { report: publicReceipt(duplicate), duplicate: true }
      if (rows.length >= 500) fail('too_many', '举报队列暂满，请稍后再试', 429)
      const rateKey = 'community:report-rate:' + requester.user.id
      const recent = array(await store.get(rateKey, [])).filter((at) => Number.isFinite(at) && now() - at < 86400000)
      if (recent.length >= 10 || recent.filter((at) => now() - at < 60000).length >= 3) fail('too_many', '举报提交较频繁，请稍后再试', 429)
      const at = new Date(now()).toISOString()
      const row = { id: 'report_' + crypto.randomUUID(), reporterId: requester.user.id, messageId: message.id, channel, reason, detail, status: 'open', at, updatedAt: at,
        snapshot: { text: String(message.text || '').slice(0, 1000), nick: String(message.nick || '').slice(0, 100), at: message.at || null, type: message.type === 'announcement' ? 'announcement' : 'message', machineId: message.machineId || null,
          media: message.media ? { kind: message.media.kind, mime: message.media.mime } : null } }
      // Reserve the bounded rate before committing; failed writes never publish a receipt.
      await store.put(rateKey, [...recent, now()])
      await store.put(key, [...rows, row])
      return { report: publicReceipt(row), duplicate: false }
    })
  }))
  app.get('/api/admin/community-reports', wrap(async (c) => {
    const requester = await manager(c), channel = c.req.query('channel') || '', status = c.req.query('status') || ''
    if (status && !STATES.has(status)) fail('bad_param', '举报状态无效')
    if (channel && !permitted(requester, channel, 'view')) fail('forbidden', '该频道不在授权查看范围内', 403)
    const limit = Number(c.req.query('limit') || 20), page = Number(c.req.query('page') || 1)
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(page) || page < 1 || page > 100) fail('bad_param', '分页参数无效')
    if (requester.rules?.adminMessages && !requester.rules.adminMessages.view) fail('forbidden', '没有举报查看权限', 403)
    const rows = array(await store.get(key, [])).filter((row) => permitted(requester, row.channel, 'view') && (!channel || row.channel === channel) && (!status || row.status === status)).slice().reverse()
    return { reports: rows.slice((page - 1) * limit, page * limit).map((row) => publicReport(row, requester)), pagination: { page, limit, total: rows.length, hasMore: page * limit < rows.length } }
  }))
  app.patch('/api/admin/community-reports/:id', wrap(async (c) => {
    await manager(c)
    const input = await body(c)
    if (!STATES.has(input.status)) fail('bad_param', '举报状态无效')
    const resolution = text(input.resolution, 300, '处理说明')
    if (CLOSED.has(input.status) && !resolution) fail('bad_param', '请填写处理说明')
    return withOperationLock(store, key, async () => {
      const requester = await manager(c), rows = array(await store.get(key, []))
      const row = rows.find((entry) => entry.id === c.req.param('id'))
      if (!row) fail('not_found', '举报不存在', 404)
      if (!permitted(requester, row.channel, 'view') || !permitted(requester, row.channel, 'operate')) fail('forbidden', '该举报不在授权处理范围内', 403)
      const updatedAt = new Date(now()).toISOString()
      const updated = { ...row, status: input.status, resolution, updatedAt }
      await store.put(key, rows.map((entry) => entry.id === row.id ? updated : entry))
      return { report: publicReport(updated, requester) }
    })
  }))
}
