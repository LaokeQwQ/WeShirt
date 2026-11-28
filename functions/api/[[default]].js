// Keep the catch-all under /api so Pages still serves the frontend and assets.
import { createApp } from '../../server/app.js'
import { createRemoteSiteStore } from '../../packages/core/site-store.js'
import { createEdgeStoreExportHandler } from '../../tools/edge-store-migration/export.js'

function unavailable(request, { code, message, retryAfter }) {
  const eventId = 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: { code, message, eventId, status: 503 } }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(retryAfter),
      'X-Event-ID': eventId,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Event-ID, Retry-After',
    },
  })
}

export function createPagesHandler({ fetch: fetchImpl = globalThis.fetch } = {}) {
  let app
  return async function onRequest(context) {
    const env = { ...context.env, ...(typeof process !== 'undefined' ? process.env : {}) }
    if (env.SITE_STORE_MIGRATION_MODE === 'freeze') {
      if (new URL(context.request.url).pathname === '/api/_migration/edge-store-export') {
        return createEdgeStoreExportHandler({ binding: env.LAUNDRY_KV ?? globalThis.LAUNDRY_KV, secret: env.EDGE_STORE_MIGRATION_SECRET })(context.request)
      }
      return unavailable(context.request, { code: 'site_store_migrating', message: '站点正在切换存储，请稍后重试', retryAfter: 15 })
    }
    if (!app) {
      const store = createRemoteSiteStore({ url: env.SITE_STORE_URL, secret: env.SITE_STORE_SECRET, fetch: fetchImpl })
      if (!store) return unavailable(context.request, { code: 'site_store_unavailable', message: '站点存储暂不可用，请稍后重试', retryAfter: 5 })
      app = createApp({ store, env: { ...env, __STORE_INFO__: { kind: 'cloudbase-postgres', name: null } } })
    }
    // Preserve the Pages lifetime of the background sync and notification work.
    const executionCtx = typeof context.waitUntil === 'function'
      ? { waitUntil: task => context.waitUntil(task) }
      : undefined
    return app.fetch(context.request, undefined, executionCtx)
  }
}

export const onRequest = createPagesHandler()
