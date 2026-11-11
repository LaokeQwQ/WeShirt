import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'

const SECRET = 'inspection-jwt-integration-test-secret'
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8kQAAAAASUVORK5CYII='
const report = (machineId = 'washer-gui', status = 'normal') => ({ machineId, status, note: '现场检查记录，不修改机器状态', photoData: PHOTO })

async function fixture(t) {
  const store = createMemoryStore()
  const env = { AUTH_SECRET: SECRET, ADMIN_TOKEN: 'integration-bootstrap-token', BUILDING_ID: 'b1', HAIER_MODE: 'mock', HAIER_URL: 'https://upstream.example.test', HAIER_POSITION_ID: '90001', DINGTALK_APP_KEY: 'integration-app-key', DINGTALK_APP_SECRET: 'integration-app-secret', DINGTALK_ROBOT_CODE: 'integration-robot', ASSISTANT_API_KEY: 'integration-model-key' }
  const sent = [], unexpected = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(String(url))
    if (target.hostname === 'oapi.dingtalk.com' && target.pathname === '/gettoken') return new Response(JSON.stringify({ errcode: 0, access_token: 'integration-dingtalk-token' }))
    if (target.hostname === 'api.dingtalk.com' && target.pathname === '/v1.0/robot/groupMessages/send') {
      sent.push(JSON.parse(options.body))
      return new Response(JSON.stringify({ code: 'synthetic_channel_failure', message: 'test unavailable' }), { status: 503 })
    }
    unexpected.push({ hostname: target.hostname, pathname: target.pathname })
    throw new Error('Outbound request blocked by integration test')
  })
  t.after(() => assert.deepEqual(unexpected, [], 'only local DingTalk stubs may be called; no real network is used'))
  const tokens = {}
  for (const id of ['user', 'candidate', 'admin', 'super', 'operator', 'gui', 'liu', 'blocked']) {
    await store.put('user:' + id, { id, nick: '测试-' + id, dormBuilding: 'guiyuan', dingUserId: 'synthetic-ding-' + id, notifyOn: false, blocked: id === 'blocked' })
    tokens[id] = await issueToken(id, SECRET)
  }
  await store.put('meta:site', { buildings: [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }, { code: 'new_dorm', name: '新舍' }] })
  await store.put('meta:siteAdmins', [{ userId: 'super', role: 'super' }, { userId: 'admin', role: 'admin' }, { userId: 'operator', role: 'operator' }, { userId: 'gui', role: 'volunteer', buildings: ['guiyuan'] }, { userId: 'liu', role: 'volunteer', buildings: ['liuyuan'] }, { userId: 'blocked', role: 'super' }])
  await store.put('operations:config', { broadcast: { enabled: false } })
  await store.put('meta:sync', { lastAttemptAt: Date.now(), lastFetchAt: new Date().toISOString() })
  await store.put('mapping:b1', { mapping: { '1': 'washer-gui' } })
  await store.put('machines:b1', { board: { buildingId: 'b1', updatedAt: new Date().toISOString(), floors: [{ code: '1F', machines: [
    { id: 'washer-gui', name: '绑定洗衣机', dormBuilding: 'liuyuan', kind: 'washer', state: 'idle' },
    { id: 'dryer-liu', name: '柳园烘干机', dormBuilding: 'liuyuan', kind: 'dryer', state: 'idle' },
    { id: 'washer-new', name: '新舍洗衣机', dormBuilding: 'new_dorm', kind: 'washer', state: 'idle' },
  ] }] } })
  let app = createApp({ store, env: { ...env } })
  const call = async (path, { user, method = 'GET', body, token, bootstrap, raw } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (user || token) headers.authorization = 'Bearer ' + (token || tokens[user])
    if (bootstrap) headers['x-admin-token'] = env.ADMIN_TOKEN
    const response = await app.request(path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), ...(raw instanceof ReadableStream ? { duplex: 'half' } : {}) })
    return { status: response.status, data: await response.json(), headers: response.headers }
  }
  return { store, sent, call, reboot: () => { app = createApp({ store, env: { ...env } }) } }
}

