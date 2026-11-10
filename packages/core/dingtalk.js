// Edge runtimes need not implement AbortSignal.timeout. Keep one cancellable
// deadline through response-body consumption and release it on every outcome.
const responseDiagnostics = new WeakMap()
export function dingTalkResponseDiagnostics(response) {
  return responseDiagnostics.get(response) || { contentType:'missing',contentEncoding:'other',bodyBytes:0,bodyChunkType:'empty' }
}
export async function boundedDingTalkFetch(url, options = {}) {
  const controller = new AbortController()
  const external = options.signal
  const cancel = () => controller.abort()
  let timedOut = false
  if (external?.aborted) cancel()
  else external?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 8000)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const reader = response.body?.getReader(), chunks = []
    let size = 0,bodyChunkType='empty'
    if (reader) while (true) {
      const part = await reader.read()
      if (part.done) break
      const chunkType=typeof part.value==='string'?'string':part.value instanceof ArrayBuffer?'arraybuffer':part.value instanceof Uint8Array?'uint8array':ArrayBuffer.isView(part.value)?'view':'other'
      bodyChunkType=bodyChunkType==='empty'?chunkType:bodyChunkType===chunkType?chunkType:'mixed'
      let chunk
      if(chunkType==='arraybuffer')chunk=new Uint8Array(part.value)
      else if(chunkType==='uint8array' || chunkType==='view')chunk=new Uint8Array(part.value.buffer,part.value.byteOffset,part.value.byteLength)
      else if(chunkType==='string' && part.value.length<=64*1024)chunk=new TextEncoder().encode(part.value)
      else {
        controller.abort()
        reader.cancel().catch(()=>{})
        throw new Error(chunkType==='string'?'DingTalk response too large':'DingTalk response has an unsupported chunk type')
      }
      size += chunk.byteLength
      if (size > 64 * 1024) {
        controller.abort()
        reader.cancel().catch(() => {})
        throw new Error('DingTalk response too large')
      }
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const headers = new Headers(response.headers)
    const type=(headers.get('content-type')||'').split(';')[0].trim().toLowerCase()
    const encoding=(headers.get('content-encoding')||'identity').trim().toLowerCase()
    const diagnostic={contentType:!type?'missing':type==='application/json'||type.endsWith('+json')?'json':type==='text/html'?'html':type.startsWith('text/')?'text':'other',contentEncoding:['gzip','deflate','br','identity'].includes(encoding)?encoding:'other',bodyBytes:size,bodyChunkType}
    headers.delete('content-length'); headers.delete('content-encoding')
    // EdgeOne documents ArrayBuffer as a body type; it need not accept a typed
    // array even though Node's Response constructor accepts Uint8Array.
    const result=new Response(reader ? bytes.buffer : null, { status: response.status, statusText: response.statusText, headers })
    responseDiagnostics.set(result,diagnostic)
    return result
  } catch (error) {
    if (timedOut) { const timeout = new Error('DingTalk request timed out'); timeout.name = 'TimeoutError'; throw timeout }
    throw error
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', cancel)
  }
}
const boundedFetch = boundedDingTalkFetch
// WeShirt · 钉钉通道（Agent DingTalk）
// ESM / 纯 JS / 零依赖，仅用全局 fetch、crypto、atob/btoa。
// 严格实现契约 docs/CONTRACTS.md §2.6。

import { warn, safeJson, safeErrorCategory } from './util.js'
import { hhmm } from './notice.js'

// ---------- 内部工具 ----------

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

async function hmacSha256Base64(key, msg) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg))
  return bytesToB64(new Uint8Array(sig))
}

function getHeader(headers, name) {
  if (!headers) return undefined
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase())
  return k ? headers[k] : undefined
}

// ---------- parseCommand ----------

