const label = (value) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim()).slice(0, 120).join('') : ''

/** Binding names describe the physical machine; upstream names remain searchable. */
export function machineLabels(machine, mapping = {}) {
  const id = String(machine?.id ?? '')
  const slots = Object.entries(mapping).filter(([, value]) => value != null && String(value) === id).map(([slot]) => String(slot))
  const slot = slots.length === 1 && /^(?:D[12]|[1-7])$/i.test(slots[0]) ? slots[0].toUpperCase() : ''
  const originalName = label(machine?.originalName) || label(machine?.name) || id
  const remarkName = label(machine?.remarkName) || label(machine?.remark)
  const displayName = slot ? `${slot.replace(/^D/, '')}号${slot.startsWith('D') ? '烘干机' : '洗衣机'}` : remarkName || originalName
  return { slot: slot || null, displayName, originalName, remarkName }
}

/** The bound room slots are all on its first floor, even when upstream metadata is wrong. */
export function projectMachinePlacement(board, mapping = board?.slotMapping || {}) {
  if (!board) return board
  const floors = board.floors || []
  const firstFloor = floors.find(floor => /^(?:1|1F|F1)$/i.test(String(floor.code)))
  const floorCode = firstFloor?.code ?? '1'
  const next = new Map()
  for (const floor of floors) {
    for (const machine of floor.machines || []) {
      const {slot} = machineLabels(machine, mapping)
      const code = slot ? floorCode : floor.code
      if (!next.has(String(code))) next.set(String(code), { ...(slot ? firstFloor || { code } : floor), machines: [] })
      next.get(String(code)).machines.push(slot ? { ...machine, floorCode,
        floorName: firstFloor?.name || firstFloor?.floorName || '1楼',
        originalFloorCode: machine.originalFloorCode ?? machine.floorCode ?? floor.code,
      } : { ...machine })
    }
  }
  return { ...board, slotMapping: mapping, floors: [...next.values()] }
}
