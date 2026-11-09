import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createMemoryStore } from '../packages/core/store.js'
import { registerInspectionRoutes, validateInspectionPhoto } from '../server/inspections.js'

const AT = Date.parse('2026-11-10T00:00:00Z')
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8kQAAAAASUVORK5CYII='
const report = (machineId = 'm-gui', status = 'normal') => ({ machineId, status, note: '现场已检查，桶内无遗留物。', photoData: PHOTO })

async function fixture({ notifyBuilding, notificationTimeoutMs } = {}) {
  const store = createMemoryStore()
  let clock = AT
  let delivery = true
  let app
  const sent = []
  const board = { floors: [{ code: '1', machines: [
    { id: 'm-gui', name: '人工绑定设备', dormBuilding: 'liuyuan', state: 'idle', kind: 'washer' },
    { id: 'm-liu', name: '柳园烘干机', dormBuilding: 'liuyuan', state: 'occupied', kind: 'dryer' },
    { id: 'm-custom', name: '新舍机器', dormBuilding: 'new_dorm', state: 'idle', kind: 'washer' },
    { id: 'm-unknown', name: '归属未知', state: 'unknown', kind: 'washer' },
  ] }] }
  await store.put('meta:site', { buildings: [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }, { code: 'new_dorm', name: '新舍' }] })
  await store.put('mapping:b1', { mapping: { '1': 'm-gui' } })
  for (const id of ['admin', 'super', 'gui', 'liu', 'operator', 'user', 'custom']) await store.put('user:' + id, { id, nick: '同学-' + id })
  await store.put('meta:siteAdmins', [{ userId: 'admin', role: 'admin' }, { userId: 'super', role: 'super' }, { userId: 'gui', role: 'volunteer', buildings: ['guiyuan'] }, { userId: 'liu', role: 'volunteer', buildings: ['liuyuan'] }, { userId: 'custom', role: 'volunteer', buildings: ['new_dorm'] }, { userId: 'operator', role: 'operator' }])
  const reboot = () => {
    app = new Hono()
    registerInspectionRoutes(app, { store, authenticate: (c) => store.get('user:' + c.req.header('x-user'), null), checkSuperAdmin: (c) => c.req.header('x-bootstrap') === 'yes', getBoard: () => structuredClone(board), now: () => clock, notificationTimeoutMs, notifyBuilding: async (value) => { sent.push(value); return notifyBuilding ? notifyBuilding(value) : { ok: delivery } } })
  }
  reboot()
  const call = async (path, { user, bootstrap, method = 'GET', body, raw, headers: extra } = {}) => {
    const headers = { 'content-type': 'application/json', ...extra }
    if (user) headers['x-user'] = user
    if (bootstrap) headers['x-bootstrap'] = 'yes'
    const response = await app.request(path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) })
    return { status: response.status, data: await response.json(), headers: response.headers }
  }
  return { store, call, board, sent, reboot, fail: () => { delivery = false }, advance: (ms) => { clock += ms } }
}