/**
 * 从群消息文本解析指令。容错忽略 "@等衣"/"@机器人" 前缀与多余空格。
 * @param {string} text
 * @returns {{ cmd: 'bind'|'unbind'|'status'|'on'|'off'|'help'|null, arg: string|null }}
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return { cmd: null, arg: null }
  let t = text
    // 全角数字 → 半角（用户在中文输入法下很容易打出 １２３４５６）
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // 零宽字符
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    // 去掉 @提及前缀（钉钉群消息通常带 "@机器人 "）
    .replace(/^\s*@[^\s]+[\s:：]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // 绑定码：现行为 12 位「字母+数字」（31 个字符集，去掉 0/o/1/l/i 等易混字符）。
  // 兼容老格式：历史上发出去的是 6 位纯数字，还在有效期内的应当仍能用。
  const KEY_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/i
  const DIGIT6_RE = /^\d{6}$/
  const norm = (s) => s.replace(/\s+/g, '')

  // 裸码（不带「绑定」前缀）
  if (DIGIT6_RE.test(t)) return { cmd: 'bind', arg: t }
  if (KEY_RE.test(t)) return { cmd: 'bind', arg: t.toLowerCase() }

  // 「绑定 <码>」/「bind <码>」：两种格式都认
  const m = t.match(/^(?:绑定|bind)[\s:：,，、-]*([0-9a-z\s]+)$/i)
  if (m) {
    const v = norm(m[1])
    if (DIGIT6_RE.test(v)) return { cmd: 'bind', arg: v }
    if (KEY_RE.test(v)) return { cmd: 'bind', arg: v.toLowerCase() }
  }

  if (/^(解绑|unbind)/i.test(t)) return { cmd: 'unbind', arg: null }

  // 认领：群里回复开洗通知，正文可能是「认领 3」或「认领 D1」，
  // 也可能带着被引用的原文（里面有「3 号位」）。两种情况都认。
  const cm = t.match(/^(?:认领|claim)\s*([0-9]{1,3}|[dD][12])?/i)
  if (cm) return { cmd: 'claim', arg: cm[1] ? cm[1].toUpperCase() : null }

  // 已取：洗完通知下面直接回「已取」，把任务标成已完成
  if (/^(已取|取走|取到|取了|拿了|拿去|taken)/i.test(t)) return { cmd: 'taken', arg: null }
  if (/^(查|状态|status)/i.test(t)) return { cmd: 'status', arg: null }
  if (/^(提醒开|on)/i.test(t)) return { cmd: 'on', arg: null }
  if (/^(提醒关|off)/i.test(t)) return { cmd: 'off', arg: null }
  // 帮助：常见问号 / 「指令」「菜单」也算，用户不用记具体词
  if (/^(帮助|help|指令|菜单|\?|？)/i.test(t)) return { cmd: 'help', arg: null }

  return { cmd: null, arg: null }
}

// ---------- verifyAndDecryptCallback ----------

// 钉钉用的是 **32 字节分组**的 PKCS7 填充（padding 可能是 17~32 字节），
// 而 WebCrypto 的 AES-CBC 解密只接受 1~16 字节填充，遇到 31 会直接抛
// "operation-specific reason"。所以不能直接用 crypto.subtle.decrypt。
//
// 绕法：在密文末尾补一个我们自己造的块，让「最后一块」永远是合法填充。
//   设密文有 n 块，取最后一块 L。造明文块 X = 15×0x00 + 0x01（合法填充 1 字节），
//   算 tail = E_k(X ⊕ L)（用 AES-CBC 加密 X、IV = L，取输出第一块），
//   再解密 C || tail：前 n 块结果与原密文一致，最后一块是 X（填充合法），
//   WebCrypto 就不报错。丢掉尾块，再按 1~32 的规则自己去掉丁丁的填充。
async function aesCbcDecryptRaw(keyBytes, dataU8) {
  if (!dataU8.length || dataU8.length % 16 !== 0) throw new Error('bad_cipher_len')
  const nBlocks = dataU8.length / 16
  const iv = keyBytes.slice(0, 16)
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt'])

  const lastBlock = dataU8.slice((nBlocks - 1) * 16, nBlocks * 16)
  const crafted = new Uint8Array(16)
  crafted[15] = 0x01
  // encrypt 会自己再补一个填充块，这里只取第一块
  const encOut = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: lastBlock }, key, crafted)
  )
  const tailBlock = encOut.slice(0, 16)

  const withTail = new Uint8Array(dataU8.length + 16)
  withTail.set(dataU8, 0)
  withTail.set(tailBlock, dataU8.length)

  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, withTail))
  return plain.slice(0, dataU8.length) // 丢掉我们造的尾块
}

// 按钉钉规则（1~32 字节）手动去填充
function stripPkcs7(u8) {
  if (!u8.length) return u8
  const pad = u8[u8.length - 1]
  if (pad >= 1 && pad <= 32 && pad < u8.length) return u8.slice(0, u8.length - pad)
  return u8
}

/**
 * 钉钉回调安全：验签 + AES-256-CBC 解密。
 * @param {{ headers: object, body: string|object, aesKey: string, token: string }}
 * @returns {Promise<{ ok: boolean, plain?: object, err?: string }>}
 */
