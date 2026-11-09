// 用户登记是可用性依据，不是设备遥测。仅投影公开状态，不写入任务或占用表。
const MAX_REPORTED_MS = 4 * 60 * 60000

function clearOldProjection(machine) {
  if (machine.availabilitySource !== 'user_report') return machine
  const { availabilitySource, registrationPending, availabilityLabel, ...clean } = machine
  // 持久看板可能带有上一轮登记投影；关联失效时不能沿用它的估计计时。
  if (!['occupied', 'abnormal'].includes(clean.upstreamState)) {
    clean.finishAt = null
    clean.leftMin = null
    clean.estimated = false
  }
  if (clean.state === 'occupied' && clean.upstreamState === 'idle') clean.state = 'idle'
  return clean
}

function activeRegistration(machine, occupancy, tasksByUser, now) {
  if (!Number.isFinite(now)) return null
  if (!Object.hasOwn(occupancy || {}, String(machine.id))) return null
  const entry = occupancy[String(machine.id)]
  if (!entry || typeof entry.userId !== 'string' || !entry.userId) return null
  const list = tasksByUser instanceof Map ? tasksByUser.get(entry.userId) : null
  if (!Array.isArray(list)) return null
  const task = list.find((item) => item && String(item.machineId) === String(machine.id)
    && (entry.taskId ? String(item.id) === String(entry.taskId)
      : Boolean(entry.startAt && item.startAt && entry.startAt === item.startAt)))
  if (!task || task.done || task.takenAt) return null
  // tasksByUser 的键来自占用 owner，旧任务若额外存 owner 字段也必须一致。
  if ((task.userId != null && task.userId !== entry.userId) || (task.ownerId != null && task.ownerId !== entry.userId)) return null
  const end = Date.parse(task.endAt || '')
  if (!Number.isFinite(end) || end <= now || end - now > MAX_REPORTED_MS) return null
  return { end, endAt: new Date(end).toISOString() }
}

/** tasksByUser: Map<occupancy.userId, Task[]>。返回纯投影，不公开用户或任务标识。 */
export function applyRegisteredAvailability(board, { occupancy = {}, tasksByUser = new Map(), now = Date.now() } = {}) {
  const projected = { ...board, floors: (board?.floors || []).map((floor) => ({ ...floor,
    machines: (floor.machines || []).map((original) => {
      const machine = clearOldProjection(original)
      if (machine.state !== 'idle' || (machine.upstreamState || machine.state) !== 'idle'
        || machine.health?.stale || machine.health?.confirmedFault || machine.health?.suspectedFault) return machine
      const active = activeRegistration(machine, occupancy, tasksByUser, now)
      if (!active) return machine
      return { ...machine, state: 'occupied', upstreamState: 'idle', finishAt: active.endAt,
        leftMin: Math.max(1, Math.ceil((active.end - now) / 60000)), estimated: true,
        availabilitySource: 'user_report', registrationPending: true,
        availabilityLabel: '用户已登记，等待设备状态更新' }
    }),
  })) }
  const machines = projected.floors.flatMap((floor) => floor.machines)
  projected.total = machines.length
  for (const state of ['idle', 'occupied', 'faulty', 'unknown']) {
    projected[state] = machines.filter((machine) => machine.state === state || state === 'occupied' && machine.state === 'abnormal').length
  }
  return projected
}
