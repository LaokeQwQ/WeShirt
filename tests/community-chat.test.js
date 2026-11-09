import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerCommunityRoutes } from '../server/community.js'
import { createMemoryStore } from '../packages/core/store.js'
import { enqueueCommunityNotice, processCommunityNotices, readCommunityNotices } from '../packages/core/community-notices.js'
import { inspectMp4 } from '../packages/core/community-media.js'
import { createCommunityMedia, pruneCommunityMedia } from '../server/community-media.js'
import { readFileSync } from 'node:fs'
import { getUserPermissions } from '../packages/core/permissions.js'
import { DORM_BUILDINGS } from '../packages/core/buildings.js'
import { runSync } from '../server/app.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAvsAAAAASUVORK5CYII=', 'base64')

test('scheduled sync reclaims unattended expired community attachments', async () => {
  const store=createMemoryStore(), now=Date.now()
  await store.put('operations:config',{broadcast:{enabled:false}})
  const media=createCommunityMedia({store,now:()=>now-31*60000})
  const item=await media.upload(new Request('https://test.example/media',{method:'POST',headers:{'content-type':'image/png'},body:png}),'idle-user','public')
  const result=await runSync({BUILDING_ID:'b1',HAIER_MODE:'mock'},store,{raws:[{id:'test-machine',name:'测试机器',state:1}]})
  assert.deepEqual(result.communityMediaGc,{removed:1})
  assert.equal((await store.list('community:media:'+item.id)).length,0)
  assert.deepEqual(await store.get('community:media-index:idle-user'),[])
})
const u32 = (n) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(n); return bytes }
const box = (type, ...parts) => { const bytes = Buffer.concat(parts); return Buffer.concat([u32(bytes.length + 8), Buffer.from(type), bytes]) }
function mp4({ seconds = 5, sampleSeconds = seconds, offsetDelta = 0 } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomavc1'))
  const sample = Buffer.from([0, 0, 0, 2, 0x65, 0x88])
  const full = (n) => Buffer.alloc(n)
  const timing = (size) => { const value = full(size); value.writeUInt32BE(1000, 12); value.writeUInt32BE(seconds * 1000, 16); return value }
  const tkhd = full(84); tkhd.writeUInt32BE(640 * 65536, 76); tkhd.writeUInt32BE(360 * 65536, 80)
  const hdlr = full(24); hdlr.write('vide', 8)
  const avc = full(78); avc.writeUInt16BE(1, 6); avc.writeUInt16BE(640, 24); avc.writeUInt16BE(360, 26)
  const avcc = box('avcC', Buffer.from([1, 66, 0, 30, 255, 225, 0, 2, 0x67, 0x42, 1, 0, 2, 0x68, 0xce]))
  const makeMoov = (offset) => box('moov', box('mvhd', timing(100)), box('trak', box('tkhd', tkhd), box('mdia', box('mdhd', timing(24)), box('hdlr', hdlr),
    box('minf', box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1)))), box('stbl',
      box('stsd', u32(0), u32(1), box('avc1', avc, avcc)), box('stts', u32(0), u32(1), u32(1), u32(sampleSeconds * 1000)),
      box('stsz', u32(0), u32(sample.length), u32(1)), box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)), box('stco', u32(0), u32(1), u32(offset)))))))
  const initial = makeMoov(0), moov = makeMoov(ftyp.length + initial.length + 8 + offsetDelta)
  return Buffer.concat([ftyp, moov, box('mdat', sample)])
}
async function fixture(t) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network is forbidden') })
  const store = createMemoryStore(); let clock = Date.now()
  for (const [id, dormBuilding] of [['a', 'guiyuan'], ['b', 'liuyuan'], ['c', 'guiyuan'], ['admin', 'guiyuan'], ['volunteer', 'guiyuan'], ['operator', 'guiyuan']]) await store.put('user:' + id, { id, nick: id + '同学', dormBuilding, notifyOn: true })
  await store.put('meta:siteAdmins', [{ userId: 'admin', role: 'admin' }, { userId: 'volunteer', role: 'volunteer', buildings: ['guiyuan'] }, { userId: 'operator', role: 'operator' }])
  const env = { BUILDING_ID: 'b1', COMMUNITY_WS_GATEWAY_URL: 'wss://relay.example.test/ws', COMMUNITY_WS_GATEWAY_SECRET: 'community-ws-test-secret-at-least-32-characters' }
  const app = new Hono()
  registerCommunityRoutes(app, { store, env, authenticate: (c) => c.req.header('x-user'), now: () => clock })
  async function call(path, { user = 'a', method = 'GET', body, raw, mime = 'application/json', headers = {} } = {}) {
    const response = await app.request('https://test.example' + path, { method, headers: { ...(user ? { 'x-user': user } : {}), 'Content-Type': mime, ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) })
    const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer())
    return { status: response.status, data, response }
  }
  const post = (body, user = 'a') => call('/api/messages', { user, method: 'POST', body })
  return { store, env, app, call, post, advance: (ms = 11000) => { clock += ms }, now: () => clock }
}

