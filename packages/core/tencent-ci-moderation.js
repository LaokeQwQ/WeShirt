import { readStreamBytes } from './stream-bytes.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_RESPONSE = 128 * 1024
const MAX_AVATAR = 64 * 1024
const MAX_CALLBACK = 8 * 1024
const DECISIONS = new Map([['0', 'pass'], ['1', 'block'], ['2', 'review']])
const PENDING = new Set(['Submitted', 'Auditing'])
const JOB_ID = /^[a-zA-Z0-9_-]{12,96}$/
const DATA_ID = /^[a-zA-Z0-9_-]{1,96}$/
const OBJECT_KEY = /^moderation\/pending\/(?:image|text)\/[A-Za-z0-9_-]{12,96}\.(?:png|jpe?g|webp|gif|txt)$/
const STATIC_IMAGE = /^image\/(?:png|jpeg|webp|gif)$/
const fail = (code = 'moderation_unavailable', status = 503) =>
  Object.assign(new Error(code), { code, status })

const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
const unhex = value => Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16))
const sha1 = async value => hex(await crypto.subtle.digest('SHA-1', encoder.encode(value)))
const hmacKey = (secret, hash, usage) => crypto.subtle.importKey(
  'raw', encoder.encode(secret), { name: 'HMAC', hash }, false, [usage]
)
const hmac = async (secret, hash, input) => hex(await crypto.subtle.sign(
  'HMAC', await hmacKey(secret, hash, 'sign'), encoder.encode(input)
))
const pct = value => encodeURIComponent(value).replace(/[!'()*]/g, char =>
  '%' + char.charCodeAt(0).toString(16).toUpperCase()
)
const xmlText = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]
)
const element = (name, value) => '<' + name + '>' + xmlText(value) + '</' + name + '>'

function base64(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 4096)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096))
  return btoa(binary)
}

// COS v5 deliberately specifies HMAC-SHA1. The bridge uses HMAC-SHA256.
async function authorize({ id, secret, host, now, method, path, headers }) {
  const start = Math.floor(now / 1000)
  const span = (start - 5) + ';' + (start + 60)
  const signingKey = await hmac(secret, 'SHA-1', span)
  const values = [['host', host], ...Object.entries(headers)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const signedHeaders = values.map(([name, value]) => name + '=' + pct(value)).join('&')
  const requestHash = await sha1(method.toLowerCase() + '\n' + path + '\n\n' + signedHeaders + '\n')
  const signature = await hmac(signingKey, 'SHA-1', 'sha1\n' + span + '\n' + requestHash + '\n')
  return 'q-sign-algorithm=sha1&q-ak=' + id + '&q-sign-time=' + span + '&q-key-time=' + span +
    '&q-header-list=' + values.map(([name]) => name).join(';') + '&q-url-param-list=&q-signature=' + signature
}

// Read only top-level scalar fields. OCR/category subtrees themselves can contain
// Code and Result, so matching tags without their depth can approve the wrong job.
function readCiResponse(xml) {
  const stack = []
  const fields = Object.create(null)
  let requestId, jobs = 0, roots = 0, position = 0
  const tokens = /<\/?[A-Za-z][A-Za-z0-9_]*(?:\s*\/)?\s*>|<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'|"utf-8"|'utf-8'))?\s*\?>|<!\[CDATA\[[\s\S]*?\]\]>|[^<]+/gy
  for (let match; (match = tokens.exec(xml));) {
    const token = match[0]
    position = tokens.lastIndex
    if (token.startsWith('<?')) {
      if (stack.length || roots || match.index !== 0) throw fail()
    } else if (token.startsWith('<![CDATA[') || token[0] !== '<') {
      if (!stack.length && token.trim()) throw fail()
      const node = stack.at(-1)
      if (node?.value !== undefined) {
        if (token.startsWith('<!')) throw fail()
        node.value += token
      }
    } else if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim()
      const node = stack.pop()
      if (node?.name !== name) throw fail()
      if (node.value !== undefined && stack.length === 2) {
        if (Object.hasOwn(fields, name)) throw fail()
        fields[name] = node.value.trim()
      } else if (name === 'RequestId' && node.value !== undefined && stack.length === 1) {
        if (requestId !== undefined) throw fail()
        requestId = node.value.trim()
      }
    } else {
      const empty = /\/\s*>$/.test(token)
      const name = token.slice(1, -1).trim().replace(/\/$/, '').trim()
      if (!stack.length && (name !== 'Response' || ++roots !== 1 || empty)) throw fail()
      if (stack.length >= 32 || stack.at(-1)?.value !== undefined) throw fail()
      const job = stack.length === 1 && name === 'JobsDetail'
      if (job && (++jobs !== 1 || empty)) throw fail()
      const field = stack.length === 2 && stack[1].name === 'JobsDetail' &&
        ['Code', 'State', 'Result', 'JobId', 'DataId', 'Object'].includes(name)
      if (!empty) stack.push({ name, value: field || (stack.length === 1 && name === 'RequestId') ? '' : undefined })
      else if (field) {
        if (Object.hasOwn(fields, name)) throw fail()
        fields[name] = ''
      }
    }
  }
  if (position !== xml.length || stack.length || roots !== 1 || jobs !== 1) throw fail()
  return { fields, requestId: /^[A-Za-z0-9_+/=-]{1,128}$/.test(requestId || '') ? requestId : null }
}

