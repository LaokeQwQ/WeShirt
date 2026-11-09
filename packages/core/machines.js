// WeShirt 设备状态机（Agent Scraper 负责）
// 契约：docs/CONTRACTS.md §2.5
// 纯函数 / ESM

// 剩余分钟（四舍五入）。finishAt 为空或非法 → null；已过期 → 0 或负数（不截断）
export function computeLeftMin(finishAt, nowISOstr) {
  if (!finishAt || typeof finishAt !== 'string') return null
  const end = new Date(finishAt).getTime()
  const now = new Date(nowISOstr).getTime()
  if (Number.isNaN(end) || Number.isNaN(now)) return null
  return Math.round((end - now) / 60000)
}

// 按楼层分组排序，返回看板结构
export function buildBoard(machines, { buildingId, buildingName } = {}) {
  const list = Array.isArray(machines) ? machines : []
  const updatedAt = new Date().toISOString()
  const floorsMap = new Map()
  let idle = 0
  let occupied = 0
  let faulty = 0

  for (const m of list) {
    const code = m.floorCode ?? ''
    if (!floorsMap.has(code)) floorsMap.set(code, [])
    const leftMin = computeLeftMin(m.finishAt, updatedAt)
    floorsMap.get(code).push({ ...m, leftMin })
    if (m.state === 'idle') idle += 1
    else if (m.state === 'occupied') occupied += 1
    else if (m.state === 'faulty') faulty += 1
  }

  const floors = [...floorsMap.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([code, ms]) => ({ code, machines: ms }))

  return {
    buildingId: buildingId ?? 'b1',
    buildingName: buildingName ?? '',
    updatedAt,
    total: list.length,
    idle,
    occupied,
    faulty,
    floors,
  }
}

// 比较前后快照，产生状态迁移事件；prev 为空数组时不产生事件
export function diffEvents(prevMachines, nextMachines) {
  const prev = Array.isArray(prevMachines) ? prevMachines : []
  const next = Array.isArray(nextMachines) ? nextMachines : []
  if (prev.length === 0) return []

  const prevById = new Map(prev.map((m) => [m.id, m]))
  const events = []

  for (const n of next) {
    const p = prevById.get(n.id)
    if (!p) continue
    if (n.state === 'idle' && p.state !== 'idle') {
      events.push({ type: 'becameIdle', machine: n })
    } else if (n.state === 'occupied' && p.state !== 'occupied') {
      events.push({ type: 'started', machine: n })
    } else if (n.state === 'faulty' && p.state !== 'faulty') {
      events.push({ type: 'fault', machine: n })
    } else if (n.state === 'unknown' && p.state !== 'unknown') {
      // 上游给了不认识的 state：也算一次状态变化，群里和自检都要能看见
      events.push({ type: 'unknown', machine: n })
    }
  }
  return events
}
