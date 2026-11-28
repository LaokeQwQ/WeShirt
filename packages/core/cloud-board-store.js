import { mobileDigest } from './mobile-auth.js'

const MAX_BYTES = 48 * 1024
const TTL = 7 * 86400_000
const MAX_MACHINES = 500
const encoder = new TextEncoder()
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const safeText = value => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 100) : ''
const code = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[A-Za-z0-9_-]{1,128}$/.test(String(value)) ? String(value) : null
const dormCode = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)

/** Store placement only. Reading a replica cannot reconstruct stale timers,
 * account data or a claim that a machine is idle. */
function placementSnapshot(board, partition, at) {
  const updatedAt = iso(board?.updatedAt)
  const observation = Date.parse(updatedAt)
  if (!updatedAt || observation > at + 30000 || observation <= at - TTL
    || !Array.isArray(board.floors) || board.floors.length > 80
    || board.buildingId != null && String(board.buildingId) !== partition) return null
  const floors = [], seen = new Set()
  for (const row of board.floors) {
    const floorCode = code(row?.code)
    if (!floorCode || !Array.isArray(row.machines)) return null
    const machines = []
    for (const machine of row.machines) {
      const id = code(machine?.id)
      if (!id || seen.has(id) || seen.size >= MAX_MACHINES) return null
      seen.add(id)
      if (!dormCode(machine.dormBuilding)) continue
      const name = safeText(machine.name) || id
      machines.push({
        id, name, displayName: safeText(machine.displayName) || name,
        kind: machine.kind === 'dryer' ? 'dryer' : 'washer',
        floorCode: code(machine.floorCode) || floorCode, dormBuilding: machine.dormBuilding,
        ...(typeof machine.slot === 'string' && /^(?:D[1-9]|[1-9]\d?)$/i.test(machine.slot) ? { slot: machine.slot.toUpperCase() } : {}),
      })
    }
    if (machines.length) floors.push({ code: floorCode, name: safeText(row.name), machines })
  }
  if (!floors.length) return null
  const snapshot = { format: 1, partition, updatedAt, floors }
  return encoder.encode(JSON.stringify(snapshot)).byteLength <= MAX_BYTES ? snapshot : null
}

function renderDorm(snapshot, dorm) {
  const floors = snapshot.floors.map(floor => ({
    ...floor, machines: floor.machines.filter(machine => machine.dormBuilding === dorm).map(machine => ({
      ...machine, state: 'unknown', health: { stale: true, label: '状态待核对' },
    })),
  })).filter(floor => floor.machines.length)
  const total = floors.reduce((sum, floor) => sum + floor.machines.length, 0)
  return total ? { dormBuilding: dorm, updatedAt: snapshot.updatedAt, floors, total, unknown: total, idle: 0, occupied: 0, faulty: 0 } : null
}

/** Off until configured by the caller. The deployed private bridge already
 * allows this fixed machine-snapshot key under its historical limit namespace.
 * The adapter accepts a server-configured partition and only reads that key. */
export function createCloudBoardStore(atomicStore, { partition = 'b1', now = Date.now } = {}) {
  if (atomicStore?.consistency !== 'linearizable' || atomicStore.durable !== true ||
    typeof atomicStore.get !== 'function' || typeof atomicStore.compareAndSet !== 'function' || !code(partition)) return null
  partition = String(partition)
  const name = mobileDigest(partition).then(digest => 'mobile:limit:machine-snapshot:' + digest)
  const parse = row => plain(row?.value) && row.value.format === 1 && row.value.partition === partition ? placementSnapshot(row.value, partition, now()) : null
  return {
    async publish({ board } = {}) {
      const next = placementSnapshot(board, partition, now())
      if (!next) return { status: 'invalid' }
      const key = await name
      for (let attempt = 0; attempt < 4; attempt++) {
        const row = await atomicStore.get(key), current = parse(row)
        if (row && !current) throw new Error('invalid_cloud_board_snapshot')
        if (current && current.updatedAt >= next.updatedAt) return { status: 'already_current' }
        if (await atomicStore.compareAndSet(key, row?.version ?? null, next, { expiresAt: now() + TTL }))
          return { status: 'published' }
      }
      return { status: 'contended' }
    },
    async read({ dorm, maxAgeMs = 5 * 60000 } = {}) {
      if (!dormCode(dorm) || !Number.isFinite(maxAgeMs) || maxAgeMs < 1) return null
      const snapshot = parse(await atomicStore.get(await name))
      const age = snapshot ? now() - Date.parse(snapshot.updatedAt) : Infinity
      return age >= -30_000 && age < Math.min(maxAgeMs, 5 * 60000) ? renderDorm(snapshot, dorm) : null
    },
  }
}
