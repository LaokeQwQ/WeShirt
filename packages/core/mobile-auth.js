// Native sessions deliberately require linearizable, durable compare-and-set.
// Edge KV and withOperationLock do not provide that guarantee across workers.
import { timingSafeEqual } from './auth.js'
import { createDingTalk } from './dingtalk.js'

export const MOBILE_PACKAGE = 'com.laoke.weshirt'
export const MOBILE_ACCESS_SECONDS = 900
export const MOBILE_REFRESH_SECONDS = 30 * 24 * 60 * 60
const CHALLENGE_SECONDS = 180
const enc = new TextEncoder()
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value)
const random = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const mobileDigest = async value => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export class MobileError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new MobileError(code, message, status) }
const publicUser = user => ({ id: user.id, nick: user.nick || '', avatar: user.avatar || null, avatarUrl: user.avatarUrl || null, dormBuilding: user.dormBuilding || null })
const invalidRefresh = () => fail('invalid_refresh_token', '登录状态已过期，请重新登录', 401)

/**
 * Atomic adapter v1: consistency='linearizable', durable=true,
 * get(key) => null | {version: opaque, value: JSON};
 * compareAndSet(key, expectedVersion|null, value, {expiresAt: epochMs}) => boolean.
 * Expiry, absent-key creation and each CAS must be atomic across all workers;
 * reads must bypass caches. Exceptions must propagate, never pretend success.
 */