function callbackUrl(raw) {
  let url
  try { url = new URL(raw) } catch { throw fail('moderation_invalid_request', 400) }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 1024)
    throw fail('moderation_invalid_request', 400)
  return url.href
}

function inputIdentity(kind, dataId, objectKey) {
  if (!['image', 'text'].includes(kind) || typeof dataId !== 'string' || !DATA_ID.test(dataId))
    throw fail('moderation_invalid_request', 400)
  if (objectKey !== undefined && !validObject(kind, objectKey)) throw fail('moderation_invalid_request', 400)
}

function validObject(kind, objectKey) {
  return typeof objectKey === 'string' && OBJECT_KEY.test(objectKey) &&
    objectKey.startsWith('moderation/pending/' + kind + '/') && objectKey.endsWith('.txt') === (kind === 'text')
}

function verifyJob(fields, dataId, objectKey, jobId) {
  if (fields.DataId !== dataId || (objectKey !== undefined && fields.Object !== objectKey) ||
    (jobId !== undefined && fields.JobId !== jobId) || !JOB_ID.test(fields.JobId || '')) throw fail()
  if (fields.Code && !['0', 'Success'].includes(fields.Code)) throw fail()
}

function decide(kind, payload, allowMissingState = false) {
  const { fields, requestId } = payload
  if ((!allowMissingState && fields.State !== 'Success') || (fields.State && fields.State !== 'Success') ||
    !DECISIONS.has(fields.Result)) throw fail()
  return { kind, jobId: fields.JobId, decision: DECISIONS.get(fields.Result), requestId }
}

/** CI provider used only by trusted server code. A missing credential cannot return a pass. */
export function createTencentCiModeration(env = {}, { fetcher = fetch, now = Date.now } = {}) {
  const { MODERATION_COS_BUCKET: bucket, MODERATION_COS_REGION: region, MODERATION_COS_SECRET_ID: id,
    MODERATION_COS_SECRET_KEY: secret, MODERATION_COS_SESSION_TOKEN: sessionToken,
    MODERATION_IMAGE_BIZ_TYPE: imageBiz, MODERATION_TEXT_BIZ_TYPE: textBiz } = env
  if (!/^[a-z0-9][a-z0-9-]{1,47}-[0-9]{5,24}$/.test(bucket || '') ||
    !/^(?:ap|na|eu|sa|me|af)-[a-z0-9]{2,24}$/.test(region || '') ||
    !/^[A-Za-z0-9]{12,128}$/.test(id || '') || !/^[A-Za-z0-9+/=_-]{12,128}$/.test(secret || '') ||
    (sessionToken && !/^[\x21-\x7e]{1,4096}$/.test(sessionToken)) ||
    [imageBiz, textBiz].some(value => value && !/^[A-Za-z0-9_-]{1,96}$/.test(value))) return null

  const host = bucket + '.ci.' + region + '.myqcloud.com'
  async function request(method, path, body) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const headers = { authorization: await authorize({ id, secret, host, now: now(), method, path, headers: {} }) }
      if (body) headers['content-type'] = 'application/xml'
      if (sessionToken) headers['x-cos-security-token'] = sessionToken
      const response = await fetcher('https://' + host + path,
        { method, headers, body, redirect: 'error', signal: controller.signal })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw fail()
      }
      const bytes = await readStreamBytes(response.body, MAX_RESPONSE)
      if (!bytes || !bytes.length) throw fail()
      return readCiResponse(decoder.decode(bytes))
    } catch { throw fail() }
    finally { clearTimeout(timeout) }
  }

  function xmlRequest(kind, input, options = '') {
    const biz = kind === 'image' ? imageBiz : textBiz
    return '<Request><Input>' + input + '</Input><Conf>' + (biz ? element('BizType', biz) : '') +
      options + '</Conf></Request>'
  }

  async function check(kind, bytes, dataId) {
    inputIdentity(kind, dataId)
    const input = element('Content', base64(bytes)) + element('DataId', dataId)
    const payload = await request('POST', '/' + kind + '/auditing', xmlRequest(kind, input))
    verifyJob(payload.fields, dataId)
    // Synchronous image batches return Result without a State on a successful row.
    return decide(kind, payload, kind === 'image')
  }

  return {
    async stage({ kind, objectKey, mime, bytes }) {
      if (!validObject(kind, objectKey) || !(bytes instanceof Uint8Array) || !bytes.length ||
        bytes.length > MAX_AVATAR || (kind === 'image' ? !STATIC_IMAGE.test(mime) : mime !== 'text/plain; charset=utf-8'))
        throw fail('moderation_invalid_request', 400)
      const cosHost = bucket + '.cos.' + region + '.myqcloud.com'
      const path = '/' + objectKey
      const signed = { 'content-type': mime, 'x-cos-acl': 'private', 'x-cos-forbid-overwrite': 'true' }
      const headers = { ...signed,
        authorization: await authorize({ id, secret, host: cosHost, now: now(), method: 'PUT', path, headers: signed }) }
      if (sessionToken) headers['x-cos-security-token'] = sessionToken
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetcher('https://' + cosHost + path,
          { method: 'PUT', headers, body: bytes, redirect: 'error', signal: controller.signal })
        await response.body?.cancel().catch(() => {})
        if (!response.ok) throw fail()
      } catch { throw fail() }
      finally { clearTimeout(timeout) }
    },
    async checkText({ text, dataId }) {
      if (typeof text !== 'string' || !text.trim() || text.length > 1024)
        throw fail('moderation_invalid_request', 400)
      return check('text', encoder.encode(text), dataId)
    },
    async checkImage({ mime, bytes, dataId }) {
      if (!STATIC_IMAGE.test(mime) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_AVATAR)
        throw fail('moderation_invalid_request', 400)
      return check('image', bytes, dataId)
    },
    async submit({ kind, objectKey, dataId, callbackUrl: callback }) {
      if (!validObject(kind, objectKey)) throw fail('moderation_invalid_request', 400)
      inputIdentity(kind, dataId, objectKey)
      const input = element('Object', objectKey) + element('DataId', dataId)
      const options = element('Callback', callbackUrl(callback)) + (kind === 'image' ?
        '<Async>1</Async>' : '<CallbackVersion>Detail</CallbackVersion><CallbackType>1</CallbackType>')
      const payload = await request('POST', '/' + kind + '/auditing', xmlRequest(kind, input, options))
      verifyJob(payload.fields, dataId, objectKey)
      if (!PENDING.has(payload.fields.State) && payload.fields.State !== 'Success') throw fail()
      return { kind, jobId: payload.fields.JobId, decision: 'pending', requestId: payload.requestId }
    },
    async getResult({ kind, jobId, dataId, objectKey }) {
      if (!validObject(kind, objectKey) || typeof jobId !== 'string' || !JOB_ID.test(jobId))
        throw fail('moderation_invalid_request', 400)
      inputIdentity(kind, dataId, objectKey)
      const payload = await request('GET', '/' + kind + '/auditing/' + jobId)
      verifyJob(payload.fields, dataId, objectKey, jobId)
      if (PENDING.has(payload.fields.State)) return { kind, jobId, decision: 'pending', requestId: payload.requestId }
      return decide(kind, payload)
    }
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const canonicalSignal = (timestamp, body) => encoder.encode('weshirt-moderation-v1\n' + timestamp + '\n' + body)
const secretOK = secret => typeof secret === 'string' && /^[\x21-\x7e]{32,128}$/.test(secret)

