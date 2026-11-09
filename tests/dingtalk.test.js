// WeShirt · 钉钉通道测试（node:test，ESM）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCommand,
  verifyAndDecryptCallback,
  createDingTalk,
  buildBindReply,
  buildStatusReply,
} from '../packages/core/dingtalk.js'

// ---------- 测试辅助（与实现保持一致） ----------
function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- parseCommand ----------
test('parseCommand 8 种输入', () => {
  assert.deepEqual(parseCommand('@等衣 绑定 123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('绑定 123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('@机器人 解绑'), { cmd: 'unbind', arg: null })
  assert.deepEqual(parseCommand('查'), { cmd: 'status', arg: null })
  assert.deepEqual(parseCommand('提醒开'), { cmd: 'on', arg: null })
  assert.deepEqual(parseCommand('帮助'), { cmd: 'help', arg: null })
  assert.deepEqual(parseCommand('今天天气不错'), { cmd: null, arg: null })
})

test('parseCommand 英文别名与大小写容错', () => {
  assert.deepEqual(parseCommand('  status '), { cmd: 'status', arg: null })
  assert.deepEqual(parseCommand('@机器人 提醒关'), { cmd: 'off', arg: null })
  assert.deepEqual(parseCommand('HELP'), { cmd: 'help', arg: null })
  assert.deepEqual(parseCommand('off'), { cmd: 'off', arg: null })
  assert.deepEqual(parseCommand(''), { cmd: null, arg: null })
  assert.deepEqual(parseCommand(null), { cmd: null, arg: null })
})

test('parseCommand 绑定码三种写法都要认（用户明确要求）', () => {
  // 裸 6 位数字
  assert.deepEqual(parseCommand('123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('  123456  '), { cmd: 'bind', arg: '123456' })
  // 绑定123456（无空格）
  assert.deepEqual(parseCommand('绑定123456'), { cmd: 'bind', arg: '123456' })
  // 绑定 123456（有空格）
  assert.deepEqual(parseCommand('绑定 123456'), { cmd: 'bind', arg: '123456' })
  // 冒号/全角数字/带 @ 前缀等常见变体
  assert.deepEqual(parseCommand('绑定：123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('绑定: 123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('１２３４５６'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('@等衣 绑定123456'), { cmd: 'bind', arg: '123456' })
  assert.deepEqual(parseCommand('bind 123456'), { cmd: 'bind', arg: '123456' })
  // 位数不对不认
  assert.deepEqual(parseCommand('12345'), { cmd: null, arg: null })
  assert.deepEqual(parseCommand('绑定 1234567'), { cmd: null, arg: null })
})

// ---------- verifyAndDecryptCallback 验签+解密往返 ----------
test('verifyAndDecryptCallback 验签解密往返', async () => {
  const token = 'dt_token_xyz'
  const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32))
  const fullB64 = bytesToB64(aesKeyBytes)
  const aesKey = fullB64.replace(/=+$/, '') // 43 字符（末尾去 '='）

  const iv = aesKeyBytes.slice(0, 16)
  const cryptoKey = await crypto.subtle.importKey('raw', aesKeyBytes, 'AES-CBC', false, ['encrypt'])

  const original = { event: 'bind', staffId: '123456', ts: 1700000000 }
  const msgBytes = new TextEncoder().encode(JSON.stringify(original))
  const rand16 = crypto.getRandomValues(new Uint8Array(16))
  const lenBuf = new Uint8Array(4)
  lenBuf[0] = (msgBytes.length >>> 24) & 0xff
  lenBuf[1] = (msgBytes.length >>> 16) & 0xff
  lenBuf[2] = (msgBytes.length >>> 8) & 0xff
  lenBuf[3] = msgBytes.length & 0xff
  const corpId = new TextEncoder().encode('corp123')
  const total = new Uint8Array(16 + 4 + msgBytes.length + corpId.length)
  total.set(rand16, 0)
  total.set(lenBuf, 16)
  total.set(msgBytes, 20)
  total.set(corpId, 20 + msgBytes.length)

  const encBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, total)
  const encrypt = bytesToB64(new Uint8Array(encBuf))

  const timestamp = '1700000000'
  const nonce = 'nonce_abc'
  const msg_signature = await sha1Hex([token, timestamp, nonce, encrypt].sort().join(''))

  const res = await verifyAndDecryptCallback({
    headers: { msg_signature, timestamp, nonce },
    body: { encrypt },
    aesKey,
    token,
  })
  assert.equal(res.ok, true)
  assert.deepEqual(res.plain, original)
})

test('verifyAndDecryptCallback 篡改签名返回 ok:false', async () => {
  const token = 'dt_token_xyz'
  const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32))
  const aesKey = bytesToB64(aesKeyBytes).replace(/=+$/, '')
  const iv = aesKeyBytes.slice(0, 16)
  const cryptoKey = await crypto.subtle.importKey('raw', aesKeyBytes, 'AES-CBC', false, ['encrypt'])
  const total = new Uint8Array(20 + 4)
  crypto.getRandomValues(total.subarray(0, 16))
  const lenBuf = new Uint8Array(4)
  total.set(lenBuf, 16)
  total.set(new TextEncoder().encode('{}'), 20)
  const encBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, total)
  const encrypt = bytesToB64(new Uint8Array(encBuf))

  const res = await verifyAndDecryptCallback({
    headers: { msg_signature: 'deadbeef', timestamp: '1', nonce: '2' },
    body: { encrypt },
    aesKey,
    token,
  })
  assert.equal(res.ok, false)
  assert.equal(res.err, 'signature')
})

