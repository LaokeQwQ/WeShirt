import { createSocialService, SocialError } from '../packages/core/social.js'

export function registerSocialRoutes(app, { store, env, authenticate, notify, getBoard }) {
  const service = createSocialService({ store, env, notify, getBoard })
  const handler = (fn, publicRead = false) => async (c) => {
    try {
      const result = publicRead ? null : await authenticate(c)
      const uid = typeof result === 'string' ? result : result?.id || result?.userId
      if (!publicRead && !uid) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401)
      return c.json(await fn(c, uid))
    } catch (error) {
      if (error instanceof SocialError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
      if(error?.code==='machine_store_unavailable')return c.json({error:{code:error.code,message:'协作服务暂不可用，请稍后重试'}},503)
      return c.json({ error: { code: 'internal', message: '协作服务暂不可用，请稍后重试' } }, 500)
    }
  }
  async function body(c) {
    const declared = Number(c.req.header('content-length') || 0)
    if (declared > 8192) throw new SocialError('too_large', '内容过长', 413)
    const text = await c.req.text()
    if (new TextEncoder().encode(text).length > 8192) throw new SocialError('too_large', '内容过长', 413)
    try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value } catch { throw new SocialError('bad_param', '请求格式不正确') }
  }
  app.get('/api/social', handler((_c, uid) => service.dashboard(uid)))
  app.get('/api/social/invite', handler((c) => service.preview(c.req.query('ticket')), true))
  app.post('/api/social/invite', handler(async (c, uid) => service.invite(uid, (await body(c)).kind)))
  app.post('/api/social/accept', handler(async (c, uid) => service.acceptInvite(uid, (await body(c)).ticket)))
  app.post('/api/social/contact', handler(async (c, uid) => service.contact(uid, await body(c))))
  app.get('/api/social/threads/:id', handler((c, uid) => service.getThread(uid, c.req.param('id'))))
  app.post('/api/social/threads/:id/accept', handler(async (c, uid) => service.acceptThread(uid, c.req.param('id'), (await body(c)).action || 'accept')))
  app.post('/api/social/threads/:id/messages', handler(async (c, uid) => service.message(uid, c.req.param('id'), (await body(c)).text)))
  app.post('/api/social/threads/:id/block', handler((c, uid) => service.blockThread(uid, c.req.param('id'))))
  app.post('/api/social/pickup', handler(async (c, uid) => service.requestPickup(uid, await body(c))))
  app.get('/api/social/pickups', handler((_c, uid) => service.pickups(uid)))
  app.post('/api/social/pickups/:id/respond', handler(async (c, uid) => service.respondPickup(uid, c.req.param('id'), (await body(c)).action)))
  return service
}