export async function createModerationCallbackToken(secret, dataId, objectKey) {
  if (!secretOK(secret) || !DATA_ID.test(dataId) || !OBJECT_KEY.test(objectKey)) return null
  return hmac(secret, 'SHA-256', 'weshirt-moderation-callback-v1\n' + dataId + '\n' + objectKey)
}

/**
 * CI Detail callbacks only identify jobs. Ignore their decision and fetch the
 * actual outcome for the previously saved correlation from CI.
 */
export function parseTencentCiCallback(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RESPONSE || encoder.encode(raw).length > MAX_RESPONSE) return null
  let body
  try { body = JSON.parse(raw) } catch { return null }
  const kind = body?.EventName === 'ReviewImage' ? 'image' : body?.EventName === 'ReviewText' ? 'text' : null
  const job = body?.JobsDetail
  if (!kind || !isRecord(job) || typeof job.JobId !== 'string' || !JOB_ID.test(job.JobId) ||
    typeof job.DataId !== 'string' || !DATA_ID.test(job.DataId) || !validObject(kind, job.Object)) return null
  return { kind, jobId: job.JobId, dataId: job.DataId, objectKey: job.Object }
}

/** HMAC headers for a private CloudBase-to-Edge bridge, not a Tencent CI signature. */
export async function signModerationSignal(secret, body, now = Date.now()) {
  if (!secretOK(secret) || typeof body !== 'string' || encoder.encode(body).length > MAX_CALLBACK)
    throw fail('moderation_invalid_signal', 400)
  const timestamp = String(Math.floor(now / 1000))
  const signature = hex(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'SHA-256', 'sign'),
    canonicalSignal(timestamp, body)))
  return { 'x-weshirt-moderation-time': timestamp, 'x-weshirt-moderation-signature': signature }
}

export async function verifyModerationSignal(secret, body, headers, now = Date.now()) {
  if (!secretOK(secret) || typeof body !== 'string' || body.length > MAX_CALLBACK ||
    encoder.encode(body).length > MAX_CALLBACK) return false
  const timestamp = headers.get('x-weshirt-moderation-time') || ''
  const signature = headers.get('x-weshirt-moderation-signature') || ''
  if (!/^[0-9]{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 120) return false
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'SHA-256', 'verify'),
    unhex(signature), canonicalSignal(timestamp, body))
}
