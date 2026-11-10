import { mobileDigest, MobileError } from './mobile-auth.js'
import { readStreamBytes } from './stream-bytes.js'
import { createRemoteMobileAtomicStore } from './mobile-store.js'
import { DORM_BUILDINGS } from './buildings.js'
import { getUserPermissions } from './permissions.js'
import { readQueueNotices } from './queue-reminders.js'

const enc = new TextEncoder(), DAY = 86400000
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fail = (code = 'mobile_push_unavailable', status = 503) => { throw new MobileError(code, '原生推送暂不可用，请稍后重试', status) }
const clean = (value, length) => Array.from(String(value || '').replace(/[\p{Cc}\u200B\u202A-\u202E\u2066-\u2069]/gu, ' ')).slice(0, length).join('')
const atomicReady = store => store?.consistency === 'linearizable' && store?.durable === true
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)

// RFC 1321, only for U-Push's mandated request checksum; never password hashing.
export function umengMD5(value) {
  const input = enc.encode(value), size = Math.ceil((input.length + 9) / 64) * 64, bytes = new Uint8Array(size)
  bytes.set(input); bytes[input.length] = 128
  const view = new DataView(bytes.buffer); view.setUint32(size - 8, input.length * 8, true); view.setUint32(size - 4, Math.floor(input.length / 536870912), true)
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476
  const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21]
  for (let block = 0; block < size; block += 64) {
    let aa = a, bb = b, cc = c, dd = d
    for (let i = 0; i < 64; i++) {
      const round = i >>> 4, f = round === 0 ? (bb & cc) | (~bb & dd) : round === 1 ? (dd & bb) | (~dd & cc) : round === 2 ? bb ^ cc ^ dd : cc ^ (bb | ~dd)
      const word = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16
      const sum = (aa + f + Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) + view.getUint32(block + word * 4, true)) | 0, shift = shifts[round * 4 + i % 4]
      aa = dd; dd = cc; cc = bb; bb = (bb + ((sum << shift) | (sum >>> (32 - shift)))) | 0
    }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0
  }
  return [a,b,c,d].flatMap(word => [0,8,16,24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0'))).join('')
}

async function jsonFetch(fetcher, url, options) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: controller.signal })
    const bytes = await readStreamBytes(response.body, 32768)
    if (!bytes) return { status: response.status, body: null }
    let body; try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { body = null }
    return { status: response.status, body }
  } catch { return { status: 0, body: null } } finally { clearTimeout(timer) }
}

