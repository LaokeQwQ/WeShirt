// 住宿楼偏好与上游看板分区（BUILDING_ID）是两个独立概念。
export const DORM_BUILDINGS = Object.freeze([
  { code: 'guiyuan', name: '桂园' },
  { code: 'liuyuan', name: '柳园' },
  { code: 'liyuan', name: '李园' },
  { code: 'meiyuan', name: '梅园' },
  { code: 'juyuan', name: '菊园' },
  { code: 'zhuyuan', name: '竹园' },
])

export function normalizeDormBuilding(value, catalog = DORM_BUILDINGS) {
  return catalog.some((b) => b.code === value) ? value : null
}

export function dormBuildingName(code, catalog = DORM_BUILDINGS) {
  return catalog.find((b) => b.code === code)?.name || ''
}

export function resolveMachineDorm(machine, slotMapping = {}, catalog = DORM_BUILDINGS) {
  // 现有现场绑定属于桂园，别名设备也以人工确认的机位为准。
  if (machine?.id != null && Object.values(slotMapping).some((id) => id != null && String(id) === String(machine.id))) return 'guiyuan'
  const explicit = normalizeDormBuilding(machine?.dormBuilding, catalog)
  if (explicit) return explicit
  if (/^[123]F-(?:\d+|D\d+)$/i.test(String(machine?.id))) return 'guiyuan'
  const name = String(machine?.name || '')
  const matches = catalog.filter((b) => name.includes(b.name))
  return matches.length === 1 ? matches[0].code : null
}

export function filterDormFloors(board, code, catalog = DORM_BUILDINGS) {
  if (!normalizeDormBuilding(code, catalog)) return []
  return (board?.floors || []).map((floor) => ({
    ...floor,
    machines: (floor.machines || []).filter((machine) => resolveMachineDorm(machine, board?.slotMapping, catalog) === code),
  })).filter((floor) => floor.machines.length)
}

export function summarizeDormBuildings(board, slotMapping = {}, catalog = DORM_BUILDINGS) {
  const list = (board?.floors || []).flatMap((floor) => floor.machines || [])
  return catalog.map((building) => {
    const machines = list.filter((m) => resolveMachineDorm(m, slotMapping, catalog) === building.code)
    const count = (states) => machines.filter((m) => states.includes(m.state)).length
    return { ...building, total: machines.length, idle: count(['idle']), occupied: count(['occupied', 'abnormal']), faulty: count(['faulty']), unknown: count(['unknown']) }
  })
}
