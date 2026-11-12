import { apiErr, json } from '../packages/core/util.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'
import { readMachineDocument, updateMachineDocument } from '../packages/core/machine-documents.js'
import { getUserIdentity } from '../packages/core/identity.js'
import { getUserPermissions } from '../packages/core/permissions.js'
import { getSiteConfig } from './site.js'
import { resolveMachineDorm } from '../packages/core/buildings.js'
import { machineLabels } from '../packages/core/machine-labels.js'
import { machineAdminRules } from './machine-admin-access.js'

const TYPES = new Set(['name', 'location', 'state', 'other'])
const STATES = new Set(['open', 'reviewing', 'resolved', 'dismissed'])
const clean = (text) => text.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim()
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }) }
const list = (value) => Array.isArray(value) ? value : []
const allowed = (rules, mode, dorm) => rules?.[mode] === true && (rules[mode + 'Buildings'] === null || rules[mode + 'Buildings']?.includes(dorm))
const receipt = (row) => ({ id: row.id, status: row.status, at: row.at })

export function registerMachineFeedbackRoutes(app, { store, env = {}, authenticate, authorize, now = () => Date.now() }) {
  const bid = env.BUILDING_ID || 'b1', key = 'machine-feedback:' + bid
  const documentOptions=()=>({store,key,paged:true,fallback:[],now:now()})
  const wrap = (action) => async (c) => {
    try { return json(await action(c), 200, { 'Cache-Control': 'no-store' }) }
    catch (error) { return apiErr(error.code || 'unavailable', error.status ? error.message : '机器反馈暂不可用，请稍后重试', error.status || 503) }
  }
  async function body(c) {
    if (Number(c.req.header('content-length')) > 4096) fail('too_large', '反馈内容过长', 413)
    const bytes = await readStreamBytes(c.req.raw.body, 4096)
    if (!bytes) fail('too_large', '反馈内容过长', 413)
    let value
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('bad_param', '请提交有效的反馈') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('bad_param', '请提交有效的反馈')
    return value
  }
  const text = (value, max) => {
    if (typeof value !== 'string' || Array.from(value).length > max) fail('bad_param', `内容最多${max}字`)
    return clean(value)
  }
  async function manager(c, mode, dorm) {
    const rules = await machineAdminRules(c, { store, env, authorize, mode })
    if (rules && (dorm ? !allowed(rules, mode, dorm) : rules[mode] !== true)) fail('forbidden', '该楼栋不在授权范围', 403)
    return rules
  }
  app.post('/api/machines/:id/feedback', wrap(async (c) => {
    const principal = await authenticate(c)
    const uid = typeof principal === 'string' ? principal : principal?.id
    if (!uid) fail('unauthorized', '请先登录再反馈', 401)
    const input = await body(c), detail = text(input.detail, 300)
    if (Object.keys(input).some(key => !['type', 'detail'].includes(key))) fail('bad_param', '反馈字段无效')
    if (!TYPES.has(input.type) || !detail) fail('bad_param', '请选择情况并填写1–300字说明')
    const result=await updateMachineDocument(documentOptions(),async saved=>{
      const [user, site, board, savedMap] = await Promise.all([store.get('user:' + uid, null), getSiteConfig(store), store.get('machines:' + bid, null), store.get('mapping:' + bid, null)])
      if (!user || user.disabled || user.blocked) fail('unauthorized', '账号不可用', 401)
      const machine = list(board?.board?.floors).flatMap((floor) => list(floor.machines)).find((row) => String(row.id) === c.req.param('id'))
      if (!machine) fail('not_found', '机器不存在或已调整', 404)
      const dorm = resolveMachineDorm(machine, savedMap?.mapping || {}, site.buildings)
      if (!site.buildings.some((row) => row.code === dorm && row.enabled !== false)) fail('forbidden', '该住宿楼已停用', 403)
      const [identity, access] = await Promise.all([getUserIdentity(store, uid), getUserPermissions(store, user, site.buildings)])
      if (!allowed(access.permissions?.board, 'operate', dorm) || !(['super', 'admin'].includes(identity.role) || user.dormBuilding === dorm || identity.role === 'volunteer' && identity.buildings?.includes(dorm))) fail('forbidden', '只能反馈授权楼栋的机器', 403)
      const rows = list(saved).filter((row) => now() - Date.parse(row.at) < 90 * 86400000)
      const duplicate = rows.find((row) => row.reporterId === uid && row.machineId === String(machine.id) && row.type === input.type && row.detail === detail && ['open', 'reviewing'].includes(row.status))
      if (duplicate) return {document:rows,result:{ ok: true, feedback: receipt(duplicate), duplicate: true }}
      if (rows.length >= 1000) fail('too_many', '反馈队列暂满，请稍后再试', 429)
      const recent = rows.filter((row) => row.reporterId === uid && now() - Date.parse(row.at) < 86400000)
      if (recent.length >= 10 || recent.filter((row) => now() - Date.parse(row.at) < 60000).length >= 3) fail('too_many', '反馈较频繁，请稍后再试', 429)
      const at = new Date(now()).toISOString()
      const row = { id: 'mf_' + crypto.randomUUID(), reporterId: uid, machineId: String(machine.id), dormBuilding: dorm, ...machineLabels(machine, savedMap?.mapping || {}), type: input.type, detail, status: 'open', at, updatedAt: at }
      return {document:[...rows,row],result:{ ok: true, feedback: receipt(row), duplicate: false }}
    })
    return result.result
  }))
  app.get('/api/admin/machine-feedback', wrap(async (c) => {
    const rules = await manager(c, 'view'), dorm = c.req.query('dorm') || '', status = c.req.query('status') || ''
    if (dorm && rules && !allowed(rules, 'view', dorm)) fail('forbidden', '无权查看该住宿楼', 403)
    if (status && !STATES.has(status)) fail('bad_param', '反馈状态无效')
    const page = Number(c.req.query('page') || 1), limit = Number(c.req.query('limit') || 20)
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(limit) || limit < 1 || limit > 50) fail('bad_param', '分页参数无效')
    const rows = list(await readMachineDocument(documentOptions())).filter((row) => now() - Date.parse(row.at) < 90 * 86400000 && (!rules || allowed(rules, 'view', row.dormBuilding)) && (!dorm || row.dormBuilding === dorm) && (!status || row.status === status)).slice().reverse()
    return { ok: true, feedback: rows.slice((page - 1) * limit, page * limit).map(({ reporterId, ...row }) => ({ ...row, canHandle: !rules || allowed(rules, 'operate', row.dormBuilding) })), pagination: { page, limit, total: rows.length, hasMore: page * limit < rows.length } }
  }))
  app.patch('/api/admin/machine-feedback/:id', wrap(async (c) => {
    await manager(c, 'operate')
    const input = await body(c), resolution = text(input.resolution, 300)
    if (Object.keys(input).some(key => !['status', 'resolution'].includes(key))) fail('bad_param', '处理字段无效')
    if (!STATES.has(input.status) || ['resolved', 'dismissed'].includes(input.status) && !resolution) fail('bad_param', '请选择处理状态，关闭反馈时须填写说明')
    const result=await updateMachineDocument(documentOptions(),async saved=>{
      const rows = list(saved), index = rows.findIndex((row) => row.id === c.req.param('id'))
      if (index < 0) fail('not_found', '反馈不存在', 404)
      await manager(c, 'view', rows[index].dormBuilding)
      await manager(c, 'operate', rows[index].dormBuilding)
      const next = rows.map((row, at) => at === index ? { ...row, status: input.status, resolution, updatedAt: new Date(now()).toISOString() } : row)
      return {document:next,result:{ ok: true, feedback: receipt(next[index]) }}
    })
    return result.result
  }))
}
