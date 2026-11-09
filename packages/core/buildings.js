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
  return catalog.some((b) => b.code === value && b.enabled !== false) ? value : null
}

export const enabledDormBuildings = (catalog = DORM_BUILDINGS) => catalog.filter((building) => building.enabled !== false)
export const normalizeKnownDormBuilding = (value, catalog = DORM_BUILDINGS) => catalog.some(building=>building.code===value)?value:null

export function dormBuildingName(code, catalog = DORM_BUILDINGS) {
  return catalog.find((b) => b.code === code)?.name || ''
}

export function resolveMachineDorm(machine, slotMapping = {}, catalog = DORM_BUILDINGS) {
  // 现有现场绑定属于桂园，别名设备也以人工确认的机位为准。
  if (machine?.id != null && Object.values(slotMapping).some((id) => id != null && String(id) === String(machine.id))) return 'guiyuan'
  const explicit = normalizeKnownDormBuilding(machine?.dormBuilding, catalog)
  if (explicit) return explicit
  if (/^[123]F-(?:\d+|D\d+)$/i.test(String(machine?.id))) return 'guiyuan'
  const name = String(machine?.name || '')
  const matches = catalog.filter((b) => name.includes(b.name))
  return matches.length === 1 ? matches[0].code : null
}

// A disabled building must keep its identity for diagnostics. Unknown machines
// remain visible until an explicit building or physical slot identifies them.
export function isMachineDormEnabled(machine, catalog = DORM_BUILDINGS, slotMapping = {}) {
  const code = resolveMachineDorm(machine, slotMapping, catalog)
  return !catalog.some((building) => building.code === code && building.enabled === false)
}

export async function currentDormCatalog(store, fallback = DORM_BUILDINGS) {
  const site = await store.get('meta:site', null)
  return Array.isArray(site?.buildings) && site.buildings.length ? site.buildings
    : Array.isArray(fallback) && fallback.length ? fallback : DORM_BUILDINGS
}

export function enabledMachineBoard(board, catalog = DORM_BUILDINGS, slotMapping = board?.slotMapping || {}) {
  const floors = (board?.floors || []).map((floor) => ({ ...floor,
    machines: (floor.machines || []).filter((machine) => isMachineDormEnabled(machine, catalog, slotMapping)),
  })).filter((floor) => floor.machines.length)
  const machines = floors.flatMap((floor) => floor.machines)
  return { ...board, floors, total: machines.length,
    ...Object.fromEntries(['idle', 'occupied', 'faulty', 'unknown'].map((state) => [state,
      machines.filter((machine) => machine.state === state || state === 'occupied' && machine.state === 'abnormal').length])),
  }
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