// ---------- createDingTalk 未配置 → not_configured ----------
test('createDingTalk 未配置时所有发送方法返回 not_configured', async () => {
  const dt = createDingTalk({}) // 无任何凭证
  assert.deepEqual(await dt.sendSingle('u1', 'hi'), { ok: false, err: 'not_configured' })
  assert.deepEqual(await dt.sendWorkNotice(['u1'], 'hi'), { ok: false, err: 'not_configured' })
  assert.deepEqual(await dt.createTodo('u1', { subject: 's' }), { ok: false, err: 'not_configured' })
  assert.deepEqual(await dt.broadcast('hi'), { ok: false, err: 'not_configured' })
  assert.equal(await dt.getToken(), null)
})

// ---------- buildBindReply ----------
test('buildBindReply 成功/失败文案', () => {
  const ok = buildBindReply('123456', { nick: '小明' }, true)
  assert.match(ok, /绑定成功/)
  assert.ok(!ok.includes('123456'), '不在通知里暴露钉钉身份')
  assert.match(ok, /小明/)
  const fail = buildBindReply('999999', { nick: '小红' }, false)
  assert.match(fail, /绑定失败/)
  assert.ok(!fail.includes('999999'), '失败文案也不暴露钉钉身份')
})

// ---------- buildStatusReply ----------
test('buildStatusReply 文案形如「当前空闲：1F 2台 / 2F 1台 / 3F 0台（更新于 13:45）」', () => {
  const board = {
    buildingId: 'b1',
    buildingName: '1栋',
    updatedAt: '2026-10-18T13:45:00+08:00',
    total: 3,
    idle: 3,
    occupied: 0,
    floors: [
      { code: '1F', machines: [{ state: 'idle' }, { state: 'idle' }] },
      { code: '2F', machines: [{ state: 'idle' }] },
      { code: '3F', machines: [{ state: 'occupied' }] },
    ],
  }
  const r = buildStatusReply(board)
  assert.match(r, /^当前空闲：/)
  assert.match(r, /1F 2台/)
  assert.match(r, /2F 1台/)
  assert.match(r, /3F 0台/)
  assert.match(r, /更新于 13:45/)
})