test('createApp真实JWT拒普通和封停账号巡检，志愿者只能访问机器实际楼栋', async (t) => {
  const { call } = await fixture(t)
  assert.equal((await call('/api/user/identity')).status, 401)
  assert.equal((await call('/api/inspections', { token: 'forged-token' })).status, 401)
  assert.deepEqual((await call('/api/user/identity', { user: 'user' })).data.identity, { role: 'user', label: '', buildings: [] })
  for (const user of ['user', 'operator', 'blocked']) assert.equal((await call('/api/inspections', { user })).status, 403)
  assert.equal((await call('/api/admin/site', { user: 'blocked' })).status, 401)
  const own = await call('/api/inspections', { user: 'gui' })
  assert.equal(own.status, 200)
  assert.deepEqual(own.data.machines.map((m) => m.id), ['washer-gui'])
  assert.equal((await call('/api/inspections?dorm=liuyuan', { user: 'gui' })).status, 403)
  assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', body: { ...report('dryer-liu'), dorm: 'guiyuan' } })).status, 403)
  assert.equal((await call('/api/inspections', { user: 'user', method: 'POST', body: report() })).status, 403)
  const saved = await call('/api/inspections', { user: 'gui', method: 'POST', body: { ...report(), dorm: 'liuyuan' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.inspection.dormBuilding, 'guiyuan', 'trusted slot mapping wins over both client and upstream hints')
})

test('createApp管理员可管理志愿者但不能升级成员，角色变更立即影响现有JWT作用域', async (t) => {
  const { call, store } = await fixture(t)
  const added = await call('/api/admin/site', { user: 'admin', method: 'PATCH', body: { admin: { userId: 'candidate', role: 'volunteer', buildings: ['new_dorm'] } } })
  assert.equal(added.status, 200)
  assert.equal(added.data.permissions.manageVolunteers, true)
  assert.equal(added.data.permissions.manageAdmins, false)
  assert.deepEqual((await call('/api/inspections', { user: 'candidate' })).data.machines.map((m) => m.id), ['washer-new'])
  for (const body of [{ admin: { userId: 'candidate', role: 'super' } }, { admin: { userId: 'super', role: 'volunteer', buildings: ['new_dorm'] } }, { removeAdmin: 'operator' }, { credentials: { appSecret: 'forbidden-overwrite' } }]) assert.equal((await call('/api/admin/site', { user: 'admin', method: 'PATCH', body })).status, 403)
  assert.equal((await store.get('meta:siteAdmins')).find((entry) => entry.userId === 'super').role, 'super')
  assert.equal((await call('/api/admin/site', { user: 'operator', method: 'PATCH', body: { removeAdmin: 'candidate' } })).status, 403)
  assert.equal((await call('/api/admin/site', { user: 'admin', method: 'PATCH', body: { removeAdmin: 'candidate' } })).status, 200)
  assert.equal((await call('/api/inspections', { user: 'candidate' })).status, 403)
})

test('createApp账号总管可改AI最高配置，普通管理员只能读取且密钥不回显', async (t) => {
  const { call, store } = await fixture(t)
  const changed = await call('/api/admin/assistant', { user: 'super', method: 'PATCH', body: { enabled: false, model: 'integration-super-model', apiKey: 'integration-super-model-key' } })
  assert.equal(changed.status, 200, JSON.stringify(changed.data))
  assert.equal(changed.data.model, 'integration-super-model')
  assert.equal(changed.data.keyConfigured, true)
  assert.equal(JSON.stringify(changed.data).includes('integration-super-model-key'), false)
  assert.equal((await call('/api/admin/assistant', { user: 'admin', method: 'PATCH', body: { model: 'forbidden-admin-model' } })).status, 403)
  assert.equal((await call('/api/admin/assistant', { user: 'admin' })).status, 200)
  assert.equal((await call('/api/admin/assistant', { user: 'gui' })).status, 401)
  assert.equal((await call('/api/admin/assistant', { user: 'blocked', method: 'PATCH', body: { model: 'forbidden-blocked-model' } })).status, 403)
  assert.equal((await store.get('assistant:config')).model, 'integration-super-model')
})

test('createApp巡检异常只发指定楼群，失败与重建后冷却真实保留，照片须当前授权', async (t) => {
  const { call, store, sent, reboot } = await fixture(t)
  const conversationId = 'cid:integration/gui+1=='
  assert.equal((await call('/api/admin/building-groups', { user: 'gui' })).status, 403)
  for (const [buildingCode, cid] of [['guiyuan', conversationId], ['liuyuan', 'cid:integration/liu+2==']]) assert.equal((await call('/api/admin/building-groups', { user: 'admin', method: 'PATCH', body: { buildingCode, conversationId: cid } })).status, 200)
  const normal = await call('/api/inspections', { user: 'gui', method: 'POST', body: report() })
  assert.equal(normal.data.inspection.notification.status, 'not_required')
  assert.equal(sent.length, 0)
  const issue = await call('/api/inspections', { user: 'gui', method: 'POST', body: report('washer-gui', 'issue') })
  assert.equal(issue.status, 200)
  assert.equal(issue.data.inspection.notification.status, 'failed')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].openConversationId, conversationId)
  assert.equal(JSON.stringify(sent).includes('base64'), false)
  assert.equal(JSON.stringify(sent).includes(report().note), false, 'private inspection note is not sent into a group')
  assert.equal((await store.get('machines:b1')).board.floors[0].machines[0].state, 'idle', 'inspection does not turn a human report into a device fault')
  reboot()
  const retry = await call('/api/inspections', { user: 'gui', method: 'POST', body: report('washer-gui', 'issue') })
  assert.equal(retry.data.inspection.notification.status, 'cooldown')
  assert.equal(sent.length, 1)
  const path = '/api/inspections/' + issue.data.inspection.id + '/photo'
  assert.equal((await call(path)).status, 401)
  assert.equal((await call(path, { user: 'liu' })).status, 403)
  const photo = await call(path, { user: 'gui' })
  assert.equal(photo.data.photoData, PHOTO)
  assert.match(photo.headers.get('cache-control'), /no-store/)
  const history = await call('/api/inspections', { user: 'admin' })
  assert.equal(JSON.stringify(history.data).includes('base64'), false)
  assert.ok(history.data.inspections.some((entry) => entry.notification.status === 'failed'))
  await call('/api/admin/site', { user: 'admin', method: 'PATCH', body: { removeAdmin: 'gui' } })
  assert.equal((await call(path, { user: 'gui' })).status, 403)
})

