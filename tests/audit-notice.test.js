// 操作日志审计 + 登记方式 + 通知文案
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { logEvent, listEvents, pruneEvents, bjDate, maskSensitive, AUDIT_TYPES } from '../packages/core/auditlog.js'
import { buildTakeNotice, buildStuckNotice, buildUrgeNotice, hhmm } from '../packages/core/notice.js'

const SECRET = 's'.repeat(32)
const DEVICE = 'a'.repeat(32)

async function makeApp(seed) {
  const store = createMemoryStore()
  const app = createApp({ store, env: { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: SECRET } })
  const call = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers }
    if (body) h['content-type'] = 'application/json'
    const r = await app.fetch(
      new Request('http://x' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })
    )
    const text = await r.text()
    let j = null
    try {
      j = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, j, text }
  }
  if (seed) await seed(store)
  return { store, call, A: { 'x-admin-token': 'test-admin-token' } }
}

async function seedUser(store, { id = 'u_1', nick = '测试用户' } = {}) {
  await store.put(`user:${id}`, { id, nick, avatar: 'av1', takeCode: '000000', dingUserId: 'staff_1' })
  await store.put(`userByDing:staff_1`, id)
  return { id, nick }
}

// ---------- 基础写读 ----------

test('logEvent 写入后能读出来，字段完整', async () => {
  const store = createMemoryStore()
  await logEvent(store, { type: 'task', action: '登记洗衣', actorId: 'u_1', actorNick: '某人', target: '1号机' })
  const r = await listEvents(store, { days: 1 })
  assert.equal(r.total, 1)
  const e = r.events[0]
  assert.equal(e.type, 'task')
  assert.equal(e.action, '登记洗衣')
  assert.equal(e.actorId, 'u_1')
  assert.equal(e.level, 'info')
  assert.match(e.id, /^l_[0-9a-f]{12}$/)
})

test('未知 type 归到 error，非法 level 归到 info（不丢日志）', async () => {
  const store = createMemoryStore()
  await logEvent(store, { type: 'nonsense', action: 'x', level: 'fatal' })
  const r = await listEvents(store, { days: 1 })
  assert.equal(r.events[0].type, 'error')
  assert.equal(r.events[0].level, 'info')
})

test('按类型 / 级别 / 账号 / 关键字过滤', async () => {
  const store = createMemoryStore()
  await logEvent(store, { type: 'task', action: '登记洗衣', actorId: 'u_1', target: '桂园1楼7号机' })
  await logEvent(store, { type: 'auth', action: '钉钉登录', actorId: 'u_2' })
  await logEvent(store, { type: 'sync', action: '上游同步失败', level: 'error', detail: { error: 'HTTP 405' } })

  assert.equal((await listEvents(store, { type: 'task' })).total, 1)
  assert.equal((await listEvents(store, { level: 'error' })).total, 1)
  assert.equal((await listEvents(store, { actorId: 'u_2' })).total, 1)
  assert.equal((await listEvents(store, { keyword: '桂园' })).total, 1)
  assert.equal((await listEvents(store, { keyword: '405' })).total, 1)
})

test('新的在前（按时间倒序）', async () => {
  const store = createMemoryStore()
  await logEvent(store, { type: 'task', action: '第一条' })
  await new Promise((r) => setTimeout(r, 5))
  await logEvent(store, { type: 'task', action: '第二条' })
  const r = await listEvents(store, { days: 1 })
  assert.equal(r.events[0].action, '第二条')
})

// ---------- 脱敏与防泄漏 ----------

test('手机号 / 邮箱被脱敏', () => {
  assert.equal(maskSensitive('手机 13812345678'), '手机 138****5678')
  assert.equal(maskSensitive('a.b@example.com'), 'a***@example.com')
  assert.equal(maskSensitive(null), null)
})

test('detail 不会把照片 data URL 写进日志', async () => {
  const store = createMemoryStore()
  await logEvent(store, {
    type: 'urge',
    action: '查看手机号',
    detail: { photo: 'data:image/jpeg;base64,AAAA', mobile: '13812345678', ok: true },
  })
  const e = (await listEvents(store, { days: 1 })).events[0]
  assert.equal(e.detail.photo, undefined, 'data URL 必须丢掉')
  assert.equal(e.detail.mobile, '138****5678')
  assert.equal(e.detail.ok, true)
  assert.ok(!JSON.stringify(e).includes('base64'))
})

