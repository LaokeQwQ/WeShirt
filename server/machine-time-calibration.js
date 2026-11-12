import { apiErr, json } from '../packages/core/util.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'
import { publicCalibration, readCalibrationSettings, updateCalibrationSettings } from '../packages/core/machine-time-calibration.js'
import { resolveMachineDorm } from '../packages/core/buildings.js'
import { machineLabels } from '../packages/core/machine-labels.js'
import { getSiteConfig } from './site.js'
import { machineAdminRules } from './machine-admin-access.js'

const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }) }
const allowed = (rules, mode, dorm) => !rules || rules[mode] === true && (rules[mode + 'Buildings'] === null || rules[mode + 'Buildings']?.includes(dorm))
export function registerMachineTimeCalibrationRoutes(app, { store, env, authorize }) {
  const bid = env.BUILDING_ID || 'b1'
  const wrap = action => async c => {
    try { return json(await action(c), 200, { 'Cache-Control': 'no-store' }) }
    catch (error) { return apiErr(error.code || 'unavailable', error.status ? error.message : '校时设置暂不可用，请稍后重试', error.status || 503) }
  }
  async function access(c, mode) {
    return machineAdminRules(c, { store, env, authorize, mode })
  }
  async function machines() {
    const [entry, mapping, site] = await Promise.all([store.get('machines:' + bid, null), store.get('mapping:' + bid, null), getSiteConfig(store)])
    return (entry?.board?.floors || []).flatMap(floor => floor.machines || []).map(machine => ({ ...machine, ...machineLabels(machine, mapping?.mapping || {}), dormBuilding: resolveMachineDorm(machine, mapping?.mapping || {}, site.buildings) }))
  }
  app.get('/api/admin/machine-time-calibration', wrap(async c => {
    const rules = await access(c, 'view'), settings = await readCalibrationSettings(store,bid)
    return { ok: true, machines: (await machines()).filter(machine => allowed(rules, 'view', machine.dormBuilding)).map(machine => ({ id: machine.id, displayName: machine.displayName, dormBuilding: machine.dormBuilding, ...publicCalibration(settings.machines?.[machine.id]), canOperate: allowed(rules, 'operate', machine.dormBuilding) })) }
  }))
  app.patch('/api/admin/machine-time-calibration/:id', wrap(async c => {
    await access(c, 'operate')
    const bytes = await readStreamBytes(c.req.raw.body, 2048)
    let input
    try { input = bytes && JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('bad_param', '校时设置无效') }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['offsetMinutes', 'autoEnabled', 'resetLearning'].includes(key))) fail('bad_param', '校时字段无效')
    if ('offsetMinutes' in input && (!Number.isInteger(input.offsetMinutes) || Math.abs(input.offsetMinutes) > 120)) fail('bad_param', '校准值须为 -120 至 +120 的整数分钟')
    for (const field of ['autoEnabled', 'resetLearning']) if (field in input && typeof input[field] !== 'boolean') fail('bad_param', '校时开关无效')
    const result=await updateCalibrationSettings(store,bid,async settings=>{
      const rules = await access(c, 'operate')
      const machine = (await machines()).find(row => String(row.id) === c.req.param('id'))
      if (!machine) fail('not_found', '机器不存在', 404)
      if (!allowed(rules, 'view', machine.dormBuilding) || !allowed(rules, 'operate', machine.dormBuilding)) fail('forbidden', '该机器不在授权范围', 403)
      const current = settings.machines?.[machine.id] || {}
      const next = { ...current }
      if ('offsetMinutes' in input) next.offsetMinutes = input.offsetMinutes
      if ('autoEnabled' in input) { next.autoEnabled = input.autoEnabled; if (next.autoEnabled !== current.autoEnabled) delete next.cycle }
      if (input.resetLearning) { next.samples = []; next.learnedOffsetMinutes = 0; next.lastCalibratedAt = null; delete next.cycle }
      const updatedAt = new Date().toISOString()
      return {document:{ ...settings, updatedAt, machines: { ...(settings.machines || {}), [machine.id]: next } },result:{ ok: true, machine: { id: machine.id, ...publicCalibration(next) }, updatedAt }}
    })
    return result.result
  }))
}
