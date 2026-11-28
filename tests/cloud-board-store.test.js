import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudBoardStore } from '../packages/core/cloud-board-store.js'
import { assertMobileAtomicKey } from '../packages/core/mobile-store.js'

const at = Date.parse('2026-11-28T00:00:00.000Z')
const stamp = ms => new Date(ms).toISOString()
const board = (updatedAt = at - 1000) => ({
  buildingId: 'b1', updatedAt: stamp(updatedAt), cycleEvidence: { private: true },
  floors: [{ code: '1', name: '一楼', machines: [
    { id: 'visible', slot: '1', name: '原名', displayName: '洗衣机', kind: 'washer', floorCode: '1', dormBuilding: 'one', state: 'idle', finishAt: stamp(at + 60000), userId: 'private-user', note: 'private-note' },
    { id: 'hidden', floorCode: '1', dormBuilding: 'two', state: 'occupied' },
  ] }],
})
function fixture() {
  const rows = new Map()
  let now = at
  const atomic = {
    consistency: 'linearizable', durable: true,
    async get(key) { return structuredClone(rows.get(key) || null) },
    async compareAndSet(key, version, value, { expiresAt }) {
      assertMobileAtomicKey(key)
      assert.equal(expiresAt, now + 7 * 86400_000)
      if ((rows.get(key)?.version ?? null) !== version) return false
      rows.set(key, { version: crypto.randomUUID(), value: structuredClone(value) })
      return true
    },
  }
  return { rows, atomic, store: createCloudBoardStore(atomic, { now: () => now }), advance: ms => { now += ms } }
}

test('cloud mirror is fixed-namespace, dorm isolated and carries placement only', async () => {
  const { store, rows, advance } = fixture()
  assert.equal((await store.publish({ board: board() })).status, 'published')
  const key = [...rows.keys()][0]
  assert.match(key, /^mobile:limit:machine-snapshot:[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(JSON.stringify([...rows.values()]), /private|finishAt|occupied|idle|cycleEvidence/)
  const mirror = await store.read({ dorm: 'one' })
  assert.equal(mirror.updatedAt, stamp(at - 1000))
  assert.equal(mirror.total, 1)
  assert.equal(mirror.floors[0].machines[0].slot, '1')
  assert.equal(mirror.floors[0].machines[0].state, 'unknown')
  assert.equal(mirror.floors[0].machines[0].health.stale, true)
  assert.doesNotMatch(JSON.stringify(mirror), /hidden|private|finishAt/)
  assert.equal(await store.read({ dorm: 'missing' }), null)
  advance(5 * 60000)
  assert.equal(await store.read({ dorm: 'one', maxAgeMs: 20 * 60000 }), null)
})

test('cloud mirror rejects old or mismatched snapshots and never repeats an uncertain write', async () => {
  const { store, atomic, rows } = fixture()
  assert.equal((await store.publish({ board: board() })).status, 'published')
  assert.equal((await store.publish({ board: board(at - 2000) })).status, 'already_current')
  assert.equal((await store.publish({ board: { ...board(), buildingId: 'other' } })).status, 'invalid')
  assert.equal((await store.publish({ board: board(at + 60000) })).status, 'invalid')
  assert.equal(await createCloudBoardStore(atomic, { partition: 'other', now: () => at }).read({ dorm: 'one' }), null)
  let calls = 0
  atomic.compareAndSet = async () => { calls++; throw new Error('uncertain') }
  await assert.rejects(store.publish({ board: board(at) }), /uncertain/)
  assert.equal(calls, 1)
  assert.equal([...rows.values()][0].value.updatedAt, stamp(at - 1000))
})