test('detail 里的大对象不会被整个塞进来', async () => {
  const store = createMemoryStore()
  await logEvent(store, {
    type: 'sync',
    action: 'x',
    detail: { board: { floors: [{ machines: new Array(100).fill({ id: 'x' }) }] } },
  })
  const e = (await listEvents(store, { days: 1 })).events[0]
  // 对象类型整体丢弃；只剩这一个字段时 detail 会是 undefined
  assert.equal(e.detail, undefined, '对象类型不记录')
  assert.ok(JSON.stringify(e).length < 600)
  assert.ok(!JSON.stringify(e).includes('floors'))
})

test('detail 里混着标量时只留标量', async () => {
  const store = createMemoryStore()
  await logEvent(store, {
    type: 'sync',
    action: 'x',
    detail: { board: { big: true }, fails: 3, ok: false },
  })
  const e = (await listEvents(store, { days: 1 })).events[0]
  assert.deepEqual(e.detail, { fails: 3, ok: false })
})

// ---------- 容量与清理 ----------

test('每天最多 500 条，超出丢弃最老的', async () => {
  const store = createMemoryStore()
  const key = `auditlog:${bjDate()}`
  const arr = new Array(500).fill(0).map((_, i) => ({ id: 'l_' + i, at: new Date().toISOString(), type: 'task', level: 'info', action: 'a' }))
  await store.put(key, arr)
  await logEvent(store, { type: 'task', action: '最新一条' })
  const saved = await store.get(key, [])
  assert.equal(saved.length, 500)
  assert.equal(saved[saved.length - 1].action, '最新一条')
  assert.ok(!saved.some((x) => x.id === 'l_0'), '最老的应被挤掉')
})

test('pruneEvents 只删超期的桶', async () => {
  const store = createMemoryStore()
  await store.put(`auditlog:${bjDate()}`, [{ id: 'l_now', at: new Date().toISOString(), type: 'task', level: 'info' }])
  await store.put('auditlog:2020-01-01', [{ id: 'l_old', at: '2020-01-01T00:00:00Z', type: 'task', level: 'info' }])
  const r = await pruneEvents(store, { keepDays: 30 })
  assert.equal(r.removed, 1)
  assert.equal(await store.get('auditlog:2020-01-01', null), null)
  assert.ok(await store.get(`auditlog:${bjDate()}`, null))
})

// ---------- 接口 ----------

test('/api/admin/audit-logs 需要口令，返回类型字典', async () => {
  const { call, A } = await makeApp()
  assert.equal((await call('GET', '/api/admin/audit-logs')).status, 401)
  const r = await call('GET', '/api/admin/audit-logs', { headers: A })
  assert.equal(r.status, 200)
  assert.equal(r.j.types.task, '登记洗衣')
  assert.ok(Array.isArray(r.j.events))
})

test('登记洗衣会写一条任务审计', async () => {
  const { store, call } = await makeApp(async (s) => {
    await seedUser(s)
    await s.put(`userByDevice:${DEVICE}`, 'u_1')
    await s.put('machines:b1', {
      board: {
        floors: [
          {
            code: '1',
            machines: [
              { id: 'm1', name: '桂园1楼1号机', floorCode: '1', state: 'occupied', finishAt: new Date(Date.now() + 12 * 60000).toISOString(), leftMin: 12 },
            ],
          },
        ],
      },
    })
  })
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/tasks', {
    body: { machineId: 'm1', mode: 'machine' },
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 200)
  const logs = await listEvents(store, { type: 'task' })
  assert.equal(logs.total, 1)
  assert.equal(logs.events[0].detail.mode, 'machine')
  assert.equal(logs.events[0].actorId, 'u_1')
})

// ---------- 登记方式 ----------

test('mode=machine：按机器自己的 finishAt 提醒，不信前端传的分钟', async () => {
  const finishAt = new Date(Date.now() + 12 * 60000 + 2000).toISOString()
  const { store, call } = await makeApp(async (s) => {
    await seedUser(s)
    await s.put('machines:b1', {
      board: { floors: [{ code: '1', machines: [{ id: 'm1', name: '1号机', floorCode: '1', state: 'occupied', finishAt, leftMin: 12 }] }] },
    })
  })
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/tasks', {
    body: { machineId: 'm1', mode: 'machine', minutes: 999 },
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 200)
  const list = await store.get('tasks:u_1', [])
  assert.equal(list[0].endAt, finishAt, '应等于机器的完成时间')
  assert.equal(list[0].mode, 'machine')
  assert.ok(list[0].minutes <= 13)
})