export function createMobileAuth({ store, env = {}, atomicStore, identityProvider, now = Date.now } = {}) {
  const atomicReady = atomicStore?.consistency === 'linearizable' && atomicStore?.durable === true && typeof atomicStore.get === 'function' && typeof atomicStore.compareAndSet === 'function'
  const configured = env.MOBILE_AUTH_ENABLED === 'true' && typeof env.DINGTALK_MOBILE_CLIENT_ID === 'string' && env.DINGTALK_MOBILE_CLIENT_ID.length > 0 && typeof env.DINGTALK_MOBILE_CLIENT_SECRET === 'string' && env.DINGTALK_MOBILE_CLIENT_SECRET.length >= 16 && validRedirect(env.DINGTALK_MOBILE_REDIRECT_URI)
  const enabled = configured && atomicReady
  const provider = identityProvider || {
    async exchange(authCode) {
      // New ddopenauth SDK uses unified OAuth codes. Credentials are for the
      // separately registered native application, never the website fallback.
      const dt = createDingTalk({ ...env, DINGTALK_APP_KEY: env.DINGTALK_MOBILE_CLIENT_ID, DINGTALK_APP_SECRET: env.DINGTALK_MOBILE_CLIENT_SECRET })
      const token = await dt.exchangeUserCode(authCode)
      if (!token.ok) fail(token.err === 'invalid_code' ? 'invalid_auth_code' : 'mobile_identity_unavailable', '钉钉授权未完成，请重新登录', token.err === 'invalid_code' ? 400 : 502)
      const me = await dt.fetchUserMe(token.accessToken)
      if (!me.ok || typeof me.unionId !== 'string' || !me.unionId) fail('mobile_identity_unavailable', '无法确认钉钉身份，请重新登录', 502)
      return { unionId: me.unionId }
    },
  }
  function requireEnabled() { if (!enabled) fail('mobile_auth_not_configured', '原生登录尚未完成配置', 503) }
  async function cas(key, previous, value, expiresAt) {
    return atomicStore.compareAndSet(key, previous?.version ?? null, value, { expiresAt })
  }
  async function limit(key, maximum, windowMs = 60000) {
    const at = now(), bucketKey = 'mobile:limit:' + key + ':' + Math.floor(at / windowMs)
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await atomicStore.get(bucketKey)
      if ((row?.value?.count || 0) >= maximum) fail('mobile_rate_limited', '操作太频繁，请稍后重试', 429)
      if (await cas(bucketKey, row, { count: (row?.value?.count || 0) + 1 }, at + windowMs * 2)) return
    }
    fail('mobile_busy', '请求繁忙，请稍后重试', 503)
  }
  async function knownUser(identity) {
    if (!object(identity) || typeof identity.unionId !== 'string' || !identity.unionId || identity.unionId.length > 256) fail('invalid_identity', '无法确认钉钉身份', 502)
    const userId = await store.get('userByUnionId:' + identity.unionId, null)
    let user = userId ? await store.get('user:' + userId, null) : null
    if (user?.id !== userId || user?.dingUnionId !== identity.unionId) user = null
    if (!user) {
      // A directory lookup is an identity proof; phone and display name are not.
      const directory = createDingTalk(env)
      const result = await directory.getUserIdByUnionId(identity.unionId)
      const mapped = result.ok && result.userId ? await store.get('userByDing:' + result.userId, null) : null
      const candidate = mapped ? await store.get('user:' + mapped, null) : null
      if (candidate?.id === mapped && result.ok && result.userId && candidate.dingUserId === result.userId && (!candidate.dingUnionId || candidate.dingUnionId === identity.unionId)) user = candidate
    }
    // Creating/merging web identities over eventual KV cannot be made atomic by
    // a native-session adapter. Require an existing verified account for now.
    if (!user?.id) fail('account_link_required', '此钉钉账号尚未关联本站账号，请联系管理员', 409)
    if (user.disabled || user.blocked) fail('account_disabled', '当前账号不可用', 403)
    return user
  }
  function response(sessionId, access, refresh, user) {
    return { accessToken: `ma1.${sessionId}.${access}`, tokenType: 'Bearer', expiresIn: MOBILE_ACCESS_SECONDS, refreshToken: `mr1.${sessionId}.${refresh}`, refreshExpiresIn: MOBILE_REFRESH_SECONDS, user: publicUser(user) }
  }
  function parseToken(value, prefix) {
    if (typeof value !== 'string' || value.length > 200) return null
    const parts = value.split('.')
    return parts.length === 3 && parts[0] === prefix && /^[A-Za-z0-9_-]{43}$/.test(parts[1]) && /^[A-Za-z0-9_-]{43}$/.test(parts[2]) ? { sessionId: parts[1], secret: parts[2] } : null
  }
  async function accessContext(token) {
    if (!enabled) return null
    const parsed = parseToken(token, 'ma1')
    if (!parsed) return null
    const row = await atomicStore.get('mobile:session:' + parsed.sessionId), session = row?.value
    if (!session || session.revoked || !Number.isFinite(session.accessExpiresAt) || !Number.isFinite(session.refreshExpiresAt) || session.accessExpiresAt <= now() || session.refreshExpiresAt <= now() || !timingSafeEqual(session.accessHash, await mobileDigest(parsed.secret))) return null
    const user = await store.get('user:' + session.userId, null)
    return user?.id === session.userId && !user.disabled && !user.blocked ? { userId: user.id, sessionId: parsed.sessionId, installationId: session.installationId } : null
  }
  async function disableInstallation(session) {
    const key = 'mobile:installation:' + session.installationId
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await atomicStore.get(key)
      // Replaying an older session's logout must not unregister the replacement
      // session on the same phone. New registrations carry the verified owner.
      if (row?.value.userId === session.userId && row.value.sessionId && row.value.sessionId !== session.sessionId) return
      if (!row || row.value.userId !== session.userId) break
      if (await cas(key, row, { ...row.value, userId: null, notificationsEnabled: false, token: null, provider: null, updatedAt: new Date(now()).toISOString() }, now() + 90 * 86400000)) break
      if (attempt === 2) fail('mobile_busy', '设备通知解绑未完成，请重试退出', 503)
    }
    const indexKey = 'mobile:installation-index:' + session.userId
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await atomicStore.get(indexKey)
      if (!row || row.value.owners?.[session.installationId] && row.value.owners[session.installationId] !== session.sessionId) return
      if (!(row.value.installations || []).includes(session.installationId) && !(row.value.outbox || []).some(event => event.deliveries?.[session.installationId]?.state !== undefined && event.deliveries[session.installationId].state !== 'suppressed')) return
      const owners = { ...row.value.owners }; delete owners[session.installationId]
      const next = { ...row.value, owners, installations: (row.value.installations || []).filter(id => id !== session.installationId), outbox: (row.value.outbox || []).map(event => ({ ...event, deliveries: { ...event.deliveries, [session.installationId]: { state: 'suppressed' } } })) }
      if (await cas(indexKey, row, next, now() + 90 * 86400000)) return
    }
    fail('mobile_busy', '设备通知解绑未完成，请重试退出', 503)
  }
  return {
    enabled, atomicReady,
    config() { return { enabled, provider: 'dingtalk-native', authCodeType: 'dingtalk-ddopenauth', reason: enabled ? null : 'mobile_auth_not_configured', accessTokenTtlSeconds: MOBILE_ACCESS_SECONDS, refreshTokenTtlSeconds: MOBILE_REFRESH_SECONDS } },
    async challenge(body) {
      requireEnabled()
      if (!object(body) || !idOK(body.installationId) || !idOK(body.state) || body.platform !== 'android' || body.packageName !== MOBILE_PACKAGE || !/^[A-Za-z0-9_-]{43}$/.test(body.codeChallenge || '') || Object.keys(body).some(key => !['installationId', 'state', 'platform', 'packageName', 'codeChallenge'].includes(key))) fail('bad_param', '登录请求无效')
      await limit('challenge-global', 120)
      await limit('challenge-' + await mobileDigest(body.installationId), 5)
      const challengeId = random(), expiresAt = now() + CHALLENGE_SECONDS * 1000
      if (!await cas('mobile:challenge:' + challengeId, null, { ...body, expiresAt, consumed: false }, expiresAt)) fail('mobile_busy', '请求繁忙，请重试', 503)
      return { challengeId, state: body.state, expiresIn: CHALLENGE_SECONDS, provider: { clientId: env.DINGTALK_MOBILE_CLIENT_ID, scope: 'openid', packageName: MOBILE_PACKAGE, redirectUri: env.DINGTALK_MOBILE_REDIRECT_URI } }
    },
    async exchange(body) {
      requireEnabled()
      if (!object(body) || !/^[A-Za-z0-9_-]{43}$/.test(body.challengeId || '') || !idOK(body.state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier || '') || typeof body.authCode !== 'string' || !body.authCode || body.authCode.length > 2048 || /[\u0000-\u0020\u007f]/.test(body.authCode) || Object.keys(body).some(key => !['challengeId', 'state', 'codeVerifier', 'authCode'].includes(key))) fail('bad_param', '登录请求无效')
      await limit('exchange-global', 120)
      const key = 'mobile:challenge:' + body.challengeId, row = await atomicStore.get(key), challenge = row?.value
      if (!challenge || challenge.consumed || challenge.expiresAt <= now() || !timingSafeEqual(challenge.state, body.state) || !timingSafeEqual(challenge.codeChallenge, await mobileDigest(body.codeVerifier))) fail('invalid_challenge', '登录验证已失效，请重新登录', 400)
      if (!await cas(key, row, { ...challenge, consumed: true }, challenge.expiresAt)) fail('invalid_challenge', '登录验证已使用，请重新登录', 409)
      const identity = await provider.exchange(body.authCode), user = await knownUser(identity)
      const sessionId = random(), access = random(), refresh = random(), at = now(), expiresAt = at + MOBILE_REFRESH_SECONDS * 1000
      const session = { sessionId, userId: user.id, installationId: challenge.installationId, accessHash: await mobileDigest(access), accessExpiresAt: at + MOBILE_ACCESS_SECONDS * 1000, refreshHash: await mobileDigest(refresh), refreshExpiresAt: expiresAt, revoked: false }
      if (!await cas('mobile:session:' + sessionId, null, session, expiresAt)) fail('mobile_busy', '登录未完成，请重新登录', 503)
      return response(sessionId, access, refresh, user)
    },
    async verifyAccessToken(token) {
      return (await accessContext(token))?.userId || null
    },
    verifyAccessContext: accessContext,
    async refresh(body) {
      requireEnabled()
      if (!object(body) || !idOK(body.installationId) || Object.keys(body).some(key => !['installationId', 'refreshToken'].includes(key))) invalidRefresh()
      const parsed = parseToken(body.refreshToken, 'mr1')
      if (!parsed) invalidRefresh()
      await limit('refresh-' + await mobileDigest(body.installationId), 10)
      const key = 'mobile:session:' + parsed.sessionId, row = await atomicStore.get(key), session = row?.value
      if (!session || session.revoked || session.installationId !== body.installationId || !Number.isFinite(session.refreshExpiresAt) || session.refreshExpiresAt <= now() || !timingSafeEqual(session.refreshHash, await mobileDigest(parsed.secret))) invalidRefresh()
      const user = await store.get('user:' + session.userId, null)
      if (user?.id !== session.userId || user.disabled || user.blocked) invalidRefresh()
      const access = random(), refresh = random(), at = now()
      // Rotate both credentials in one durable CAS. Exactly one concurrent
      // refresh wins. A lost response requires login; stale tokens never win.
      const next = { ...session, accessHash: await mobileDigest(access), accessExpiresAt: at + MOBILE_ACCESS_SECONDS * 1000, refreshHash: await mobileDigest(refresh) }
      if (!await cas(key, row, next, session.refreshExpiresAt)) invalidRefresh()
      return { ...response(parsed.sessionId, access, refresh, user), refreshExpiresIn: Math.max(0, Math.floor((session.refreshExpiresAt - at) / 1000)) }
    },
    async logout(body) {
      requireEnabled()
      if (!object(body) || !idOK(body.installationId) || Object.keys(body).some(key => !['installationId', 'refreshToken'].includes(key))) invalidRefresh()
      const parsed = parseToken(body.refreshToken, 'mr1')
      if (!parsed) invalidRefresh()
      const key = 'mobile:session:' + parsed.sessionId
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await atomicStore.get(key), session = row?.value
        if (!session || session.installationId !== body.installationId || !Number.isFinite(session.refreshExpiresAt) || session.refreshExpiresAt <= now() || !timingSafeEqual(session.refreshHash, await mobileDigest(parsed.secret))) invalidRefresh()
        if (session.revoked) { await disableInstallation({ ...session, sessionId: parsed.sessionId }); return { ok: true } }
        if (await cas(key, row, { ...session, revoked: true, accessHash: '', refreshHash: session.refreshHash }, session.refreshExpiresAt)) { await disableInstallation({ ...session, sessionId: parsed.sessionId }); return { ok: true } }
      }
      invalidRefresh()
    },
  }
}

function validRedirect(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && value.length <= 2048 } catch { return false }
}