export async function verifyAndDecryptCallback({ headers, body, aesKey, token }) {
  try {
    // 兼容两种投递格式：JSON {"encrypt": "..."} 或 form-urlencoded encrypt=...
    const encryptRaw =
      typeof body === 'string'
        ? safeJson(body)?.encrypt || new URLSearchParams(body).get('encrypt')
        : body?.encrypt
    if (!encryptRaw) return { ok: false, err: 'missing_encrypt' }

    const timestamp = String(getHeader(headers, 'timestamp') ?? '')
    const nonce = String(getHeader(headers, 'nonce') ?? '')
    const msgSignature = String(getHeader(headers, 'msg_signature') ?? '')

    // 签名 = sha1(sort([token, timestamp, nonce, encrypt]).join(''))
    const arr = [token, timestamp, nonce, encryptRaw].sort()
    const sig = await sha1Hex(arr.join(''))
    if (sig !== msgSignature) return { ok: false, err: 'signature' }

    // 解密：key = base64decode(aesKey + '=')，iv = key 前 16 字节
    const keyBytes = b64ToBytes(aesKey + '=')
    if (keyBytes.length !== 32) return { ok: false, err: 'bad_key' }

    const pt = stripPkcs7(await aesCbcDecryptRaw(keyBytes, b64ToBytes(encryptRaw)))

    // 结构：16 字节随机数 + 4 字节大端 msg_len + msg + ownerKey
    if (pt.length < 20) return { ok: false, err: 'plain_short' }
    const msgLen = (pt[16] << 24) | (pt[17] << 16) | (pt[18] << 8) | pt[19]
    if (pt.length < 20 + msgLen) return { ok: false, err: 'plain_corrupt' }
    const msgBytes = pt.slice(20, 20 + msgLen)
    const msg = new TextDecoder().decode(msgBytes)
    const plain = JSON.parse(msg)
    return { ok: true, plain }
  } catch (e) {
    return { ok: false, err: 'decrypt_failed' }
  }
}

/**
 * 加密回包。钉钉「事件订阅 → HTTP 推送」在保存时会推一条校验请求，
 * 服务端必须返回 **加密后的 "success"**，否则控制台报
 * 「HTTP 请求结果校验返回字段值失败」。
 *
 * 结构（与解密对称）：16 字节随机数 + 4 字节大端 msg_len + msg + ownerKey
 * ownerKey 对「企业内部应用」就是 Client ID（= appKey）。
 */
export async function encryptReply(plainText, aesKey, ownerKey) {
  const keyBytes = b64ToBytes(aesKey + '=')
  if (keyBytes.length !== 32) throw new Error('bad aes key')
  const iv = keyBytes.slice(0, 16)
  const msgBytes = new TextEncoder().encode(plainText)
  const ownerBytes = new TextEncoder().encode(ownerKey || '')
  const n = msgBytes.length

  const buf = new Uint8Array(16 + 4 + n + ownerBytes.length)
  crypto.getRandomValues(buf.subarray(0, 16))
  buf[16] = (n >>> 24) & 0xff
  buf[17] = (n >>> 16) & 0xff
  buf[18] = (n >>> 8) & 0xff
  buf[19] = n & 0xff
  buf.set(msgBytes, 20)
  buf.set(ownerBytes, 20 + n)

  // 自己按「32 字节分组」补 PKCS7，让密文长度也是 32 的倍数，与钉钉自身产出一致。
  // 补完长度必为 16 的倍数，WebCrypto 会再加一个完整填充块（16 字节），
  // 而 CBC 里后续块不影响前面块的密文，所以直接把最后 16 字节截掉即可。
  const pad = 32 - (buf.length % 32) // 1..32
  const padded = new Uint8Array(buf.length + pad)
  padded.set(buf, 0)
  padded.fill(pad, buf.length)

  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt'])
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, padded))
  return bytesToB64(enc.slice(0, padded.length))
}

/**
 * 组装钉钉要求的加密回包 JSON。
 * @returns {Promise<{msg_signature:string,timeStamp:string,nonce:string,encrypt:string}>}
 */
export async function buildEncryptedResponse({
  plainText = 'success',
  aesKey,
  ownerKey,
  token,
  timestamp,
  nonce,
}) {
  const encrypt = await encryptReply(plainText, aesKey, ownerKey)
  const ts = String(timestamp ?? Date.now())
  const nc = String(nonce ?? 'weshirt')
  // 签名规则与请求一致：sha1(sort([token, timestamp, nonce, encrypt]).join(''))
  const arr = [String(token ?? ''), ts, nc, encrypt].sort()
  const msg_signature = await sha1Hex(arr.join(''))
  return { msg_signature, timeStamp: ts, nonce: nc, encrypt }
}