test('createApp当前占用公开note与消毒液自清洁记录，取衣后清除', async (t) => {
  const { call } = await fixture(t)
  const note = '公开提醒：轻柔衣物，请勿混放'
  const saved = await call('/api/tasks', { user: 'user', method: 'POST', body: { machineId: 'washer-gui', minutes: 30, note, useDisinfectant: true, selfCleaned: true } })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  const occupancy = await call('/api/occupancy')
  assert.deepEqual(occupancy.data.occupancy['washer-gui'].care, { note, useDisinfectant: true, selfCleaned: true, source: 'user_report' })
  assert.equal((await call('/api/tasks/' + saved.data.task.id + '/take', { user: 'user', method: 'POST' })).status, 200)
  assert.equal((await call('/api/occupancy')).data.occupancy['washer-gui'], undefined)
})

test('createApp整轮巡检无图可提交，异常按指定楼群汇总Markdown且审计不含照片备注', async (t) => {
  const { call, store, sent } = await fixture(t)
  const snapshot = await store.get('machines:b1')
  snapshot.board.floors[0].machines.push({ id: 'washer-gui-extra', name: '本楼另一台', dormBuilding: 'guiyuan', kind: 'washer', state: 'idle' })
  await store.put('machines:b1', snapshot)
  await store.put('operations:buildingGroups', { guiyuan: 'cid:integration-round' })
  const normal = await call('/api/inspections', { user: 'gui', method: 'POST', body: { dormBuilding: 'guiyuan', issues: [] } })
  assert.equal(normal.status, 200)
  assert.equal(normal.data.inspection.inspectedMachineCount, 2)
  assert.equal(normal.data.inspection.hasPhoto, false)
  assert.equal(sent.length, 0)
  const issue = await call('/api/inspections', { user: 'gui', method: 'POST', body: { dormBuilding: 'guiyuan', note: '不公开的全轮备注', issues: [{ machineId: 'washer-gui', reasons: ['offline', 'power_off'], note: '不公开的设备备注' }, { machineId: 'washer-gui-extra', reasons: ['abnormal_occupation'] }] } })
  assert.equal(issue.status, 200)
  assert.equal(issue.data.inspection.issueCount, 2)
  assert.equal(issue.data.inspection.hasPhoto, false)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].openConversationId, 'cid:integration-round')
  const content = JSON.parse(sent[0].msgParam)
  assert.match(content.text, /2 台异常/)
  assert.match(content.text, /离线、断电/)
  assert.match(content.text, /本楼另一台：异常占用/)
  assert.equal(JSON.stringify(sent).includes('不公开'), false)
  const audit = await call('/api/admin/audit-logs?days=1&type=operation&limit=200', { user: 'super' })
  assert.equal(audit.status, 200)
  const eventId = issue.headers.get('x-event-id')
  assert.ok(audit.data.events.some(event => event.action === 'POST /api/inspections' && event.detail.eventId === eventId && event.detail.status === 200))
  assert.equal(JSON.stringify(audit.data).includes('不公开'), false)
})

test('createApp照片上传过程中撤销志愿身份，提交时重新校验并拒绝落库', async (t) => {
  const { call, store } = await fixture(t)
  let enter, release
  const entered = new Promise((resolve) => { enter = resolve })
  const released = new Promise((resolve) => { release = resolve })
  const bytes = new TextEncoder().encode(JSON.stringify(report()))
  const raw = new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 20)) },
    async pull(controller) { enter(); await released; controller.enqueue(bytes.subarray(20)); controller.close() },
  })
  const pending = call('/api/inspections', { user: 'gui', method: 'POST', raw })
  await entered
  try {
    assert.equal((await call('/api/admin/site', { user: 'admin', method: 'PATCH', body: { removeAdmin: 'gui' } })).status, 200)
  } finally { release() }
  assert.equal((await pending).status, 403)
  assert.equal(await store.get('inspections:b1', null), null)
  assert.deepEqual(await store.list('inspections:photo:'), [])
})
