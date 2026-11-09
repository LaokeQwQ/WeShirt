// WeShirt · 三条安全/健壮性修复的回归测试
//   1. 烘干机跳闸检测移到服务端（不依赖前端）
//   2. 明文回调（无签名）禁止写操作，绑定码长度抗穷举
//   3. 凭证照片自动过期清理（KV 无 TTL 的兜底）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, runSync, detectDryerStuck } from '../server/app.js'
import { createMemoryStore } from '../packages/core/store.js'
import { randomKey, randomCode } from '../packages/core/util.js'
import { parseCommand } from '../packages/core/dingtalk.js'
import { pruneAuditPhotos, getAuditPhoto } from '../packages/core/audit.js'

// ---------- 1. 绑定码强度与解析 ----------

test('randomKey 长度与字符集', () => {
  const k = randomKey(12)
  assert.equal(k.length, 12)
  assert.match(k, /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/)
  // 不能出现易混字符
  assert.ok(!/[01oli]/.test(k))
})

test('randomKey 有足够熵（1000 次不重复）', () => {
  const set = new Set()
  for (let i = 0; i < 1000; i++) set.add(randomKey(12))
  assert.equal(set.size, 1000)
})

test('parseCommand 认 12 位新码，也兼容 6 位老码', () => {
  const k = randomKey(12)
  assert.deepEqual(parseCommand(k), { cmd: 'bind', arg: k })
  assert.deepEqual(parseCommand('绑定 ' + k), { cmd: 'bind', arg: k })
  assert.deepEqual(parseCommand('bind ' + k), { cmd: 'bind', arg: k })
  // 大写输入归一成小写
  assert.deepEqual(parseCommand(k.toUpperCase()), { cmd: 'bind', arg: k })
  // 老格式仍然可用
  assert.deepEqual(parseCommand('123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('绑定 123456'), { cmd: 'bind', arg: '123456' })
  // 长度不对的不认
  assert.deepEqual(parseCommand('12345'), { cmd: null, arg: null })
  assert.deepEqual(parseCommand('abcdefghijklm'), { cmd: null, arg: null })
})

test('/api/bindcode 生成的是 12 位抗穷举码', async () => {
  const store = createMemoryStore()
  const env = { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: 's'.repeat(32) }
  const app = createApp({ store, env })
  const { issueToken } = await import('../packages/core/auth.js')
  const token = await issueToken('u_t', env.AUTH_SECRET)
  const r = await app.fetch(
    new Request('http://x/api/bindcode', { method: 'POST', headers: { authorization: 'Bearer ' + token } })
  )
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.code.length, 12)
  assert.match(j.code, /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/)
})

// ---------- 2. 明文回调禁止写操作 ----------

async function postCallback(app, body) {
  const r = await app.fetch(
    new Request('http://x/api/dingtalk/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  return { status: r.status, j: await r.json().catch(() => null) }
}

function plainRobotMsg(text, senderId = 'forged_id') {
  // 机器人 HTTP 模式推的明文结构（无签名）
  return {
    msgtype: 'text',
    text: { content: text },
    senderId,
    senderNick: '攻击者',
    conversationType: '2',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x',
  }
}

test('明文回调里的「绑定」不会写库（防绑定劫持）', async () => {
  const store = createMemoryStore()
  const env = { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: 's'.repeat(32) }
  const app = createApp({ store, env })

  // 受害者有一个有效绑定码
  const code = randomKey(12)
  await store.put(`bindcode:${code}`, { userId: 'u_victim', expAt: new Date(Date.now() + 6e5).toISOString() })
  await store.put('user:u_victim', { id: 'u_victim', nick: '受害者', dingUserId: null })

  const r = await postCallback(app, plainRobotMsg('绑定 ' + code, 'attacker_staff_id'))
  assert.equal(r.status, 200) // 回调本身要 ack，否则钉钉会重试

  // 关键：受害者的账号不能被绑到攻击者的 id 上
  const victim = await store.get('user:u_victim', null)
  assert.equal(victim.dingUserId, null)
  assert.equal(await store.get('userByDing:attacker_staff_id', null), null)
  // 绑定码也不该被消耗（密文路径还能用）
  assert.ok(await store.get(`bindcode:${code}`, null))
})

test('明文回调的写指令都留下拒绝痕迹', async () => {
  const store = createMemoryStore()
  const env = { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: 's'.repeat(32) }
  const app = createApp({ store, env })
  await store.put('user:u_x', { id: 'u_x', nick: '某', dingUserId: 'someone' })
  await store.put('userByDing:someone', 'u_x')

  for (const cmd of ['解绑', '提醒关', '提醒开']) {
    await postCallback(app, plainRobotMsg(cmd, 'someone'))
    const trace = await store.get('ding:lastCallback', null)
    assert.equal(trace.bindRejected, 'plain_callback_unsigned', `${cmd} 应被拒绝`)
  }
  // 解绑/关提醒都没真的生效
  const u = await store.get('user:u_x', null)
  assert.equal(u.dingUserId, 'someone')
  assert.notEqual(u.notifyOn, false)
})

test('明文回调的只读指令仍然可用', async () => {
  const store = createMemoryStore()
  const env = { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: 's'.repeat(32) }
  const app = createApp({ store, env })
  const r = await postCallback(app, plainRobotMsg('查', 'someone'))
  assert.equal(r.status, 200)
  const trace = await store.get('ding:lastCallback', null)
  assert.equal(trace.cmd, 'status')
  assert.equal(trace.bindRejected, null)
})

// ---------- 3. 照片自动清理 ----------

test('pruneAuditPhotos 只删过期照片，不删审计记录', async () => {
  const store = createMemoryStore()
  const old = { auditId: 'old', at: '2020-01-01T00:00:00Z', machineId: '1' }
  const fresh = { auditId: 'new', at: new Date().toISOString(), machineId: '1' }
  await store.put('urgeaudit:b1:1:1-old', old)
  await store.put('urgeaudit:b1:1:2-new', fresh)
  await store.put('urgephoto:old:occ', 'data:image/jpeg;base64,QQ==')
  await store.put('urgephoto:old:around', 'data:image/jpeg;base64,QQ==')
  await store.put('urgephoto:new:occ', 'data:image/jpeg;base64,QQ==')

  const r = await pruneAuditPhotos(store, { days: 30 })
  assert.equal(r.expired, 1)
  assert.equal(r.removed, 2) // 只删 old 的两张

  assert.equal(await getAuditPhoto(store, 'old', 'occ'), null)
  assert.equal(await getAuditPhoto(store, 'old', 'around'), null)
  assert.ok(await getAuditPhoto(store, 'new', 'occ')) // 新的还在芸
  // 审计记录必须在（纠纷追溯依据）
  assert.ok(await store.get('urgeaudit:b1:1:1-old', null))
})

test('pruneAuditPhotos 的 max 限制单次删除量（懒清理限流）', async () => {
  const store = createMemoryStore()
  for (let i = 0; i < 6; i++) {
    await store.put(`urgeaudit:b1:1:${i}-a${i}`, { auditId: `a${i}`, at: '2020-01-01T00:00:00Z', machineId: '1' })
    await store.put(`urgephoto:a${i}:occ`, 'data:image/jpeg;base64,QQ==')
  }
  const r = await pruneAuditPhotos(store, { days: 30, max: 2 })
  assert.equal(r.expired, 6)
  assert.equal(r.removed, 2) // 只清 2 条
  assert.ok(r.skipped > 0)

  // 再跑几次能把剩下的清完
  await pruneAuditPhotos(store, { days: 30, max: 10 })
  for (let i = 0; i < 6; i++) {
    assert.equal(await getAuditPhoto(store, `a${i}`, 'occ'), null)
  }
})

test('pruneAuditPhotos 遇到坏时间戳不误删', async () => {
  const store = createMemoryStore()
  await store.put('urgeaudit:b1:1:1-bad', { auditId: 'bad', at: 'not-a-date', machineId: '1' })
  await store.put('urgephoto:bad:occ', 'data:image/jpeg;base64,QQ==')
  const r = await pruneAuditPhotos(store, { days: 30 })
  assert.equal(r.expired, 0)
  assert.ok(await getAuditPhoto(store, 'bad', 'occ')) // 证据不能丢
})

test('getAuditPhoto 拒绝非白名单 kind', async () => {
  const store = createMemoryStore()
  await store.put('urgephoto:x:occ', 'data:image/jpeg;base64,QQ==')
  assert.ok(await getAuditPhoto(store, 'x', 'occ'))
  assert.equal(await getAuditPhoto(store, 'x', 'empty'), null)
  assert.equal(await getAuditPhoto(store, 'x', '../occ'), null)
})

// ---------- 4. 服务端跳闸检测 ----------

test('跳闸检测：无凭证未送达不记录 notifiedAt，允许下轮重试', async () => {
  const store = createMemoryStore()
  const env = { BUILDING_ID: 'b1' }
  // 10 分钟前就是这个剩余时间
  await store.put('dryerstuck:b1', {
    D1: { remain: 42, since: Date.now() - 10 * 60 * 1000, notifiedAt: 0 },
  })
  // 占用者绑了钉钉
  await store.put('occupancy:b1', {
    D1: { userId: 'u_n', nick: '某人', endAt: new Date(Date.now() + 6e5).toISOString() },
  })
  await store.put('user:u_n', { id: 'u_n', nick: '某人', dingUserId: 'staff_n' })

  // 真实机器形态：只有 leftMin，没有 kind，烘干机靠名字识别
  const alerts = await detectDryerStuck(env, store, [
    { id: 'D1', name: '柳园1楼烘干机。', floorCode: '1', state: 'occupied', leftMin: 42 },
  ])
  assert.equal(alerts, 0)

  const rec = (await store.get('dryerstuck:b1', {}))['D1']
  assert.equal(rec.notifiedAt, 0, '只有实际送达才进入冷却')
})

test('跳闸检测：leftMin 变了就重新计时，不报', async () => {
  const store = createMemoryStore()
  const env = { BUILDING_ID: 'b1' }
  await store.put('dryerstuck:b1', {
    D1: { remain: 50, since: Date.now() - 20 * 60 * 1000, notifiedAt: 0 },
  })
  const alerts = await detectDryerStuck(env, store, [
    { id: 'D1', name: '烘干机', state: 'occupied', leftMin: 49 }, // 变了
  ])
  assert.equal(alerts, 0)
  const rec = (await store.get('dryerstuck:b1', {}))['D1']
  assert.equal(rec.remain, 49)
  assert.ok(Date.now() - rec.since < 5000, 'since 应重置到现在')
})

test('跳闸检测：洗衣机 / 空闲机 / 故障机都不参与', async () => {
  const store = createMemoryStore()
  const env = { BUILDING_ID: 'b1' }
  const old = Date.now() - 30 * 60 * 1000
  await store.put('dryerstuck:b1', {
    W1: { remain: 30, since: old, notifiedAt: 0 },
    D2: { remain: 30, since: old, notifiedAt: 0 },
    D3: { remain: 30, since: old, notifiedAt: 0 },
  })
  const alerts = await detectDryerStuck(env, store, [
    // 名字里没有「烘干」→ 洗衣机
    { id: 'W1', name: '桂园1楼1号机', state: 'occupied', leftMin: 30 },
    // 烘干机但空闲
    { id: 'D2', name: '烘干机', state: 'idle', leftMin: null },
    // 烘干机但故障
    { id: 'D3', name: '烘干机', state: 'faulty', leftMin: 30 },
  ])
  assert.equal(alerts, 0)
  // 不参与的都从状态表里清掉，避免残留
  assert.deepEqual(await store.get('dryerstuck:b1', {}), {})
})

test('跳闸检测：30 分钟内不重复轰炸同一台', async () => {
  const store = createMemoryStore()
  const env = { BUILDING_ID: 'b1' }
  await store.put('dryerstuck:b1', {
    D1: { remain: 42, since: Date.now() - 60 * 60 * 1000, notifiedAt: Date.now() - 5 * 60 * 1000 },
  })
  const alerts = await detectDryerStuck(env, store, [
    { id: 'D1', name: '烘干机', state: 'occupied', leftMin: 42 },
  ])
  assert.equal(alerts, 0, '5 分钟前刚通知过，不该重复')
})

test('跳闸检测：leftMin 为空时不误报', async () => {
  const store = createMemoryStore()
  const env = { BUILDING_ID: 'b1' }
  await store.put('dryerstuck:b1', {
    D1: { remain: null, since: Date.now() - 60 * 60 * 1000, notifiedAt: 0 },
  })
  const alerts = await detectDryerStuck(env, store, [
    { id: 'D1', name: '烘干机', state: 'occupied', leftMin: null },
  ])
  assert.equal(alerts, 0)
})

test('runSync 在模块缺失时也能返回（含 dryerAlerts 契约）', async () => {
  const store = createMemoryStore()
  const out = await runSync({ BUILDING_ID: 'b1' }, store)
  assert.ok('error' in out)
  assert.ok(Array.isArray(out.events))
})

// ---------- 5. 管理端清理接口走同一套逻辑 ----------

test('管理端 purge 接口：dry-run 统计，apply 才删', async () => {
  const store = createMemoryStore()
  const env = { ADMIN_TOKEN: 'test-admin-token', BUILDING_ID: 'b1', AUTH_SECRET: 's'.repeat(32) }
  const app = createApp({ store, env })
  await store.put('urgeaudit:b1:1:1-o', { auditId: 'o', at: '2020-01-01T00:00:00Z', machineId: '1' })
  await store.put('urgephoto:o:occ', 'data:image/jpeg;base64,QQ==')

  const H = { 'x-admin-token': 'test-admin-token' }
  const dry = await app.fetch(new Request('http://x/api/admin/purge-audit-photos?days=30', { method: 'POST', headers: H }))
  const dj = await dry.json()
  assert.equal(dj.applied, false)
  assert.equal(dj.candidates, 1)
  assert.ok(await getAuditPhoto(store, 'o', 'occ'))

  const ap = await app.fetch(
    new Request('http://x/api/admin/purge-audit-photos?days=30&apply=1', { method: 'POST', headers: H })
  )
  const aj = await ap.json()
  assert.equal(aj.applied, true)
  assert.equal(aj.removed, 1)
  assert.equal(await getAuditPhoto(store, 'o', 'occ'), null)
})
