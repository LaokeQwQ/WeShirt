import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../packages/core/store.js'
import { runOperations } from '../packages/core/operations.js'
import { resolveBroadcastTargets } from '../packages/core/group-broadcast.js'

const AT = Date.parse('2026-11-10T00:00:00Z')
const catalog = [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }]
const board = at => ({ buildingId: 'b1', updatedAt: new Date(at).toISOString(), floors: [{ code: '1', machines: [{ id: 'g1', name: '桂园1号机', state: 'idle', dormBuilding: 'guiyuan' }, { id: 'l1', name: '柳园1号机', state: 'idle', dormBuilding: 'liuyuan' }] }] })
async function fixture() {
  const store = createMemoryStore(), env = { SITE_BUILDINGS: catalog }
  await store.put('operations:buildingGroups', { guiyuan: 'cid:g', liuyuan: 'cid:l' })
  return { store, env, broadcastTargets: () => resolveBroadcastTargets(store, env) }
}

test('turning off broadcasts or excluding this hour during a prior building send stops later destinations', async () => {
  for (const broadcast of [{ enabled: false }, { enabled: true, hours: [9] }]) {
    const args = await fixture(), sent = []
    const result = await runOperations({ ...args, board: board(AT), now: AT, broadcast: async ({ target }) => { sent.push(target.key); await args.store.put('operations:config', { broadcast }); return { ok: true } } })
    assert.deepEqual(sent, ['guiyuan'])
    assert.equal(result.broadcast.deliveries[1].reason, 'configuration_changed')
    assert.notEqual((await args.store.get('operations:broadcast:b1:liuyuan')).success, true)
  }
})

test('mid-flight group replacement or disabled building never sends to a stale destination', async () => {
  for (const change of [async store => store.put('operations:buildingGroups', { guiyuan: 'cid:g', liuyuan: 'cid:new' }), async store => store.put('meta:site', { buildings: catalog.map(b => ({ ...b, enabled: b.code === 'guiyuan' })) })]) {
    const args = await fixture(), sent = []
    await runOperations({ ...args, board: board(AT), now: AT, broadcast: async ({ target }) => { sent.push(target.conversationId); await change(args.store); return { ok: true } } })
    assert.deepEqual(sent, ['cid:g'])
  }
})

test('a failed building waits one minute, retries alone, and concurrent runs do not duplicate a successful delivery', async () => {
  const args = await fixture(), sent = []
  let liuAttempts = 0
  const send = async ({ target, board }) => { sent.push(target.key); assert.deepEqual(board.floors.flatMap(f => f.machines.map(m => m.dormBuilding)), [target.key]); return { ok: target.key !== 'liuyuan' || ++liuAttempts > 1 } }
  const run = now => runOperations({ ...args, board: board(now), now, broadcast: send })
  await Promise.all([run(AT), run(AT)])
  assert.deepEqual(sent, ['guiyuan', 'liuyuan'])
  await run(AT + 59000)
  assert.deepEqual(sent, ['guiyuan', 'liuyuan'])
  await Promise.all([run(AT + 60000), run(AT + 60000)])
  assert.deepEqual(sent, ['guiyuan', 'liuyuan', 'liuyuan'])
})
