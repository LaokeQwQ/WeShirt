/* 等衣：静态资源离线复用与站内推送。HTML、API 和身份数据始终走网络。 */
const CACHE_NAME = 'weshirt-static-v3'
const CACHE_LIMIT = 60
const ICONS = new Set(['/icon-192.png', '/icon-512.png', '/favicon.ico'])
let cacheQueue = Promise.resolve()

function cacheable(request) {
  if (request.method !== 'GET' || request.mode === 'navigate' || request.destination === 'document' || request.headers.has('authorization')) return false
  const url = new URL(request.url)
  return url.origin === self.location.origin && !url.search &&
    (ICONS.has(url.pathname) || /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(?:js|css|woff2?|png|jpe?g|webp|svg)$/.test(url.pathname))
}

function saveAsset(cache, request, response) {
  cacheQueue = cacheQueue.catch(() => {}).then(async () => {
    await cache.put(request, response)
    const keys = await cache.keys()
    for (const key of keys.slice(0, Math.max(0, keys.length - CACHE_LIMIT))) await cache.delete(key)
  })
  return cacheQueue
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith('weshirt-static-') && name !== CACHE_NAME).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  if (!cacheable(event.request)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(event.request)
    if (cached) return cached
    const response = await fetch(event.request)
    if (response.ok && response.type !== 'opaque' && (!response.url || new URL(response.url).origin === self.location.origin) && !/text\/html/i.test(response.headers.get('content-type') || '') && !/(?:no-store|private)/i.test(response.headers.get('cache-control') || '')) {
      event.waitUntil(saveAsset(cache, event.request, response.clone()).catch(() => {}))
    }
    return response
  })())
})

function line(value, limit) {
  return typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, limit).join('') : ''
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : ''
}

function targetUrl(raw, fallback = '/#/task') {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback
  try {
    const url = new URL(raw, self.location.origin)
    if (url.origin !== self.location.origin || url.pathname !== '/' || url.search) return fallback
    const [route, query = ''] = url.hash.slice(1).split('?')
    if (route === '/settings') return '/#/settings'
    if(route==='/board'){
      const params=new URLSearchParams(query),channel=params.get('channel'),message=safeId(params.get('message'))
      if(channel&&!/^(?:public|[a-z][a-z0-9_-]{0,31})$/.test(channel))return '/#/board'
      const target=new URLSearchParams();if(channel)target.set('channel',channel);if(message)target.set('message',message)
      const queryString=target.toString()
      return '/#/board'+(queryString?'?'+queryString:'')
    }
    if (route !== '/task' && route !== '/social') return fallback
    const key = route === '/social' ? 'thread' : 'task'
    const id = safeId(new URLSearchParams(query).get(key))
    return '/#' + route + (id ? '?' + key + '=' + encodeURIComponent(id) : '')
  } catch { return fallback }
}

self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} }
  catch { payload = { text: event.data ? event.data.text() : '' } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {}
  const social = payload.type === 'social' || typeof payload.url === 'string' && payload.url.startsWith('/#/social')
  const mention=payload.type==='mention'
  const test = payload.type === 'test'
  const task = safeId(payload.taskId)
  const thread = safeId(payload.threadId)
  const fallback = mention ? '/#/board' : social ? '/#/social' : '/#/task'
  const proposed = payload.url || (social && thread ? '/#/social?thread=' + thread : task ? '/#/task?task=' + task : fallback)
  const options = {
    body: line(payload.body, 1200) || line(payload.text, 1200) || '你有一条等衣提醒，点开查看详情。',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: test ? 'weshirt-client-push-test' : mention ? 'weshirt-mention-'+(safeId(payload.noticeId)||safeId(payload.channel)||'channel') : social ? 'weshirt-social' + (thread ? '-' + thread : '') : 'weshirt-task' + (task ? '-' + task : ''),
    renotify: false,
    data: { url: targetUrl(proposed, fallback) }
  }
  event.waitUntil(self.registration.showNotification(line(payload.title, 80) || '等衣提醒', options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = targetUrl(event.notification.data?.url)
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of all) {
      try { if (new URL(client.url).origin !== self.location.origin) continue }
      catch { continue }
      if (typeof client.focus !== 'function') continue
      if (typeof client.navigate === 'function') {
        try { await client.navigate(target) } catch { continue }
      }
      return client.focus()
    }
    if (self.clients.openWindow) return self.clients.openWindow(target)
  })())
})
