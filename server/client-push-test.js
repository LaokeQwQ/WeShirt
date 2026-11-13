import { apiErr, json } from '../packages/core/util.js'
import { readBoundedJson } from '../packages/core/assistant.js'
import { updateMachineDocument } from '../packages/core/machine-documents.js'
import { createWebPush } from '../packages/core/webpush.js'
import { logEvent } from '../packages/core/auditlog.js'

export function registerClientPushTestRoute(app, { store, env, authenticate, mobileAuth, mobilePush }) {
  app.post('/api/user/test-notify', async c => {
    try {
      const userId = await authenticate(c)
      if (!userId) return apiErr('unauthorized', '请先登录后再测试通知', 401)
      const user = await store.get('user:' + userId, null)
      if (!user || user.disabled || user.blocked) return apiErr('unauthorized', '请重新登录', 401)
      let body
      try { body = await readBoundedJson(c.req.raw, 4096) }
      catch { return apiErr('bad_param', '请指定当前客户端的通知订阅', 400) }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !['web', 'mobile'].includes(body.channel) ||
          Object.keys(body).some(key => !(body.channel === 'web' ? ['channel', 'endpoint'] : ['channel', 'installationId']).includes(key))) {
        return apiErr('bad_param', '请指定当前客户端的通知订阅', 400)
      }
      if (user.notifyOn === false) return apiErr('notifications_disabled', '请先开启账号通知', 409)
      const claim = () => updateMachineDocument({ store, key: 'client-notification-test:' + userId, fallback: { nextAt: 0 } }, state => {
        if (state.nextAt > Date.now()) throw Object.assign(new Error('请等10秒后再测试'), { code: 'too_many', status: 429 })
        return { document: { nextAt: Date.now() + 10_000 } }
      })
      let result
      if (body.channel === 'mobile') {
        const match = (c.req.header('authorization') || '').match(/^Bearer\s+(ma1\..+)$/i)
        const session = match ? await mobileAuth.verifyAccessContext(match[1]) : null
        if (!session || session.installationId !== body.installationId) return apiErr('installation_not_owned', '只能测试当前登录设备的通知', 403)
        result = await mobilePush.testInstallation(userId, body.installationId, session.sessionId, claim)
      } else {
        if (typeof body.endpoint !== 'string' || !body.endpoint || body.endpoint.length > 2048) return apiErr('bad_param', '请先开启当前浏览器的通知', 400)
        const subs = await store.get('subs', [])
        const target = (Array.isArray(subs) ? subs : []).find(row => row.userId === userId && (row.subscription?.endpoint || row.endpoint) === body.endpoint)
        if (!target) return apiErr('push_subscription_missing', '当前浏览器尚未订阅通知，请重新开启', 409)
        await claim()
        const currentUser = await store.get('user:' + userId, null)
        const currentSubs = await store.get('subs', [])
        if (!currentUser || currentUser.disabled || currentUser.blocked || currentUser.notifyOn === false || !Array.isArray(currentSubs) || !currentSubs.some(row => row.userId === userId && (row.subscription?.endpoint || row.endpoint) === body.endpoint)) return apiErr('push_subscription_changed', '通知订阅已变化，请重新开启后再试', 409)
        result = await createWebPush(env).send(target.subscription || { endpoint: target.endpoint, keys: target.keys }, {
          type: 'test', title: 'WeShirt 通知测试', text: '这是一条当前浏览器的测试通知。收到说明系统通知可用。', tag: 'client-push-test', url: '/#/settings',
        })
        result = { accepted: result.ok === true, provider: 'webpush' }
      }
      await logEvent(store, { type: 'notify', action: '测试本机推送', actorId: userId, level: result.accepted ? 'info' : 'warn', detail: { channel: body.channel, provider: result.provider, accepted: result.accepted } })
      if (!result.accepted) return apiErr('push_provider_unavailable', '推送服务未接受请求，请检查通知配置后重试', 503)
      return json({ ok: true, accepted: true, channel: body.channel, provider: result.provider, hint: '推送服务已接受测试请求，请检查当前设备通知' }, 200, { 'Cache-Control': 'no-store' })
    } catch (error) {
      if (['too_many', 'mobile_push_unavailable', 'installation_not_owned', 'notifications_disabled', 'installation_changed', 'machine_store_unavailable'].includes(error?.code) && [409, 429, 503].includes(error.status)) return apiErr(error.code, error.message, error.status)
      return apiErr('push_provider_unavailable', '通知服务暂不可用，请稍后重试', 503)
    }
  })
}