// ---------- createDingTalk ----------
// 两套接口分别缓存，缓存键同时包含应用 Key 与 Secret，避免换应用/轮换密钥串用。
// 活跃取票不被淘汰；满额时等待一个完成，再进入相同配置的去重检查。
const TOKEN_CACHE_LIMIT = 16
const legacyTokens = new Map()
const modernTokens = new Map()
function tokenExpiry(seconds, margin) {
  const value = Number(seconds)
  const lifetime = Number.isFinite(value) && value > 0 ? Math.min(value, 86400) : 7200
  return Date.now() + (lifetime - Math.min(margin, lifetime / 10)) * 1000
}
async function credentialToken(cache, key, load) {
  while (true) {
    const found = cache.get(key)
    if (found?.pending) return found.pending
    if (found?.token && Date.now() < found.expiresAt) {
      cache.delete(key); cache.set(key, found)
      return found.token
    }
    if (found) cache.delete(key)
    // 优先移除过期票据，然后按最近使用顺序移除一个非在途条目。
    for (const [entryKey, entry] of cache) if (!entry.pending && entry.expiresAt <= Date.now()) cache.delete(entryKey)
    if (cache.size >= TOKEN_CACHE_LIMIT) {
      const oldest = [...cache].find(([, entry]) => !entry.pending)
      if (oldest) cache.delete(oldest[0])
      else { await Promise.race([...cache.values()].map((entry) => entry.pending.catch(() => null))); continue }
    }
    const entry = { token: null, expiresAt: 0, pending: null }
    entry.pending = Promise.resolve().then(load).then((result) => {
      if (typeof result?.token === 'string' && result.token && Number.isFinite(result.expiresAt) && result.expiresAt > Date.now()) {
        entry.token = result.token; entry.expiresAt = result.expiresAt
      }
      return typeof result?.token === 'string' && result.token ? result.token : null
    }).finally(() => {
      entry.pending = null
      if (!entry.token && cache.get(key) === entry) cache.delete(key)
    })
    cache.set(key, entry)
    return entry.pending
  }
}
let _warnedNotConfigured = false

function notCfg(what) {
  if (!_warnedNotConfigured) {
    _warnedNotConfigured = true
    warn('DingTalk: 必要凭证未配置，发送被跳过（not_configured）' + (what ? '：' + what : ''))
  }
  return { ok: false, err: 'not_configured' }
}

/**
 * 创建钉钉通道客户端。
 * @param {object} env 环境变量（DINGTALK_*）
 */