export function createMobilePushTransports(env = {}, { fetcher = fetch, now = Date.now } = {}) {
  let fcm
  try {
    const value = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON || '{}')
    if (value.type === 'service_account' && /^[a-z][a-z0-9-]{4,62}$/.test(value.project_id) && /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(value.client_email) && typeof value.private_key === 'string' && value.private_key.includes('BEGIN PRIVATE KEY')) fcm = value
  } catch { /* invalid private environment config remains disabled */ }
  const upush = /^[A-Za-z0-9]{16,80}$/.test(env.UMENG_PUSH_APP_KEY || '') && /^[A-Za-z0-9]{16,128}$/.test(env.UMENG_PUSH_MASTER_SECRET || '')
  let oauth = null, oauthFlight = null
  async function oauthToken() {
    if (oauth && oauth.expiresAt > now() + 60000) return oauth.token
    if (oauthFlight) return oauthFlight
    oauthFlight = (async () => {
      const seconds = Math.floor(now() / 1000), header = b64(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))), claims = b64(enc.encode(JSON.stringify({ iss: fcm.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: seconds, exp: seconds + 3600 })))
      const pem = fcm.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')
      const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), value => value.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
      const jwt = header + '.' + claims, signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(jwt))
      const result = await jsonFetch(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt + '.' + b64(new Uint8Array(signature)) }).toString() })
      if (result.status !== 200 || typeof result.body?.access_token !== 'string' || !result.body.access_token || result.body.access_token.length > 8192) throw new Error('oauth_unavailable')
      oauth = { token: result.body.access_token, expiresAt: now() + Math.min(3600, Math.max(60, Number(result.body.expires_in) || 3600)) * 1000 }
      return oauth.token
    })().finally(() => { oauthFlight = null })
    return oauthFlight
  }
  const transports = {}
  if (fcm) transports.fcm = async (token, data) => {
    try {
      const accessToken = await oauthToken()
      const result = await jsonFetch(fetcher, `https://fcm.googleapis.com/v1/projects/${fcm.project_id}/messages:send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken }, body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '3600s', collapse_key: data.eventId, restricted_package_name: 'com.laoke.weshirt' } } }) })
      const code = (result.body?.error?.details || []).find(value => value['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode
      if (result.status === 401) oauth = null
      return { ok: result.status === 200 && typeof result.body?.name === 'string', gone: code === 'UNREGISTERED', code: code === 'UNREGISTERED' ? 'unregistered' : result.status === 429 ? 'rate_limited' : 'provider_rejected' }
    } catch { return { ok: false, gone: false, code: 'provider_unavailable' } }
  }
  if (upush) transports.upush = async (token, data) => {
    const url = 'https://msgapi.umeng.com/api/send'
    const payload = { display_type: 'message', body: { custom: data } }
    // Optional official custom-message -> OEM notification conversion. The
    // U-Push SDK handles OEM clicks; channel_activity must be registered there.
    if (env.UMENG_PUSH_OEM_NOTIFICATIONS === 'true') payload.message_3rd_notification = { title: data.title, text: data.body }
    const request = { appkey: env.UMENG_PUSH_APP_KEY, timestamp: String(now()), type: 'unicast', device_tokens: token, payload, production_mode: env.UMENG_PUSH_PRODUCTION === 'false' ? 'false' : 'true', category: 1 }
    if (env.UMENG_PUSH_OEM_NOTIFICATIONS === 'true') request.channel_properties = { channel_activity: 'com.laoke.weshirt.MainActivity', channel_fcm: '0', ...(env.UMENG_PUSH_XIAOMI_CHANNEL_ID ? { xiaomi_channel_id: clean(env.UMENG_PUSH_XIAOMI_CHANNEL_ID, 80) } : {}), ...(env.UMENG_PUSH_OPPO_CHANNEL_ID ? { oppo_channel_id: clean(env.UMENG_PUSH_OPPO_CHANNEL_ID, 80) } : {}) }
    const body = JSON.stringify(request), signature = umengMD5('POST' + url + body + env.UMENG_PUSH_MASTER_SECRET)
    const result = await jsonFetch(fetcher, url + '?sign=' + signature, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    // Generic INVALID_ARGUMENT is not proof of uninstall; never delete a token
    // for malformed credentials/payloads. Only FCM UNREGISTERED auto-removes.
    return { ok: result.status === 200 && result.body?.ret === 'SUCCESS', gone: false, code: result.status === 429 ? 'rate_limited' : 'provider_rejected' }
  }
  return transports
}

export async function mobileNoticeData(notice = {}) {
  const kind = notice.nativeKind || (notice.type === 'mention' ? 'CHAT_MENTION' : notice.type === 'queue' ? notice.phase !== 'end' ? 'QUEUE_THREE_MINUTES' : notice.confirmed ? 'TASK_FINISHED' : 'ESTIMATED_END' : notice.type === 'pickup' ? 'PICKUP_REQUEST' : notice.type === 'announcement' ? 'ANNOUNCEMENT' : notice.confirmed ? 'TASK_FINISHED' : 'ESTIMATED_END')
  // Server-supplied stable references avoid a new event ID on every retry.
  const reference = notice.eventId || notice.noticeId || notice.nativeEventKey || notice.tag || [kind, notice.taskId, notice.machineId, notice.finishAt, notice.title, notice.text].join('|')
  const eventId = 'push_' + (await mobileDigest(String(reference))).slice(0, 32)
  const finishAt = typeof notice.finishAt === 'string' && Number.isFinite(Date.parse(notice.finishAt)) ? new Date(notice.finishAt).toISOString() : ''
  const taskId = idOK(notice.taskId) ? notice.taskId : notice.type === 'queue' && idOK(notice.reservationId) ? 'queue:' + notice.reservationId : ''
  return { eventId, revision: String(Math.max(1, Number.isSafeInteger(notice.revision) ? notice.revision : 1)), kind, title: clean(notice.title || 'WeShirt 提醒', 48), body: clean(notice.text || notice.body || '打开应用查看最新状态', 120), taskId, finishAt, serverConfirmed: notice.confirmed === true ? 'true' : 'false' }
}

/** Durable per-user outbox; provider success is independent from DingTalk. */
export function createMobilePush({ store, env = {}, atomicStore = createRemoteMobileAtomicStore(env), transports = createMobilePushTransports(env), now = Date.now } = {}) {
  const enabled = env.MOBILE_PUSH_ENABLED === 'true' && atomicReady(atomicStore)
  const providers = enabled ? Object.keys(transports).filter(value => ['fcm', 'upush'].includes(value)) : []
  const expiresAt = () => now() + 90 * DAY
  async function update(key, edit) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await atomicStore.get(key), next = await edit(structuredClone(row?.value || {}))
      if (next === null) return row?.value
      if (await atomicStore.compareAndSet(key, row?.version ?? null, next, { expiresAt: expiresAt() })) return next
    }
    fail('mobile_push_conflict', 409)
  }
  const userKey = uid => 'mobile:installation-index:' + uid
  async function rememberUser(uid) {
    await update('mobile:push-users:global', async value => {
      let users = Array.isArray(value.users) ? value.users : []
      if (!users.includes(uid) && users.length >= 1000) {
        const offset = (Number(value.cursor) || 0) % users.length
        const selected = [...users.slice(offset), ...users.slice(0, offset)].slice(0, 32)
        const active = await Promise.all(selected.map(async id => (await atomicStore.get(userKey(id)))?.value.installations?.length ? id : null))
        const inactive = new Set(selected.filter(id => !active.includes(id)))
        users = users.filter(id => !inactive.has(id))
      }
      if (!users.includes(uid) && users.length >= 1000) fail('mobile_push_capacity', 503)
      return { ...value, users: users.includes(uid) ? users : [...users, uid] }
    })
  }
  async function register(uid, installationId, sessionId = null) {
    if (!atomicReady(atomicStore) || !idOK(uid) || !idOK(installationId)) fail()
    await update(userKey(uid), value => {
      const ids = Array.isArray(value.installations) ? value.installations : []
      if (!ids.includes(installationId) && ids.length >= 5) fail('installation_limit', 409)
      return { ...value, installations: ids.includes(installationId) ? ids : [...ids, installationId], owners: { ...value.owners, [installationId]: sessionId } }
    })
    // Publish the user's index before inserting into the scheduler. Always CAS
    // the scheduler even for an existing user, so concurrent pruning retries.
    await rememberUser(uid)
  }
  async function remove(uid, installationId, sessionId) {
    if (!atomicReady(atomicStore)) return
    await update(userKey(uid), value => {
      if (sessionId && value.owners?.[installationId] && value.owners[installationId] !== sessionId) return null
      const owners = { ...value.owners }; delete owners[installationId]
      return { ...value, owners, installations: (value.installations || []).filter(id => id !== installationId), outbox: (value.outbox || []).map(event => ({ ...event, deliveries: { ...event.deliveries, [installationId]: { state: 'suppressed' } } })) }
    })
  }
  async function validUser(uid) {
    const user = await store.get('user:' + uid, null)
    return user && !user.disabled && !user.blocked && user.notifyOn !== false
  }
  async function allowedNotice(uid, policy = {}) {
    const user = await store.get('user:' + uid, null)
    if (!user || user.disabled || user.blocked || user.notifyOn === false) return false
    if (policy.channel) {
      const site = await store.get('meta:site', {}), buildings = site.buildings || DORM_BUILDINGS, access = await getUserPermissions(store,user,buildings)
      if (!access.permissions.messages.view || access.permissions.messages.viewBuildings !== null && !access.permissions.messages.viewBuildings.includes(policy.channel) || !['super','admin'].includes(access.identity.role) && !['public',user.dormBuilding].includes(policy.channel) || policy.channel !== 'public' && !buildings.some(building=>building.code===policy.channel&&building.enabled!==false)) return false
      if (policy.noticeId) {
        const notice = (await store.get('community-notices:'+uid, [])).find(row=>row.id===policy.noticeId)
        const messages = await store.get('messages:'+(env.BUILDING_ID||'b1'), [])
        if (!notice || !messages.some(message=>message.id===notice.messageId&&message.channel===policy.channel&&!message.deleted)) return false
      }
    }
    if (policy.queueNoticeId) {
      const notice=(await readQueueNotices(store,uid)).find(notice=>notice.id===policy.queueNoticeId&&notice.active)
      if(!notice)return false
      if(notice.phase!=='end'&&(!Number.isFinite(Date.parse(notice.finishAt))||Date.parse(notice.finishAt)<=now()||Date.parse(notice.finishAt)>now()+3*60000))return false
    }
    if (policy.taskId && !(await store.get('tasks:'+uid, [])).some(task=>task.id===policy.taskId&&!task.done&&!task.takenAt)) return false
    if(policy.queueNoticeId||policy.taskId){
      const site=await store.get('meta:site',{}),buildings=site.buildings||DORM_BUILDINGS,access=await getUserPermissions(store,user,buildings),permission=access.permissions[policy.queueNoticeId?'queue':'tasks']
      if(!permission.view||permission.viewBuildings!==null&&!permission.viewBuildings.includes(user.dormBuilding)||buildings.some(building=>building.code===user.dormBuilding&&building.enabled===false))return false
    }
    return true
  }
  async function deliver(uid, budget = 1) {
    if (!providers.length) return { sent: 0 }
    if (!await validUser(uid)) {
      if (await atomicStore.get(userKey(uid))) await update(userKey(uid), value => ({ ...value, outbox: (value.outbox || []).map(event => ({ ...event, deliveries: Object.fromEntries(Object.keys(event.deliveries || {}).map(id => [id, { state: 'suppressed' }])) })) }))
      return { sent: 0 }
    }
    const initial = await atomicStore.get(userKey(uid)); let sent = 0, attempts = 0
    for (const event of initial?.value.outbox || []) {
      if (event.expiresAt <= now()) continue
      for (const installationId of Object.keys(event.deliveries || {})) {
        if (attempts >= budget) return { sent }
        const snapshot = event.deliveries[installationId]
        if (['sent', 'suppressed', 'failed'].includes(snapshot.state) || snapshot.attempts >= 4 || snapshot.nextAt > now() || snapshot.leaseUntil > now()) continue
        const lease = crypto.randomUUID()
        let claimed = false
        await update(userKey(uid), value => {
          claimed = false
          const target = (value.outbox || []).find(row => row.data.eventId === event.data.eventId && row.data.revision === event.data.revision), delivery = target?.deliveries?.[installationId]
          if (!delivery || ['sent', 'suppressed', 'failed'].includes(delivery.state) || delivery.attempts >= 4 || delivery.nextAt > now() || delivery.leaseUntil > now()) return null
          target.deliveries[installationId] = { ...delivery, lease, leaseUntil: now() + 30000, attempts: (delivery.attempts || 0) + 1 }; claimed = true; return value
        })
        if (!claimed) continue
        attempts++
        const deviceRow = await atomicStore.get('mobile:installation:' + installationId), device = deviceRow?.value
        let result = { ok: false, code: 'suppressed' }
        if (device?.userId === uid && device.notificationsEnabled && providers.includes(device.provider) && typeof device.token === 'string' && await allowedNotice(uid,event.policy)) {
          try { result = await transports[device.provider](device.token, event.data) } catch { result = { ok: false, code: 'provider_unavailable' } }
          if (result.gone) {
            const deleted = await atomicStore.compareAndSet('mobile:installation:' + installationId, deviceRow.version, { ...device, notificationsEnabled: false, token: null, provider: null }, { expiresAt: expiresAt() })
            if (deleted) await remove(uid, installationId, device.sessionId)
          }
        }
        await update(userKey(uid), value => {
          const target = (value.outbox || []).find(row => row.data.eventId === event.data.eventId && row.data.revision === event.data.revision), delivery = target?.deliveries?.[installationId]
          if (delivery?.lease !== lease) return null
          target.deliveries[installationId] = { state: result.ok ? 'sent' : result.gone || result.code === 'suppressed' ? 'suppressed' : delivery.attempts >= 4 ? 'failed' : 'pending', attempts: delivery.attempts, nextAt: now() + Math.min(30 * 60000, 60000 * 2 ** (delivery.attempts - 1)) }
          return value
        })
        if (result.ok) sent++
      }
    }
    return { sent }
  }
  return {
    providers, register, remove,
    async notify(uid, notice) {
      if (!providers.length || !await validUser(uid)) return { ok: false, skipped: true }
      const data = await mobileNoticeData(notice)
      let queued = false
      await update(userKey(uid), value => {
        const installations = value.installations || []
        if (!installations.length) return null
        const outbox = (value.outbox || []).filter(event => event.expiresAt > now())
        if (outbox.some(event => event.data.eventId === data.eventId && Number(event.data.revision) >= Number(data.revision))) return null
        for (const event of outbox.filter(event => event.data.eventId === data.eventId)) {
          event.deliveries = Object.fromEntries(Object.entries(event.deliveries).map(([id, delivery]) => [id, delivery.state === 'sent' ? delivery : { state: 'suppressed' }]))
        }
        // A worker can disappear after claiming its last attempt. Once its
        // lease expires, that exhausted event is terminal and can be evicted.
        const terminal = row => ['sent', 'suppressed', 'failed'].includes(row.state) || row.attempts >= 4 && !(row.leaseUntil > now())
        while (outbox.length >= 20) { const index = outbox.findIndex(event => Object.values(event.deliveries).every(terminal)); if (index < 0) fail('mobile_push_capacity', 503); outbox.splice(index, 1) }
        outbox.push({ data, policy:{...(notice.channel?{channel:notice.channel,noticeId:notice.noticeId}:{}),...(notice.type==='queue'?{queueNoticeId:notice.noticeId}:{}),...(notice.taskId?{taskId:notice.taskId}:{})}, expiresAt: now() + DAY, deliveries: Object.fromEntries(installations.map(id => [id, { state: 'pending', attempts: 0 }])) }); queued = true
        return { ...value, outbox }
      })
      const result = await deliver(uid)
      return { ok: result.sent > 0, queued, sent: result.sent }
    },
    async drain({ limit = 8 } = {}) {
      if (!providers.length) return { sent: 0, disabled: true }
      let users = []
      await update('mobile:push-users:global', async value => {
        const all = value.users || [], offset = (Number(value.cursor) || 0) % (all.length || 1)
        const count = Number.isInteger(limit) ? Math.max(1, Math.min(8, limit)) : 8
        const selected = [...all.slice(offset), ...all.slice(0, offset)].slice(0, count)
        const active = await Promise.all(selected.map(async uid => (await atomicStore.get(userKey(uid)))?.value.installations?.length ? uid : null))
        users = active.filter(Boolean)
        const inactive = new Set(selected.filter(uid => !users.includes(uid))), remaining = all.filter(uid => !inactive.has(uid))
        return { ...value, users: remaining, cursor: remaining.length ? (offset + users.length) % remaining.length : 0 }
      })
      // Bound each sync to eight parallel provider requests. One slow provider
      // must not multiply into minutes of delay before upstream state refresh.
      const results = await Promise.allSettled(users.map(uid => deliver(uid, 1)))
      return { sent: results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.sent : 0), 0), users: users.length }
    },
  }
}
