import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../packages/core/store.js'
import { runOperations } from '../packages/core/operations.js'
import { resolveBroadcastTargets, buildHourlyGroupNotice } from '../packages/core/group-broadcast.js'
import { createDingTalk } from '../packages/core/dingtalk.js'

const AT = Date.parse('2026-11-10T00:00:00Z')
const catalog = [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }]
const board = (at, g = 'idle', l = 'idle') => ({ buildingId: 'b1', updatedAt: new Date(at).toISOString(), floors: [{ code: '1', machines: [
  { id: 'g1', name: '桂园1号机', dormBuilding: 'guiyuan', state: g },
  { id: 'l1', name: '柳园1号机', dormBuilding: 'liuyuan', state: l },
  { id: 'unclassified', name: '未归类机器', state: 'idle' },
] }] })

test('legacy webhook is scoped to Guiyuan; ambiguous observed groups are not subscriptions', async () => {
  const store = createMemoryStore()
  await store.put('ding:groupConv', { conversationId: 'cid:other', title: '临时讨论群' })
  assert.deepEqual(await resolveBroadcastTargets(store), [])
  await store.put('ding:groupConv', { conversationId: 'cid:g', title: '桂园洗衣房群' })
  assert.equal((await resolveBroadcastTargets(store))[0].dormBuilding, 'guiyuan')
  const targets = await resolveBroadcastTargets(store, { DINGTALK_WEBHOOK: 'private-placeholder', SITE_BUILDINGS: catalog })
  assert.deepEqual(targets.map(t => [t.dormBuilding, t.via]), [['guiyuan', 'webhook']])
  await store.put('operations:buildingGroups', { guiyuan: 'cid:explicit', liuyuan: 'cid:l' })
  assert.deepEqual((await resolveBroadcastTargets(store, { DINGTALK_WEBHOOK: 'placeholder' })).map(t => [t.key, t.via]), [['guiyuan', 'group'], ['liuyuan', 'group']])
  await store.put('meta:site', { buildings: catalog.map(b => ({ ...b, enabled: b.code !== 'guiyuan' })) })
  assert.deepEqual((await resolveBroadcastTargets(store)).map(t => t.key), ['liuyuan'])
})

test('each group receives only its own machines and only changes in that building trigger a later hour', async () => {
  const store = createMemoryStore(), sent = []
  await store.put('operations:buildingGroups', { guiyuan: 'cid:g', liuyuan: 'cid:l' })
  const env = { SITE_BUILDINGS: catalog }
  const args = { store, env, broadcastTargets: () => resolveBroadcastTargets(store, env), broadcast: async payload => { sent.push(payload); return { ok: true } } }
  await runOperations({ ...args, board: board(AT), now: AT })
  assert.deepEqual(sent.map(p => p.board.floors.flatMap(f => f.machines.map(m => m.id))), [['g1'], ['l1']])
  assert.deepEqual(sent.map(p => p.board.total), [1, 1])
  const next = AT + 3600000
  await runOperations({ ...args, board: board(next, 'idle', 'occupied'), now: next })
  assert.equal(sent.length, 3)
  assert.equal(sent[2].target.dormBuilding, 'liuyuan')
  await runOperations({ ...args, board: board(next + 60000, 'occupied', 'occupied'), now: next + 60000 })
  assert.equal(sent.length, 3, 'a checked hour does not send twice')
})

test('failed destination retries independently; successful group never receives duplicate on another group failure', async () => {
  const store = createMemoryStore(), sent = []
  await store.put('operations:buildingGroups', { guiyuan: 'cid:g', liuyuan: 'cid:l' })
  const args = { store, broadcastTargets: () => resolveBroadcastTargets(store), broadcast: async ({ target }) => { sent.push(target.key); return { ok: target.key === 'guiyuan' || sent.length > 2 } } }
  await runOperations({ ...args, board: board(AT), now: AT })
  await runOperations({ ...args, board: board(AT + 60000), now: AT + 60000 })
  assert.deepEqual(sent, ['guiyuan', 'liuyuan', 'liuyuan'])
})

test('hourly Markdown has a title and separate idle/running lists, escapes source text, avoids guessed finish time', () => {
  const source = board(AT, 'occupied')
  source.floors[0].machines = [{ ...source.floors[0].machines[0], name: '[假的链接](https://invalid.test)' }]
  const notice = buildHourlyGroupNotice(source, { name: '桂园', hourKey: '2026-11-10T08', now: AT })
  assert.match(notice.markdown, /^### 🧺 桂园/)
  assert.match(notice.markdown, /08:00 · 空闲 0 台 · 使用中 1 台/)
  assert.match(notice.markdown, /\*\*✅ 空闲机器\*\*[\s\S]*\*\*⏳ 使用中\*\*/)
  assert.ok(notice.markdown.includes('\\[假的链接\\]'))
  assert.match(notice.markdown, /结束时间待更新/)
  assert.doesNotMatch(notice.markdown, /仅统计/)
})

test('internal group API sends sampleMarkdown for a rich notice and keeps text compatibility', async () => {
  const oldFetch = globalThis.fetch, payloads = []
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('gettoken')) return Response.json({ errcode: 0, access_token: 'local-token', expires_in: 7200 })
    if (String(url).includes('accessToken')) return Response.json({ accessToken: 'local-token', expireIn: 7200 })
    payloads.push(JSON.parse(opts.body)); return Response.json({ processQueryKey: 'local-only' })
  }
  try {
    const dt = createDingTalk({ DINGTALK_APP_KEY: 'local-key', DINGTALK_APP_SECRET: 'local-secret' })
    assert.equal((await dt.sendGroup('cid:g', { title: '桂园', markdown: '### 空闲', text: '空闲' })).ok, true)
    assert.equal((await dt.sendGroup('cid:g', '普通消息')).ok, true)
    assert.equal(payloads[0].msgKey, 'sampleMarkdown')
    assert.deepEqual(JSON.parse(payloads[0].msgParam), { title: '桂园', text: '### 空闲' })
    assert.equal(payloads[1].msgKey, 'sampleText')
    assert.equal(JSON.parse(payloads[1].msgParam).content, '普通消息')
  } finally { globalThis.fetch = oldFetch }
})