export function createDingTalk(env = {}) {
  // 一次客户端调用使用一份完整配置，调用方后续修改原对象不会改变已选缓存键。
  env = { ...env }
  // Dashboard/env pastes can contain a trailing newline. Use the same normalized
  // credentials for both the OAuth client and the application-token cache.
  for (const key of ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET']) env[key] = typeof env[key] === 'string' ? env[key].trim() : ''
  const credentialKey = JSON.stringify([env.DINGTALK_APP_KEY || '', env.DINGTALK_APP_SECRET || ''])
  // 按能力分别判定，不要「一个都不能少」：
  //   机器人单聊只要 appKey/appSecret/robotCode；工作通知才需要 agentId；
  //   待办只要 appKey/appSecret。之前统一用 hasMain（含 agentId）做闸门，
  //   导致没配 agentId 时连机器人单聊都被判成 not_configured。
  const hasBase = Boolean(env.DINGTALK_APP_KEY && env.DINGTALK_APP_SECRET)
  const canRobot = hasBase && Boolean(env.DINGTALK_ROBOT_CODE)
  const canWorkNotice = hasBase && Boolean(env.DINGTALK_AGENT_ID)

  // 旧版 token：注意 **必须用 GET**。用 POST 调 gettoken 会返回
  // errcode=43001 "Require GET request"，之前这里写成 POST，等于永远拿不到 token。
  async function getToken() {
    if (!hasBase) return null
    return credentialToken(legacyTokens, credentialKey, async () => {
      const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(
        env.DINGTALK_APP_KEY
      )}&appsecret=${encodeURIComponent(env.DINGTALK_APP_SECRET)}`
      try {
        const r = await boundedFetch(url, { method: 'GET' })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.errcode !== 0 || typeof j.access_token !== 'string' || !j.access_token) {
          // 远端错误正文可能回显凭据，不写日志。
          warn('DingTalk gettoken failed:', r.status)
          return null
        }
        return { token: j.access_token, expiresAt: tokenExpiry(j.expires_in, 200) }
      } catch {
        warn('DingTalk gettoken request failed')
        return null
      }
    })
  }

  // 新版 token（api.dingtalk.com/v1.0/* 用）。拿不到就回退旧 token —— 两者在多数
  // 场景可互用，回退只为容错。
  async function getNewToken() {
    if (!hasBase) return null
    return credentialToken(modernTokens, credentialKey, async () => {
      try {
      const r = await boundedFetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appKey: env.DINGTALK_APP_KEY,
          appSecret: env.DINGTALK_APP_SECRET,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && typeof j.accessToken === 'string' && j.accessToken) {
        return { token: j.accessToken, expiresAt: tokenExpiry(j.expireIn, 300) }
      }
      warn('DingTalk oauth2/accessToken failed:', r.status)
      } catch {
        warn('DingTalk oauth2/accessToken request failed')
      }
      // 回退 token 仅由旧接口缓存；失败结果不会把新接口缓存锁死。
      return { token: await getToken(), expiresAt: 0 }
    })
  }

  /**
   * 机器人单聊发消息。
   *
   * 参数可以是字符串（纯文本，兼容老调用），也可以是
   * `{ title, markdown, text }` —— 有 markdown 就用钉钉卡片样式发，
   * 发失败自动降级成纯文本再试一次。
   *
   * 为什么要降级：`sampleMarkdown` 不是所有租户/机器人版本都放行，
   * 一旦不支持，用户就完全收不到提醒。宁可丑一点，也不能不发。
   */
  async function sendSingle(userId, content) {
    if (!canRobot) return notCfg('DINGTALK_ROBOT_CODE')
    const token = await getNewToken()
    if (!token) return { ok: false, err: 'token' }

    const rich = content && typeof content === 'object'
    const hasMd = Boolean(rich && content.markdown)
    const plainText = rich ? String(content.text || '') : String(content == null ? '' : content)

    const post = async (msgKey, msgParam) => {
      const r = await boundedFetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({
          robotCode: env.DINGTALK_ROBOT_CODE,
          userIds: [userId],
          msgKey,
          msgParam: JSON.stringify(msgParam),
        }),
      })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        warn('DingTalk batchSend failed:', r.status)
        return { ok: false, err: `http_${r.status}` }
      }
      return { ok: true }
    }

    if (hasMd) {
      const r = await post('sampleMarkdown', {
        title: String(content.title || '等衣提醒'),
        text: content.markdown,
      })
      if (r.ok) return { ok: true, rich: true }
      // 富文本失败就退回纯文本，别让提醒彻底发不出去
      warn('markdown 发送失败，降级为纯文本')
    }
    return post('sampleText', { content: plainText })
  }

  async function sendWorkNotice(userIds, text) {
    if (!canWorkNotice) return notCfg('DINGTALK_AGENT_ID')
    const token = await getToken()
    if (!token) return { ok: false, err: 'token' }
    const url = `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(
      token
    )}`
    const r = await boundedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: env.DINGTALK_AGENT_ID,
        userid_list: (userIds || []).join(','),
        msg: { msgtype: 'text', text: { content: text } },
      }),
    })
    const j = await r.json().catch(() => ({}))
    if (j.errcode !== 0) return { ok: false, err: 'send_failed' }
    return { ok: true }
  }

  async function createTodo(userId, { subject, description, doneUrl } = {}) {
    if (!hasBase) return notCfg()
    const token = await getToken()
    if (!token) return { ok: false, err: 'token' }
    const url = `https://api.dingtalk.com/v1.0/todo/users/${encodeURIComponent(userId)}/tasks`
    const r = await boundedFetch(url, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        subject,
        description: description || '',
        detailUrl: doneUrl || '',
        executorIds: [userId],
        creatorId: userId,
      }),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      return { ok: false, err: `http_${r.status}` }
    }
    const j = await r.json().catch(() => ({}))
    return { ok: true, taskId: j.id || j.taskId || undefined }
  }

  // Markdown 播报：自定义机器人支持 msgtype=markdown。
  // 群消息用它比纯文本好看得多（有标题、加粗、分块），群里也更容易一眼扫到。
  async function broadcastMarkdown(title, text, opts = {}) {
    const webhook = env.DINGTALK_WEBHOOK
    if (!webhook) return notCfg()
    let url = webhook
    const secret = env.DINGTALK_WEBHOOK_SECRET
    if (secret) {
      const timestamp = Date.now()
      const sign = await hmacSha256Base64(secret, `${timestamp}\n${secret}`)
      url = `${webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }
    const payload = {
      msgtype: 'markdown',
      markdown: { title: String(title || '等衣').slice(0, 32), text: String(text || '') },
    }
    const atUserIds = (opts.atUserIds || []).filter(Boolean).slice(0, 20)
    if (atUserIds.length) payload.at = { atUserIds, isAtAll: false }

    const r = await boundedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const j = await r.json().catch(() => ({}))
    if (j.errcode !== 0 && j.status !== 0) return { ok: false, err: 'markdown_failed' }
    return { ok: true }
  }

  async function replyWebhook(sessionWebhook, text) {
    // 回调内的 sessionWebhook 免 token，无需 env 凭证
    if (!sessionWebhook) return { ok: false, err: 'missing_webhook' }
    // 安全：sessionWebhook 来自外部请求体，是**不可信输入**。
    // 不做白名单就直接 POST 等于把我们的服务端当跳板（SSRF，能探内网）。
    // 钉钉的会话 webhook 一定是 https + dingtalk.com 域名。
    try {
      const u = new URL(sessionWebhook)
      if (u.protocol !== 'https:' || !/(^|\.)dingtalk\.com$/i.test(u.hostname)) {
        return { ok: false, err: 'bad_webhook_host' }
      }
    } catch {
      return { ok: false, err: 'bad_webhook_url' }
    }
    // 群会话的回包带上 at 字段更稳；钉钉对缺字段有时会直接 400
    const payload = {
      msgtype: 'text',
      text: { content: text },
      at: { atUserIds: [], isAtAll: false },
    }
    const r = await boundedFetch(sessionWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      // 把钉钉的报错原文带出来，否则只有 http_400 完全没法排查
      const body = await r.text().catch(() => '')
      return { ok: false, err: `http_${r.status}` }
    }
    return { ok: true }
  }

  /**
   * 机器人主动发群消息（内部应用机器人，不需要自定义 webhook）。
   *
   * 为什么用这个而不是 webhook：
   * - webhook 要用户手动在群里建「自定义机器人」并贴地址，多一步配置；
   * - conversationId 在用户 @ 机器人时会随回调一起送上来，自动就能拿到。
   *
   * 官方限制：只能发到「机器人所在的群」，且需要 openConversationId。
   * 文档：POST /v1.0/robot/groupMessages/send
   */
  async function sendGroup(conversationId, text, { atUserIds = [], isAtAll = false } = {}) {
    if (!hasBase) return notCfg()
    if (!conversationId) return { ok: false, err: 'missing_conversation' }
    const token = await getToken()
    if (!token) return { ok: false, err: 'token' }
    try {
      const r = await boundedFetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          robotCode: env.DINGTALK_ROBOT_CODE || env.DINGTALK_APP_KEY,
          openConversationId: conversationId,
          // msgParam 必须是**字符串化的 JSON**（钉钉要求），不是对象
          msgParam: JSON.stringify({ content: String(text) }),
          msgKey: 'sampleText',
          atUserIds: Array.isArray(atUserIds) ? atUserIds.slice(0, 20) : [],
          atAll: Boolean(isAtAll),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, err: `http_${r.status}` }
      return { ok: true, processQueryKey: j.processQueryKey || '' }
    } catch (e) {
      return { ok: false, err: safeErrorCategory(e) }
    }
  }

  async function broadcast(text, opts = {}) {
    const webhook = env.DINGTALK_WEBHOOK
    if (!webhook) return notCfg()
    let url = webhook
    const secret = env.DINGTALK_WEBHOOK_SECRET
    if (secret) {
      const timestamp = Date.now()
      const sign = await hmacSha256Base64(secret, `${timestamp}\n${secret}`)
      url = `${webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }
    const payload = { msgtype: 'text', text: { content: text } }
    // @人：群机器人自定义机器人支持 atUserIds（传钉钉 userId）。
    // 注意 atUserIds 不会自动在正文里显示 @，正文自己带上名字才自然。
    const atUserIds = (opts.atUserIds || []).filter(Boolean).slice(0, 20)
    if (atUserIds.length) payload.at = { atUserIds, isAtAll: false }

    const r = await boundedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const j = await r.json().catch(() => ({}))
    if (j.errcode !== 0 && j.status !== 0) return { ok: false, err: 'broadcast_failed' }
    return { ok: true }
  }

  // 取钉钉用户资料（主要是头像）。需要应用有「通讯录个人信息读权限」。
  // 返回 { ok, avatar?, nick?, err? }
  async function getUserProfile(userId) {
    if (!hasBase) return notCfg()
    if (!userId) return { ok: false, err: 'missing_userid' }
    const token = await getToken()
    if (!token) return { ok: false, err: 'token' }
    const url = `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`
    const r = await boundedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userid: userId, language: 'zh_CN' }),
    })
    const j = await r.json().catch(() => ({}))
    if (j.errcode !== 0) return { ok: false, err: 'upstream_error' }
    const res = j.result || {}
    return {
      ok: true,
      avatar: res.avatar || '',
      nick: res.name || '',
      // 手机号需要「企业员工手机号信息」权限；没权限时字段不存在，返回空串
      mobile: res.mobile || '',
    }
  }

  // ---------- 扫码登录（OAuth）----------
  // 机器人回调里拿不到可用的 userId（群消息只有联合 ID），改由用户扫码授权拿身份。

  // 用 authCode 换「用户级」accessToken
  async function exchangeUserCode(code) {
    if (!hasBase) return { ok: false, err: 'not_configured', status: 0 }
    if (typeof code !== 'string' || !code || code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code)) return { ok: false, err: 'invalid_code', status: 0 }
    let status = 0, requestId
    try {
      const r = await boundedFetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: env.DINGTALK_APP_KEY,
          clientSecret: env.DINGTALK_APP_SECRET,
          code,
          grantType: 'authorization_code',
        }),
      })
      status = r.status
      // Only a UUID-shaped provider request ID is retained; never retain its
      // message/body, which can echo the authorization code or client secret.
      const safeRequestId = (value) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value) ? value : undefined
      requestId = safeRequestId(r.headers.get('x-acs-request-id'))
      // The shared helper has already bounded and normalized Edge's supported
      // string/ArrayBuffer/view chunks. Do not assume a second stream's type.
      const bytes = new Uint8Array(await r.arrayBuffer())
      if(bytes.byteLength>32*1024)return {ok:false,err:'invalid_response',status,...(requestId?{requestId}:{})}
      let j = null
      try { j = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* return a fixed category below */ }
      requestId ||= safeRequestId(j?.requestId)
      const providerCode = typeof j?.code === 'string' ? j.code.toLowerCase() : ''
      const businessError = j?.code != null && ![0, '0', 'OK', 'ok', 'Success'].includes(j.code)
      const validToken = typeof j?.accessToken === 'string' && j.accessToken.length > 0 && j.accessToken.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(j.accessToken)
      if (!r.ok || businessError || !validToken) {
        let err = status === 429 ? 'rate_limited' : status >= 500 ? 'upstream_unavailable' : status === 200 ? 'invalid_response' : 'upstream_rejected'
        if (/^(?:invalidparameter\.)?(?:authcode|code)(?:\.|$)/.test(providerCode) || /^(?:invalid_grant|invalidauthcode|authcodeexpired)$/.test(providerCode)) err = 'invalid_code'
        else if (/^(?:invalidparameter\.)?(?:clientid|clientsecret)(?:\.|$)/.test(providerCode) || /^(?:invalid_client|invalidclient|invalidclientsecret)$/.test(providerCode)) err = 'invalid_client'
        else if (/^(?:forbidden|accessdenied|permissiondenied)(?:\.|$)/.test(providerCode)) err = 'permission_denied'
        return { ok: false, err, status, ...(requestId ? { requestId } : {}) }
      }
      return { ok: true, accessToken: j.accessToken, corpId: j.corpId || '' }
    } catch (e) {
      return { ok: false, err: safeErrorCategory(e), status, ...(requestId ? { requestId } : {}) }
    }
  }

  // 用用户级 token 读「我」的资料（昵称、头像、unionId）
  async function fetchUserMe(userAccessToken) {
    try {
      const r = await boundedFetch('https://api.dingtalk.com/v1.0/contact/users/me', {
        headers: { 'x-acs-dingtalk-access-token': userAccessToken },
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, err: `http_${r.status}` }
      return {
        ok: true,
        unionId: j.unionId || '',
        openId: j.openId || '',
        nick: j.nick || '',
        avatarUrl: j.avatarUrl || '',
        mobile: j.mobile || '',
      }
    } catch (e) {
      return { ok: false, err: safeErrorCategory(e) }
    }
  }

  // unionId → userId（需要通讯录权限）
  async function getUserIdByUnionId(unionId) {
    if (!unionId) return { ok: false, err: 'missing_unionid' }
    const token = await getToken()
    if (!token) return { ok: false, err: 'token' }
    try {
      const r = await boundedFetch(
        `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unionid: unionId }),
        }
      )
      const j = await r.json().catch(() => ({}))
      if (j.errcode !== 0) return { ok: false, err: 'upstream_error' }
      return { ok: true, userId: (j.result && j.result.userid) || '' }
    } catch (e) {
      return { ok: false, err: safeErrorCategory(e) }
    }
  }

  // 手机号 → userId（备选，需要手机号读权限）
  async function getUserIdByMobile(mobile) {
    if (!mobile) return { ok: false, err: 'missing_mobile' }
    const token = await getToken()
    if (!token) return { ok: false, err: 'token' }
    try {
      const r = await boundedFetch(
        `https://oapi.dingtalk.com/topapi/v2/user/getbymobile?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mobile }),
        }
      )
      const j = await r.json().catch(() => ({}))
      if (j.errcode !== 0) return { ok: false, err: 'upstream_error' }
      return { ok: true, userId: (j.result && j.result.userid) || '' }
    } catch (e) {
      return { ok: false, err: safeErrorCategory(e) }
    }
  }

  return {
    getToken,
    getUserProfile,
    sendSingle,
    sendWorkNotice,
    createTodo,
    replyWebhook,
    broadcast,
    broadcastMarkdown,
    sendGroup,
    exchangeUserCode,
    fetchUserMe,
    getUserIdByUnionId,
    getUserIdByMobile,
  }
}