test('mode=machine 但机器没剩余时间 → 明确报错', async () => {
  const { call } = await makeApp(async (s) => {
    await seedUser(s)
    await s.put('machines:b1', {
      board: { floors: [{ code: '1', machines: [{ id: 'm1', name: '1号机', floorCode: '1', state: 'idle', finishAt: null, leftMin: null }] }] },
    })
  })
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/tasks', {
    body: { machineId: 'm1', mode: 'machine' },
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 400)
  assert.match(r.j.error.message, /没有剩余时间/)
})

test('烘干机按自定义时长登记（修复被洗衣机白名单拒掉的 bug）', async () => {
  const { store, call } = await makeApp(async (s) => {
    await seedUser(s)
    await s.put('machines:b1', {
      board: { floors: [{ code: '1', machines: [{ id: 'd1', name: '梅园1楼洗衣房烘干机', floorCode: '1', state: 'idle', finishAt: null, leftMin: null }] }] },
    })
  })
  const tok = await issueToken('u_1', SECRET)
  // 60 分钟：原来会被 [30,42,50,70] 拒掉
  const r = await call('POST', '/api/tasks', {
    body: { machineId: 'd1', minutes: 60 },
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 200, r.text)
  const list = await store.get('tasks:u_1', [])
  assert.equal(list[0].minutes, 60)
})

test('洗衣机仍然只认 30/42/50/70', async () => {
  const { call } = await makeApp(async (s) => {
    await seedUser(s)
    await s.put('machines:b1', {
      board: { floors: [{ code: '1', machines: [{ id: 'm1', name: '1号机', floorCode: '1', state: 'idle' }] }] },
    })
  })
  const tok = await issueToken('u_1', SECRET)
  for (const bad of [60, 45, 0, -10, NaN]) {
    const r = await call('POST', '/api/tasks', {
      body: { machineId: 'm1', minutes: bad },
      headers: { authorization: 'Bearer ' + tok },
    })
    assert.equal(r.status, 400, `minutes=${bad} 应拒绝`)
  }
})

// ---------- 通知文案 ----------

test('取衣提醒（提前）有剩余分钟和预计完成时间', () => {
  const n = buildTakeNotice({
    machineName: '桂园1楼7号机',
    floorCode: '1',
    leftMin: 12,
    endAt: '2026-10-25T10:32:00Z',
    variant: 0,
  })
  assert.match(n.markdown, /快洗好了/)
  assert.match(n.markdown, /\*\*桂园1楼7号机 · 1 楼\*\*/)
  // 具体说法按模板变，但分钟数必须在
  assert.match(n.markdown, /12 分钟/)
  assert.match(n.markdown, /18:32/, '要带预计结束时间（北京时间）')
  // 纯文本兜底也必须能看懂
  assert.match(n.text, /12 分钟/)
})

test('取衣提醒（到点）不写倒计时', () => {
  const n = buildTakeNotice({
    machineName: '7号机',
    floorCode: '1',
    leftMin: null,
    endAt: '2026-10-25T10:32:00Z',
    variant: 0,
  })
  assert.match(n.markdown, /洗好了/)
  assert.ok(!n.markdown.includes('还剩'))
  assert.ok(!n.markdown.includes('剩余'))
})

test('楼层为空时副标题不带多余分隔符', () => {
  const n = buildTakeNotice({ machineName: '7号机', leftMin: 5 })
  assert.ok(!n.markdown.includes('·'), '没有楼层就不该出现 ·')
})

test('剩余时间未更新 / 催促文案', () => {
  const s = buildStuckNotice({ machineName: '烘干机', floorCode: '1', leftMin: 42, stuckMin: 12 })
  assert.match(s.markdown, /剩余时间未更新/)
  assert.match(s.markdown, /可能是数据延迟/)
  assert.match(s.markdown, /12 分钟/)

  const u = buildUrgeNotice({ machineName: '7号机', floorCode: '1', count: 3 })
  assert.match(u.markdown, /有人在等你取衣/)
  assert.match(u.markdown, /第 \*\*3\*\* 次/)
})

test('hhmm 按北京时间格式化', () => {
  // 2026-10-25T10:32:00Z = 北京时间 18:32
  assert.equal(hhmm('2026-10-25T10:32:00Z'), '18:32')
  assert.equal(hhmm(null), '')
  assert.equal(hhmm('bad'), '')
})

test('AUDIT_TYPES 覆盖要求的类型', () => {
  for (const t of ['auth', 'task', 'queue', 'message', 'urge', 'admin', 'notify', 'sync', 'error']) {
    assert.ok(AUDIT_TYPES[t], t)
  }
})
