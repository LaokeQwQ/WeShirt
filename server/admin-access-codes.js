import { json, apiErr } from '../packages/core/util.js'
import { PERMISSION_RESOURCES, basePermissions } from '../packages/core/permissions.js'
import { getSiteConfig } from './site.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'

export function registerAdminAccessCodeRoutes(app, { service, highest, store }) {
  const wrap = action => async c => {
    if (c.get('temporaryAdminAccess') || !await highest(c)) return apiErr('forbidden', '仅总管可管理临时口令', 403)
    try { return json({ ok: true, ...await action(c) }, 200, { 'Cache-Control': 'private, no-store' }) }
    catch (error) { return apiErr(error.code || 'access_codes_unavailable', error.status ? error.message : '临时口令暂不可用', error.status || 503) }
  }
  app.get('/api/admin/access-codes', wrap(async () => ({ codes: await service.list(), resources: PERMISSION_RESOURCES,
    buildings: (await getSiteConfig(store)).buildings, base: basePermissions({ role: 'admin', buildings: [] }, true), defaultTtlHours: 12, maxTtlHours: 720 })))
  app.post('/api/admin/access-codes', wrap(async c => {
    const bytes = await readStreamBytes(c.req.raw.body, 32000)
    if (!bytes) throw Object.assign(new Error('口令配置内容过长'), { code: 'too_large', status: 413 })
    let body
    try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return Promise.reject(Object.assign(new Error('请提交有效 JSON'), { code: 'bad_param', status: 400 })) }
    // Recheck super status after reading the body, before mutating the atomic record.
    if (!await highest(c)) throw Object.assign(new Error('管理权限已变化'), { code: 'forbidden', status: 403 })
    return service.create(body, { actor: c.get('adminAccessActor') || 'bootstrap', key: c.req.header('Idempotency-Key'), buildings: (await getSiteConfig(store)).buildings })
  }))
  app.delete('/api/admin/access-codes/:id', wrap(async c => ({ accessCode: await service.revoke(c.req.param('id')) })))
}