// ---------- 回复与文案 ----------

/** 任何没认出来的输入统一回这句，引导用户去看帮助 */
export const UNKNOWN_COMMAND_REPLY = '指令错误，请回复「帮助」查看帮助'

/**
 * 生成帮助文案。
 *
 * 为什么要区分模式：明文回调（机器人 HTTP 推送）没有签名，senderStaffId 可伪造，
 * 所以绑定/提醒开关这类写操作一律拒绝。帮助里就不能写这些命令，
 * 否则用户照着做只会收到「为安全起见…」的拒绝，等于骗人。
 *
 * @param {{plainMode?: boolean, host?: string}} opts
 */
export function buildHelpText({ plainMode = true, host = '' } = {}) {
  if (plainMode) {
    const lines = [
      '📖 等衣 · 可用指令',
      '',
      '查 —— 各楼层机器空闲情况',
      '帮助 —— 显示这条说明',
      '',
      '登记洗衣或烘干、确认已取、排队和提醒设置请打开网页。',
      '机器状态以现场为准；取衣提醒只发给本人，不在群里播报。',
    ]
    if (host) lines.push(String(host).replace(/[\r\n]+/g, '').slice(0, 200))
    return lines.join('\n')
  }
  return [
    '📖 等衣 · 可用指令',
    '',
    '查 —— 各楼层机器空闲情况',
    '认领 3 / 认领 D1 —— 按机器上贴的机位号登记',
    '已取 —— 确认自己已结束的待取任务',
    '提醒开 / 提醒关 —— 取衣提醒开关',
    '解绑 —— 解除本钉钉与账号的绑定',
    '帮助 —— 显示这条说明',
    '提醒只发给本人，不在群里播报；机器状态以现场为准。',
  ].join('\n')
}