test('巡检按机器真实楼栋授权，伪造dorm无效；正常记录不群发且不改机器状态', async () => {
  const { call, sent, board } = await fixture()
  const before = structuredClone(board)
  assert.equal((await call('/api/inspections')).status, 401)
  assert.equal((await call('/api/inspections', { user: 'operator' })).status, 403)
  assert.equal((await call('/api/inspections', { user: 'user', method: 'POST', body: report() })).status, 403)
  assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', body: { ...report('m-liu'), dorm: 'guiyuan' } })).status, 403)
  assert.equal((await call('/api/inspections', { user: 'admin', method: 'POST', body: report('m-unknown') })).status, 409)
  const saved = await call('/api/inspections', { user: 'gui', method: 'POST', body: { ...report(), dorm: 'liuyuan' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.inspection.dormBuilding, 'guiyuan', 'verified mapping takes precedence over the machine hint and client dorm')
  assert.equal(saved.data.inspection.notification.status, 'not_required')
  assert.equal(sent.length, 0)
  assert.deepEqual(board, before)
  assert.equal((await call('/api/inspections', { user: 'custom', method: 'POST', body: report('m-custom') })).status, 200)
  const history = await call('/api/inspections', { user: 'gui' })
  assert.deepEqual(history.data.buildings.map((b) => b.code), ['guiyuan'])
  assert.deepEqual(history.data.machines.map((m) => m.id), ['m-gui'])
  assert.equal(history.data.inspections.length, 1)
  assert.equal((await call('/api/inspections?dorm=liuyuan', { user: 'gui' })).status, 403)
  assert.equal((await call('/api/user/identity', { user: 'gui' })).data.identity.label, '志愿管理')
  assert.equal((await call('/api/user/identity', { bootstrap: true })).data.identity.role, 'super')
})

test('照片不混入历史响应，专用接口只对当前授权楼栋开放并禁止缓存', async () => {
  const { call, store } = await fixture()
  const created = await call('/api/inspections', { user: 'gui', method: 'POST', body: report() })
  const url = '/api/inspections/' + created.data.inspection.id + '/photo'
  const history = await call('/api/inspections', { user: 'admin' })
  assert.equal(JSON.stringify(history.data).includes('base64'), false)
  assert.equal(history.headers.get('cache-control'), 'no-store')
  assert.equal((await call(url)).status, 401)
  assert.equal((await call(url, { user: 'liu' })).status, 403)
  assert.equal((await call(url, { user: 'user' })).status, 403)
  const image = await call(url, { user: 'gui' })
  assert.equal(image.status, 200)
  assert.equal(image.data.photoData, PHOTO)
  assert.equal(image.headers.get('cache-control'), 'private, no-store')
  const roles = await store.get('meta:siteAdmins')
  await store.put('meta:siteAdmins', roles.filter((entry) => entry.userId !== 'gui'))
  assert.equal((await call(url, { user: 'gui' })).status, 403, 'revocation also blocks old report photos')
})

test('照片验证拒绝SVG、MIME伪造、超500KB与无备注；请求体流式上限700KB', async () => {
  const { call, store } = await fixture()
  assert.equal(validateInspectionPhoto(PHOTO), PHOTO)
  const forged = 'data:image/jpeg;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
  const oversized = Buffer.alloc(500 * 1024 + 1)
  oversized.set([137, 80, 78, 71, 13, 10, 26, 10])
  for (const body of [{ ...report(), note: '' }, { ...report(), note: 'x'.repeat(501) }, { ...report(), photoData: undefined }, { ...report(), photoData: 'data:image/svg+xml;base64,PHN2Zy8+' }, { ...report(), photoData: PHOTO.replace('image/png', 'image/jpeg') }, { ...report(), photoData: forged }, { ...report(), photoData: 'data:image/png;base64,' + oversized.toString('base64') }]) {
    assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', body })).status, 400)
  }
  assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', raw: ' '.repeat(700 * 1024 + 1), headers: { 'content-length': '1' } })).status, 413)
  assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', body: report(), headers: { 'content-length': String(700 * 1024 + 1) } })).status, 413)
  assert.equal(await store.get('inspections:b1', null), null)
})

test('楼群只收受控会话ID；异常按实际楼发送，持久10分钟去重且失败不记送达', async () => {
  const { call, sent, reboot, advance, fail, store } = await fixture()
  const group = { buildingCode: 'guiyuan', conversationId: 'cid:AbC/xy+Z==' }
  assert.equal((await call('/api/admin/building-groups', { user: 'gui', method: 'PATCH', body: group })).status, 403)
  for (const conversationId of ['https://evil.example/hook', '//evil.example', 'cid\nunsafe', 'x'.repeat(257)]) assert.equal((await call('/api/admin/building-groups', { user: 'admin', method: 'PATCH', body: { ...group, conversationId } })).status, 400)
  assert.equal((await call('/api/admin/building-groups', { user: 'admin', method: 'PATCH', body: group })).status, 200)
  let response = await call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') })
  assert.equal(response.data.inspection.notification.status, 'sent')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].buildingCode, 'guiyuan')
  assert.equal(sent[0].conversationId, group.conversationId)
  assert.equal(JSON.stringify(sent[0]).includes('base64'), false)
  reboot()
  const simultaneous = await Promise.all([call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') }), call('/api/inspections', { user: 'admin', method: 'POST', body: report('m-gui', 'issue') })])
  assert.equal(simultaneous.every((item) => item.data.inspection.notification.status === 'cooldown'), true)
  assert.equal(sent.length, 1)
  advance(10 * 60000)
  fail()
  response = await call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') })
  assert.equal(response.data.inspection.notification.status, 'failed')
  assert.equal((await store.get('inspections:b1')).at(-1).notification.status, 'failed')
  assert.equal(sent.length, 2)
  assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') })).data.inspection.notification.status, 'cooldown')
  assert.equal((await call('/api/admin/building-groups', { user: 'super' })).data.groups[0].conversationId, group.conversationId)
  assert.equal((await call('/api/admin/building-groups', { user: 'admin', method: 'PATCH', body: { ...group, conversationId: '' } })).data.groups.length, 0)
})

test('历史保留30天且最多200条；每请求清理最多50张并持久处理剩余照片', async () => {
  const { store, call } = await fixture()
  const rows = Array.from({ length: 260 }, (_, i) => ({ id: 'old_' + i, machineId: 'm-gui', machineName: '设备', dormBuilding: 'guiyuan', status: 'normal', note: '巡检', at: new Date(i < 60 ? AT - 31 * 86400000 : AT).toISOString(), inspector: { userId: 'gui', nick: '同学' }, notification: { status: 'not_required' } }))
  await store.put('inspections:b1', rows)
  for (const row of rows) await store.put('inspections:photo:' + row.id, PHOTO)
  const originalDel = store.del
  let deleted = 0
  store.del = async (key) => { deleted++; return originalDel(key) }
  const first = await call('/api/inspections', { user: 'gui' })
  assert.equal(first.data.inspections.length, 200)
  assert.equal(deleted, 50)
  assert.equal((await store.get('inspections:cleanup:b1')).length, 10)
  assert.equal((await call('/api/inspections/old_59/photo', { user: 'gui' })).status, 404)
  assert.equal(deleted, 60)
  assert.equal((await store.get('inspections:cleanup:b1')).length, 0)
  const created = await call('/api/inspections', { user: 'gui', method: 'POST', body: report() })
  assert.equal(created.status, 200)
  assert.equal((await store.get('inspections:b1')).length, 200)
  assert.equal((await store.get('inspections:cleanup:b1')).length, 1)
  await call('/api/inspections', { user: 'admin' })
  assert.equal(deleted, 61)
  assert.equal(await store.get('inspections:photo:old_60', null), null)
})

test('慢群通道不持历史锁；历史和照片可读，并发新增不会被通知结果覆盖', async () => {
  let enter, release
  const entered = new Promise((resolve) => { enter = resolve })
  const delivery = new Promise((resolve) => { release = resolve })
  const { call, store, sent } = await fixture({ notifyBuilding: async () => { enter(); return delivery } })
  await store.put('operations:buildingGroups', { guiyuan: 'cid:local-test' })
  const pending = call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') })
  await entered
  let timeout
  try {
    const history = await Promise.race([call('/api/inspections', { user: 'gui' }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('history blocked by external delivery')), 250) })])
    clearTimeout(timeout)
    assert.equal(history.data.inspections[0].notification.status, 'sending')
    assert.equal((await call('/api/inspections/' + history.data.inspections[0].id + '/photo', { user: 'gui' })).status, 200)
    assert.equal((await call('/api/inspections', { user: 'admin', method: 'POST', body: report('m-liu') })).status, 200)
    assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') })).data.inspection.notification.status, 'cooldown')
    assert.equal(sent.length, 1)
  } finally { clearTimeout(timeout); release({ ok: true }) }
  assert.equal((await pending).data.inspection.notification.status, 'sent')
  const rows = await store.get('inspections:b1')
  assert.equal(rows.length, 3)
  assert.ok(rows.some((entry) => entry.machineId === 'm-liu'))
  assert.deepEqual(rows.map((entry) => entry.notification.status).sort(), ['cooldown', 'not_required', 'sent'])
})

