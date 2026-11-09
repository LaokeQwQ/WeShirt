// 任务状态（overdue）、我已取衣、留言头像实时性、通知文案模板
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { issueToken } from '../packages/core/auth.js'
import { buildTakeNotice, NOTICE_TEMPLATES } from '../packages/core/notice.js'

const SECRET = 's'.repeat(32)

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
  return { store, call }
}

async function seedTask(store, task) {
  await store.put('user:u_1', { id: 'u_1', nick: '测试同学', avatar: 'av1', takeCode: '000000' })
  await store.put('tasks:u_1', [
    {
      id: 't_1',
      machineId: 'm1',
      machineName: '桂园1楼1号机',
      startAt: new Date(Date.now() - 3600e3).toISOString(),
      endAt: new Date(Date.now() - 1800e3).toISOString(),
      done: false,
      notified: true,
      ...task,
    },
  ])
}

// ---------- 任务状态 ----------

test('过期任务返回 overdueMin（不再被夹成 0）', async () => {
  const { call } = await makeApp((s) => seedTask(s))
  const tok = await issueToken('u_1', SECRET)
  const r = await call('GET', '/api/tasks', { headers: { authorization: 'Bearer ' + tok } })
  assert.equal(r.status, 200)
  const t = r.j.tasks[0]
  // computeLeftMin 对已结束的任务返回负数（不是 0），前端靠 >0 判断
  assert.ok(t.leftMin <= 0, `leftMin=${t.leftMin}`)
  assert.ok(t.overdueMin >= 29, `overdueMin=${t.overdueMin} 应该约 30 分钟`)
  assert.equal(t.done, false)
})

test('还没结束的任务 overdueMin=0', async () => {
  const { call } = await makeApp((s) =>
    seedTask(s, { endAt: new Date(Date.now() + 20 * 60000).toISOString() })
  )
  const tok = await issueToken('u_1', SECRET)
  const r = await call('GET', '/api/tasks', { headers: { authorization: 'Bearer ' + tok } })
  assert.equal(r.j.tasks[0].overdueMin, 0)
  assert.ok(r.j.tasks[0].leftMin > 0)
})

// ---------- 我已取衣 ----------

test('take 标记完成并清占用', async () => {
  const { store, call } = await makeApp(async (s) => {
    await seedTask(s)
    const [task] = await s.get('tasks:u_1', [])
    await s.put('occupancy:b1', { m1: {
      userId: 'u_1', nick: '测试同学', taskId: task.id, startAt: task.startAt, endAt: task.endAt,
    } })
  })
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/tasks/t_1/take', {
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 200)
  const list = await store.get('tasks:u_1', [])
  assert.equal(list[0].done, true)
  assert.ok(list[0].takenAt)
  const occ = await store.get('occupancy:b1', {})
  assert.equal(occ.m1, undefined, '占用要清掉')
})

test('take 后 GET 显示 done，且再 take 仍是幂等成功', async () => {
  const { call } = await makeApp((s) => seedTask(s))
  const tok = await issueToken('u_1', SECRET)
  await call('POST', '/api/tasks/t_1/take', { headers: { authorization: 'Bearer ' + tok } })
  const g = await call('GET', '/api/tasks', { headers: { authorization: 'Bearer ' + tok } })
  assert.equal(g.j.tasks[0].done, true)
  assert.equal(g.j.tasks[0].overdueMin > 0, true)
})

test('take 别人的任务 404', async () => {
  const { call } = await makeApp((s) => seedTask(s))
  const tok = await issueToken('u_1', SECRET)
  const r = await call('POST', '/api/tasks/t_not_mine/take', {
    headers: { authorization: 'Bearer ' + tok },
  })
  assert.equal(r.status, 404)
})

test('take 未登录 401', async () => {
  const { call } = await makeApp((s) => seedTask(s))
  const r = await call('POST', '/api/tasks/t_1/take')
  assert.equal(r.status, 401)
})

// ---------- 留言头像取当前资料 ----------

test('留言板头像/昵称跟用户当前资料，不用发帖时的快照', async () => {
  const { call } = await makeApp(async (s) => {
    await s.put('user:u_1', {
      id: 'u_1',
      nick: '新昵称',
      avatar: 'av8',
      avatarUrl: 'https://example.com/a.jpg',
      takeCode: '000000',
    })
    await s.put('messages:b1', [
      // 发帖时是旧昵称 + 旧头像
      { id: 'm1', userId: 'u_1', nick: '旧昵称', avatar: 'av1', text: 'hi', channel: 'public', at: '2026-10-25T00:00:00Z' },
    ])
  })
  const r = await call('GET', '/api/messages')
  assert.equal(r.status, 200)
  const m = r.j.messages[0]
  assert.equal(m.nick, '新**', '昵称要用当前的（并打码）')
  assert.equal(m.avatar, 'av8')
  assert.equal(m.avatarUrl, 'https://example.com/a.jpg')
})

test('用户被删后留言退回快照，不报错', async () => {
  const { call } = await makeApp(async (s) => {
    await s.put('messages:b1', [
      { id: 'm1', userId: 'u_gone', nick: '走掉的', avatar: 'av3', text: 'hi', channel: 'public', at: '2026-10-25T00:00:00Z' },
    ])
  })
  const r = await call('GET', '/api/messages')
  assert.equal(r.status, 200)
  assert.equal(r.j.messages[0].avatar, 'av3')
  assert.equal(r.j.messages[0].nick, '走**')
})

// ---------- 通知文案：多模板 + 多空行 ----------

test('提前提醒有 5 种说法，都能正常生成', () => {
  const seen = new Set()
  for (let v = 0; v < NOTICE_TEMPLATES.BEFORE_LINES.length; v++) {
    const n = buildTakeNotice({
      machineName: '7号机',
      floorCode: '1',
      leftMin: 12,
      endAt: '2026-10-25T10:32:00Z',
      variant: v,
    })
    assert.ok(n.markdown.includes('### ⏳ 快洗好了'))
    assert.ok(n.markdown.includes('**7号机 · 1 楼**'))
    assert.ok(n.text.length > 0)
    seen.add(n.markdown)
  }
  assert.equal(seen.size, NOTICE_TEMPLATES.BEFORE_LINES.length, '每种 variant 都该不一样')
})

test('markdown 有分段空行，不是一坨', () => {
  const n = buildTakeNotice({ machineName: '7号机', floorCode: '1', leftMin: 12 })
  assert.ok(n.markdown.includes('\n\n'), '段落之间要空行')
  assert.ok(!/\n{3,}/.test(n.markdown), '不能出现三连空行')
})

test('文案里不出现「温馨提醒 / 请及时 / 尊敬的用户」这类 AI 腔', () => {
  for (const v of [0, 1, 2, 3, 4]) {
    const n = buildTakeNotice({ machineName: '7号机', leftMin: 8, variant: v })
    for (const bad of ['温馨', '请及时', '尊敬的用户', '亲爱的用户', '系统提醒您']) {
      assert.ok(!n.markdown.includes(bad) && !n.text.includes(bad), `${bad} 不该出现`)
    }
  }
})

test('到点文案也不重复同一句', () => {
  const set = new Set()
  for (let v = 0; v < NOTICE_TEMPLATES.DONE_LINES.length; v++) {
    set.add(buildTakeNotice({ machineName: '7号机', leftMin: null, variant: v }).markdown)
  }
  assert.equal(set.size, NOTICE_TEMPLATES.DONE_LINES.length)
})
