// Keep the catch-all under /api so Pages still serves the frontend and assets.
import { createApp } from '../../server/app.js'
import { createRemoteSiteStore } from '../../packages/core/site-store.js'

function unavailable(request) {
  const eventId = 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  const error = { code: 'site_store_unavailable', message: '站点存储暂不可用，请稍后重试', eventId, status: 503 }
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '5',
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
    if (!app) {
      const store = createRemoteSiteStore({ url: env.SITE_STORE_URL, secret: env.SITE_STORE_SECRET, fetch: fetchImpl })
      if (!store) return unavailable(context.request)
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