// ---------- 回复文案 ----------

export function buildBindReply(staffId, user, ok) {
  const nick = String(user?.nick || '同学').replace(/[\r\n]+/g, ' ').slice(0, 32)
  if (ok) {
    return [
      '✅ 绑定成功',
      `${nick}，可在设置里检查提醒开关。`,
      '登记洗衣或烘干后，可接收自己的取衣提醒。',
      '可用指令：查 / 提醒开 / 提醒关 / 解绑 / 帮助',
    ].join('\n')
  }
  return '❌ 绑定失败：绑定码无效或已过期。请打开「等衣」，重新用钉钉登录。'
}

export function buildStatusReply(board, { at = Date.now() } = {}) {
  if (!board || !Array.isArray(board.floors) || board.floors.length === 0) {
    return '暂无状态数据。'
  }
  const parts = board.floors.map((f) => {
    const idle = (f.machines || []).filter((m) => m.state === 'idle').length
    return `${f.code} ${idle}台`
  })
  const clock = hhmm(board.updatedAt)
  const lines = [`当前空闲：${parts.join(' / ')}${clock ? `（更新于 ${clock}）` : ''}`]
  for (const floor of board.floors) {
    const machines = floor.machines || []
    const dryers = machines.filter((m) => m.kind === 'dryer' || (!m.kind && String(m.name || '').includes('烘干')))
    const washers = machines.filter((m) => !dryers.includes(m))
    const detail = []
    if (washers.length) detail.push(`洗衣机 ${washers.filter((m) => m.state === 'idle').length}/${washers.length} 空闲`)
    if (dryers.length) detail.push(`烘干机 ${dryers.filter((m) => m.state === 'idle').length}/${dryers.length} 空闲`)
    if (detail.length) lines.push(`${floor.code}：${detail.join('，')}`)
  }
  const updatedMs = board.updatedAt ? new Date(board.updatedAt).getTime() : NaN
  const age = Number.isFinite(updatedMs) ? Math.floor((at - updatedMs) / 60000) : NaN
  if (Number.isFinite(age) && age >= 3) lines.push(`数据已 ${age} 分钟未更新，请以现场为准。`)
  else if (!Number.isFinite(updatedMs)) lines.push('更新时间未知，请以现场为准。')
  return lines.join('\n')
}