test('ordinary/operator/volunteer channels are public plus own building; admin is further restricted by overrides', async (t) => {
  const { call, post, store } = await fixture(t)
  for (const user of ['a', 'operator', 'volunteer']) {
    assert.deepEqual((await call('/api/messages/channels', { user })).data.channels.map((row) => row.code), ['public', 'guiyuan'])
    assert.equal((await call('/api/messages?channel=liuyuan', { user })).status, 403)
    assert.equal((await post({ channel: 'liuyuan', text: '跨楼' }, user)).status, 403)
    assert.equal((await call('/api/messages/participants?channel=liuyuan', { user })).status, 403)
    assert.equal((await call('/api/messages/realtime?channel=liuyuan', { user })).status, 403)
    assert.equal((await call('/api/messages/media?channel=liuyuan', { user, method: 'POST', raw: png, mime: 'image/png' })).status, 403)
  }
  assert.deepEqual((await call('/api/messages/channels', { user: null })).data.channels.map((row) => row.code), ['public'])
  await store.put('access:user:admin', { permissions: { messages: { viewBuildings: ['guiyuan'], operateBuildings: ['guiyuan'] } } })
  assert.equal((await call('/api/messages?channel=liuyuan', { user: 'admin' })).status, 403)
  assert.equal((await post({ channel: 'public', text: '管理员仍受范围约束' }, 'admin')).status, 403)
})