test('群通知确认有总时限；超时仅记录未确认，不假报成功，持久冷却仍生效', async () => {
  const { store, call, sent } = await fixture({ notificationTimeoutMs: 10, notifyBuilding: () => new Promise(() => {}) })
  await store.put('operations:buildingGroups', { guiyuan: 'cid:local-timeout' })
  const result = await call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') })
  assert.equal(result.data.inspection.notification.status, 'failed')
  assert.equal(result.data.inspection.notification.reason, 'timeout')
  assert.equal(sent[0].signal.aborted, true)
  assert.equal((await store.get('inspections:b1'))[0].notification.reason, 'timeout')
  assert.equal((await call('/api/inspections', { user: 'gui', method: 'POST', body: report('m-gui', 'issue') })).data.inspection.notification.status, 'cooldown')
  assert.equal(sent.length, 1)
})

test('合法静态JPEG/PNG/WebP/GIF保持兼容，只有签名的坏图和超大解码尺寸被拒', () => {
  const formats = {
    jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
    webp: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/vz0AAA=',
    gif: 'R0lGODdhAgACAIEAAP///wAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7',
  }
  for (const [type, bytes] of Object.entries(formats)) {
    const url = 'data:image/' + type + ';base64,' + bytes
    assert.equal(validateInspectionPhoto(url), url)
  }
  assert.equal(validateInspectionPhoto(PHOTO), PHOTO)
  assert.throws(() => validateInspectionPhoto('data:image/png;base64,iVBORw0KGgo='), /结构/)
  const bomb = Buffer.from(PHOTO.split(',')[1], 'base64')
  bomb.writeUInt32BE(4000, 16); bomb.writeUInt32BE(4000, 20)
  assert.throws(() => validateInspectionPhoto('data:image/png;base64,' + bomb.toString('base64')), /像素/)
  const jpeg = Buffer.from(formats.jpeg, 'base64')
  const frame = jpeg.indexOf(Buffer.from([255, 192]))
  jpeg.writeUInt16BE(9000, frame + 5)
  assert.throws(() => validateInspectionPhoto('data:image/jpeg;base64,' + jpeg.toString('base64')), /像素/)
  assert.throws(() => validateInspectionPhoto('data:image/webp;base64,' + Buffer.from(formats.webp, 'base64').subarray(0, 20).toString('base64')), /结构/)
})