test('disabled history cannot remap into an enabled/default channel; default queries filter inaccessible data', async (t) => {
  const { call, post, store } = await fixture(t)
  await store.put('meta:site', { buildings: [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园', enabled: false }] })
  await store.put('messages:b1', [{ id: 'disabled', userId: 'b', text: '停用楼秘密', channel: 'liuyuan' }, { id: 'own', userId: 'a', text: '本楼', channel: 'guiyuan' }])
  assert.equal((await call('/api/messages', { user: 'admin' })).data.messages.some((row) => row.text === '停用楼秘密'), false)
  assert.notEqual((await call('/api/messages?channel=liuyuan', { user: 'admin' })).status, 200)
  assert.notEqual((await post({ channel: 'liuyuan', text: '停用楼' }, 'admin')).status, 200)
  assert.equal((await post({ channel: 'guiyuan', text: '跨楼引用', replyTo: 'disabled' })).status, 400)
})

test('media uploads enforce login/channel ownership/real content, bound bytes and immutable server metadata', async (t) => {
  const { call, post, advance } = await fixture(t)
  assert.equal((await call('/api/messages/media?channel=guiyuan', { user: null, method: 'POST', raw: png, mime: 'image/png' })).status, 401)
  const upload = await call('/api/messages/media?channel=guiyuan', { method: 'POST', raw: png, mime: 'image/png' })
  assert.equal(upload.status, 200)
  const media = upload.data.media
  assert.equal((await call('/api/messages/media/' + media.id, { user: 'c' })).status, 403, 'unpublished attachments are private to the uploader')
  assert.equal((await post({ channel: 'guiyuan', mediaId: media.id }, 'c')).status, 403)
  const saved = await post({ channel: 'guiyuan', mediaId: media.id, media: { url: 'javascript:alert(1)', mime: 'text/html' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.message.media.mime, 'image/png')
  assert.equal(saved.data.message.media.url, '/api/messages/media/' + media.id)
  const retrieved = await call('/api/messages/media/' + media.id, { user: 'c' })
  assert.deepEqual(Buffer.from(retrieved.data), png)
  assert.equal(retrieved.response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal((await call('/api/messages/media/' + media.id, { user: 'b' })).status, 403)
  advance()
  assert.equal((await post({ channel: 'guiyuan', mediaId: media.id })).status, 403, 'a linked attachment cannot be reused')
  assert.equal((await call('/api/messages/media?channel=guiyuan', { method: 'POST', raw: Buffer.from('<svg onload=alert(1)>'), mime: 'image/png' })).status, 400)
  assert.equal((await call('/api/messages/media?channel=guiyuan', { method: 'POST', raw: Buffer.alloc(4 * 1024 * 1024 + 1), mime: 'video/mp4' })).status, 413)
})

test('MP4 checks true track/sample duration, data offsets and MIME rather than trusting client metadata', async (t) => {
  assert.equal(inspectMp4(mp4()).duration, 5)
  assert.throws(() => inspectMp4(mp4({ seconds: 31 })), /30 秒/)
  assert.throws(() => inspectMp4(mp4({ seconds: 5, sampleSeconds: 31 })), /30 秒/)
  assert.throws(() => inspectMp4(mp4({ offsetDelta: -500 })))
  const { call } = await fixture(t)
  const valid = await call('/api/messages/media?channel=guiyuan', { method: 'POST', raw: mp4(), mime: 'video/mp4' })
  assert.equal(valid.status, 200)
  assert.equal(valid.data.media.duration, 5)
  assert.equal((await call('/api/messages/media?channel=guiyuan', { method: 'POST', raw: mp4(), mime: 'image/png' })).status, 400)
})

test('a real browser H264 recording remuxed without transcoding passes upload, posting and authenticated playback', async (t) => {
  const bytes = readFileSync(new URL('./fixtures/community-real.mp4', import.meta.url))
  const details = inspectMp4(bytes)
  assert.equal(details.width, 320); assert.equal(details.height, 240)
  assert.ok(details.duration > 2 && details.duration < 3)
  const { call, post } = await fixture(t)
  const upload = await call('/api/messages/media?channel=guiyuan', { method: 'POST', raw: bytes, mime: 'video/mp4' })
  assert.equal(upload.status, 200)
  assert.equal((await post({ channel: 'guiyuan', mediaId: upload.data.media.id })).status, 200)
  assert.deepEqual(Buffer.from((await call(upload.data.media.url, { user: 'c' })).data), bytes)
})

test('reply references are selected server-side and cross-channel references are rejected', async (t) => {
  const { post, advance } = await fixture(t)
  const parent = await post({ channel: 'guiyuan', text: '可信原文' })
  advance()
  const reply = await post({ channel: 'guiyuan', text: '<script>只是文本</script>', replyTo: parent.data.id, reply: { text: '伪造引用', nick: '伪造管理' } })
  assert.equal(reply.status, 200)
  assert.equal(reply.data.message.reply.text, '可信原文')
  advance()
  assert.equal((await post({ channel: 'public', text: '跨频道', replyTo: parent.data.id })).status, 400)
})

test('@ references are channel bound, deduplicated, omit self and create durable owner-only notices with safe DM retry', async (t) => {
  const { post, call, store, advance, now } = await fixture(t)
  await post({ channel: 'guiyuan', text: '成员丙' }, 'c')
  await post({ channel: 'guiyuan', text: '成员甲' }, 'a')
  const rows = (await call('/api/messages?channel=guiyuan')).data.messages
  const self = rows.find((row) => row.mine).mentionRef, other = rows.find((row) => !row.mine).mentionRef
  advance()
  const saved = await post({ channel: 'guiyuan', text: '来聊两句', mentions: [other, other, self] })
  assert.equal(saved.status, 200)
  assert.equal((await readCommunityNotices(store, 'c')).length, 1)
  assert.equal((await readCommunityNotices(store, 'a')).length, 0)
  assert.equal((await call('/api/messages/notices', { user: 'b' })).data.unread, 0)
  const own = (await call('/api/messages/notices', { user: 'c' })).data
  assert.equal(own.unread, 1)
  assert.equal(JSON.stringify(own).includes('mentionUserIds'), false)
  assert.equal((await call('/api/messages/notices/' + own.notices[0].id + '/read', { user: 'b', method: 'POST', body: {} })).status, 404)
  let attempts = 0
  const notify = async () => ({ ok: ++attempts > 1 })
  assert.equal((await processCommunityNotices({ store, notify, now: now() })).failed, 1)
  assert.equal((await processCommunityNotices({ store, notify, now: now() })).sent, 0)
  advance(61000)
  assert.equal((await processCommunityNotices({ store, notify, now: now() })).sent, 1)
  await processCommunityNotices({ store, notify, now: now() })
  assert.equal(attempts, 2)
  advance()
  assert.equal((await post({ channel: 'public', text: '跨频道@', mentions: [other] })).status, 403)
  assert.equal((await post({ channel: 'guiyuan', text: '伪造@全体', mentions: ['all'] })).status, 400)
})

test('ordinary users cannot announce/pin/@all; an authorized own-building volunteer can, with bounded @all and scope', async (t) => {
  const { post, call, store, advance } = await fixture(t)
  assert.equal((await post({ channel: 'guiyuan', text: '伪造公告', type: 'announcement' })).status, 403)
  assert.equal((await post({ channel: 'guiyuan', text: '伪造全体', mentionAll: true })).status, 403)
  const normal = await post({ channel: 'guiyuan', text: '普通留言' })
  assert.equal((await call('/api/messages/' + normal.data.id + '/pin', { method: 'POST', body: { pinned: true } })).status, 403)
  const announced = await post({ channel: 'guiyuan', text: '值日公告', type: 'announcement', mentionAll: true }, 'volunteer')
  assert.equal(announced.status, 200)
  assert.equal(announced.data.message.type, 'announcement')
  assert.equal(announced.data.message.pinned, true)
  assert.equal((await readCommunityNotices(store, 'b')).length, 0, 'all means current channel members only')
  assert.ok((await readCommunityNotices(store, 'a')).length)
  advance()
  assert.equal((await post({ channel: 'guiyuan', text: '再次全体', mentionAll: true }, 'volunteer')).status, 429)
  assert.equal((await call('/api/messages/' + normal.data.id + '/pin', { user: 'volunteer', method: 'POST', body: { pinned: true } })).status, 200)
  assert.equal((await post({ channel: 'liuyuan', text: '跨楼公告', type: 'announcement' }, 'volunteer')).status, 403)
})

test('avatar changes require actual path channel authority and cannot use a forged query scope', async (t) => {
  const { call } = await fixture(t)
  const upload = (path, user) => call(path, { user, method: 'POST', raw: png, mime: 'image/png' })
  assert.equal((await upload('/api/messages/channels/guiyuan/avatar?channel=guiyuan', 'a')).status, 403)
  assert.equal((await upload('/api/messages/channels/liuyuan/avatar?channel=guiyuan', 'volunteer')).status, 403)
  assert.equal((await upload('/api/messages/channels/guiyuan/avatar?channel=guiyuan', 'volunteer')).status, 200)
  assert.match((await call('/api/messages/channels')).data.channels.find((row) => row.code === 'guiyuan').avatarData, /^data:image\/png/)
})

test('WS tickets need current channel access; state rechecks revocation, leases and 3-second rate and contains no body or UID', async (t) => {
  const { call, store, advance } = await fixture(t)
  const config = (await call('/api/messages/realtime?channel=guiyuan')).data
  assert.equal(config.enabled, true)
  const state = (ticket, connection = '1'.repeat(24)) => call('/api/messages/realtime/state', { user: null, headers: { Authorization: 'Bearer ' + ticket, 'X-Community-WS-Connection': connection } })
  const initial = await state(config.ticket)
  assert.equal(initial.status, 200)
  assert.deepEqual(Object.keys(initial.data).sort(), ['channel', 'inboxCount', 'revision'])
  assert.equal((await state(config.ticket)).status, 429)
  advance(3100)
  assert.equal((await state(config.ticket)).status, 200)
  const second = (await call('/api/messages/realtime?channel=guiyuan')).data
  assert.equal((await state(second.ticket, '2'.repeat(24))).status, 200)
  const third = (await call('/api/messages/realtime?channel=guiyuan')).data
  assert.equal((await state(third.ticket, '3'.repeat(24))).status, 429)
  assert.equal((await state(config.ticket, '4'.repeat(24))).status, 429, 'reusing a ticket cannot bypass the two-connection cap')
  assert.equal((await call('/api/messages/realtime/release', { user: null, method: 'POST', headers: { Authorization: 'Bearer ' + config.ticket, 'X-Community-WS-Connection': '1'.repeat(24) } })).status, 200)
  assert.equal((await state(config.ticket)).status, 401, 'a delayed state request cannot revive a released lease')
  assert.equal((await state(third.ticket, '3'.repeat(24))).status, 200)
  await store.put('access:user:a', { permissions: { messages: { view: false, operate: false } } })
  assert.equal((await state(config.ticket)).status, 403)
  assert.equal((await state('forged')).status, 401)
})

test('a callback revocation suppresses the next pending mention before another DM starts', async (t) => {
  const { store, now } = await fixture(t)
  await store.put('messages:b1', ['one', 'two'].map((id) => ({ id, channel: 'guiyuan' })))
  for (const messageId of ['one', 'two']) await enqueueCommunityNotice(store, 'c', { messageId, channel: 'guiyuan', title: '有人@你', text: '打开频道查看' }, now())
  let calls = 0
  const result = await processCommunityNotices({ store, now: now(), notify: async () => { calls++; await store.put('access:user:c', { permissions: { messages: { view: false, operate: false } } }); return { ok: true } } })
  assert.equal(calls, 1)
  assert.equal(result.sent, 1)
  assert.equal((await readCommunityNotices(store, 'c')).filter((entry) => entry.dm.suppressed).length, 1)
})

test('pending outbox capacity fails explicitly and bounded batches rotate without losing older recipients', async (t) => {
  const { store, now, post } = await fixture(t)
  const ids = Array.from({ length: 1000 }, (_, i) => 'user' + i)
  await enqueueCommunityNotice(store, ids[0], { messageId: 'first', channel: 'public' }, now())
  await store.put('community:notice-users', ids)
  await assert.rejects(enqueueCommunityNotice(store, 'extra', { messageId: 'extra', channel: 'public' }, now()), (error) => error.status === 429)
  assert.equal((await store.get('community:notice-users')).includes('user0'), true)
  assert.equal((await readCommunityNotices(store, 'user0'))[0].dm.attempts, 0)
  await store.put('community:mention-target:mention_11111111-1111-1111-1111-111111111111', { uid: 'c', channel: 'guiyuan' })
  assert.equal((await post({ channel: 'guiyuan', text: '队列满时不能假装发送成功', mentions: ['mention_11111111-1111-1111-1111-111111111111'] })).status, 429)
  assert.equal((await store.get('messages:b1', [])).length, 0)
  let reads = 0; const get = store.get
  store.get = (...args) => { reads++; return get(...args) }
  await processCommunityNotices({ store, now: now(), notify: async () => ({ ok: true }) })
  assert.ok(reads < 100, `bounded empty batch should not inspect all 1000 users; reads=${reads}`)
  assert.equal((await store.get('community:notice-users'))[0], 'user32')
  for (let i = 0; i < 30; i++) await enqueueCommunityNotice(store, 'c', { messageId: 'm' + i, channel: 'guiyuan' }, now())
  await assert.rejects(enqueueCommunityNotice(store, 'c', { messageId: 'overflow', channel: 'guiyuan' }, now()), (error) => error.status === 429)
  assert.equal((await readCommunityNotices(store, 'c')).some((entry) => entry.messageId === 'm0'), true)
})

test('media GC deletes expired metadata and chunks, while capacity preserves all linked attachments', async (t) => {
  const { store, now, advance } = await fixture(t), service = createCommunityMedia({ store, now })
  const request = () => new Request('https://test.example/media', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })
  const expired = await service.upload(request(), 'draft', 'guiyuan'), idleDraft = await service.upload(request(), 'idle', 'guiyuan')
  const first = await service.upload(request(), 'linked', 'guiyuan')
  await service.link(await service.get(first.id), 'linked', 'guiyuan', 'message0')
  advance(31 * 60000)
  assert.equal(await service.get(expired.id), null)
  assert.equal((await store.list('community:media:' + expired.id)).length, 0)
  assert.deepEqual(await pruneCommunityMedia({ store, now: now(), limit: 1 }), { removed: 1 })
  assert.equal((await store.list('community:media:' + idleDraft.id)).length, 0)
  assert.ok(await service.get(first.id))
  for (let i = 1; i < 20; i++) { advance(11 * 60000); const next = await service.upload(request(), 'linked', 'guiyuan'); await service.link(await service.get(next.id), 'linked', 'guiyuan', 'message' + i) }
  advance(11 * 60000)
  await assert.rejects(service.upload(request(), 'linked', 'guiyuan'), (error) => error.status === 429)
  assert.ok(await service.get(first.id), 'the first 30-day linked attachment is still present')
  assert.deepEqual(Buffer.from(await service.bytes(await service.get(first.id))), png)
  assert.equal((await store.get('community:media-index:linked')).length, 20)
})

test('@all reuses catalog and identity snapshots, and its slow member scan does not block ordinary posts', async (t) => {
  const { store, post } = await fixture(t), counts = new Map(), original = store.get
  for (let i = 0; i < 100; i++) await store.put('user:member' + i, { id: 'member' + i, nick: '成员', dormBuilding: 'guiyuan' })
  let release, reached
  const gate = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { reached = resolve })
  store.get = async (key, fallback) => { counts.set(key, (counts.get(key) || 0) + 1); if (key === 'access:user:member0') { reached(); await gate }; return original(key, fallback) }
  const all = post({ channel: 'guiyuan', text: '请查收', mentionAll: true }, 'volunteer')
  await started
  try { assert.equal((await Promise.race([post({ channel: 'liuyuan', text: '成员扫描不应锁住其他频道' }, 'b'), new Promise((resolve) => setTimeout(() => resolve({ status: 'blocked' }), 500))])).status, 200) } finally { release() }
  assert.equal((await all).status, 200)
  assert.ok(counts.get('meta:site') < 15)
  assert.ok(counts.get('meta:siteAdmins') < 15)
})

test('chunked JSON without Content-Length is stopped after 8KB rather than buffering the whole stream', async (t) => {
  const { app } = await fixture(t); let reads = 0, cancelled = false
  const stream = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(4096).fill(32)) }, cancel() { cancelled = true } }, { highWaterMark: 0 })
  const request = new Request('https://test.example/api/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'a' }, body: stream, duplex: 'half' })
  const response = await app.request(request)
  assert.equal(response.status, 413)
  assert.equal(cancelled, true)
  assert.equal(reads, 3)
})

test('failed @all validation does not spend its hourly allowance and successful chat needs only a two-second gap', async (t) => {
  const { post, store, advance } = await fixture(t)
  assert.equal((await post({ channel: 'guiyuan', text: '目标已删除', replyTo: 'missing', mentionAll: true }, 'volunteer')).status, 404)
  assert.equal(await store.get('community:all-rate:guiyuan', null), null)
  assert.equal((await post({ channel: 'guiyuan', text: '有效重试', mentionAll: true }, 'volunteer')).status, 200)
  assert.equal((await post({ channel: 'guiyuan', text: '正常消息' })).status, 200)
  assert.equal((await post({ channel: 'guiyuan', text: '即时重复' })).status, 429)
  advance(2000)
  assert.equal((await post({ channel: 'guiyuan', text: '连续聊天无需等十秒' })).status, 200)
})

test('outbox bulk suppresses blocked accounts once and bounds all-invalid active-account work', async (t) => {
  const { store, now } = await fixture(t)
  const ids = Array.from({ length: 32 }, (_, i) => 'blocked' + i)
  for (const uid of ids) { await store.put('user:' + uid, { id: uid, blocked: true }); await store.put('community-notices:' + uid, Array.from({ length: 30 }, (_, i) => ({ id: uid + '-' + i, messageId: 'deleted', channel: 'guiyuan', at: new Date(now()).toISOString(), dm: { attempts: 0 } }))) }
  await store.put('community:notice-users', ids)
  let reads = 0, writes = 0, callbacks = 0; const get = store.get, put = store.put
  store.get = (...args) => { reads++; return get(...args) }; store.put = (...args) => { writes++; return put(...args) }
  await processCommunityNotices({ store, now: now(), notify: async () => { callbacks++; return { ok: true } } })
  assert.equal(callbacks, 0); assert.ok(reads < 200); assert.ok(writes < 40)
  for (const uid of ['a', 'c', 'admin']) await put('community-notices:' + uid, Array.from({ length: 30 }, (_, i) => ({ id: uid + '-' + i, messageId: 'deleted', channel: 'guiyuan', at: new Date(now()).toISOString(), dm: { attempts: 0 } })))
  await put('community:notice-users', ['a', 'c', 'admin'])
  await processCommunityNotices({ store, now: now(), notify: async () => { callbacks++; return { ok: true } } })
  const lists = await Promise.all(['a', 'c', 'admin'].map((uid) => readCommunityNotices(store, uid)))
  assert.equal(lists.flat().filter((entry) => entry.dm.suppressed).length, 64)
})

test('permission revocation during @all scanning ignores the middleware cached authority at commit', async (t) => {
  const { store, env, now } = await fixture(t)
  await store.put('user:slow', { id: 'slow', dormBuilding: 'guiyuan' })
  await store.put('access:user:volunteer', { permissions: { messages: { view: true, operate: true } } })
  let release, reached; const gate = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { reached = resolve })
  const original = store.get
  store.get = async (key, fallback) => { if (key === 'access:user:slow') { reached(); await gate }; return original(key, fallback) }
  const app = new Hono()
  app.use('/api/*', async (c, next) => { c.set('userAccess', await getUserPermissions(store, await store.get('user:volunteer'), DORM_BUILDINGS)); return next() })
  registerCommunityRoutes(app, { store, env, now, authenticate: () => 'volunteer' })
  const request = app.request('https://test.example/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'guiyuan', text: '撤权不得继续提交', mentionAll: true }) })
  await started
  await store.put('access:user:volunteer', { permissions: { messages: { view: true, operate: false } } }); release()
  assert.equal((await request).status, 403)
  assert.equal((await store.get('messages:b1', [])).length, 0)
  assert.equal(await store.get('community:all-rate:guiyuan', null), null)
})
