import { createTelemetryClient } from './telemetryClient'
import { telemetryRoute } from '../../packages/core/telemetry.js'

const KEY = 'ws_telemetry_enabled'
const BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? 'http://localhost:8787' : '')
let context = () => ({ route: telemetryRoute((location.hash || '#/').slice(1)) || '', dorm: null })
export function telemetryEnabled() {
  try { return navigator.doNotTrack !== '1' && localStorage.getItem(KEY) !== '0' } catch { return false }
}
export function setTelemetryEnabled(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* 当前环境无法持久化 */ }
  if (!on) client.clear()
}
export function getTelemetryContext() { return context() }
const client = createTelemetryClient({
  context: () => context(), enabled: telemetryEnabled,
  send: (body, beacon) => {
    const payload = JSON.stringify(body)
    if (beacon && navigator.sendBeacon?.(BASE + '/api/telemetry', new Blob([payload], { type: 'application/json' }))) return
    return fetch(BASE + '/api/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: beacon, credentials: 'omit' })
  },
})
export function track(name, fields) { try { client.track(name, fields) } catch { /* 遥测不能打断交互 */ } }

export function initTelemetry({ router, getDorm, app }) {
  context = () => ({ route: router.currentRoute.value.path, dorm: getDorm() || null })
  let activeRoute = ''
  let initialRoute = ''
  let lcpClosed = false
  let vitals = { lcp: null, cls: 0, inp: null }
  let clsSession = { start: 0, last: 0, value: 0 }
  const reportVitals = () => {
    for (const [metric, value] of Object.entries(vitals)) if (value != null) track('web_vital', { metric, value, route: activeRoute })
    vitals = { lcp: null, cls: 0, inp: null }
    clsSession = { start: 0, last: 0, value: 0 }
  }
  const view = (route) => {
    if (route.path === activeRoute) return
    if (activeRoute) { reportVitals(); lcpClosed = true }
    activeRoute = route.path
    if (!initialRoute) initialRoute = route.path
    track('page_view')
  }
  router.afterEach((to) => view(to))
  router.isReady().then(() => view(router.currentRoute.value))
  const observe = (type, callback, extra = {}) => {
    try { const observer = new PerformanceObserver(callback); observer.observe({ type, buffered: true, ...extra }); return observer } catch { return null }
  }
  // Navigation LCP只属于首次文档；SPA后续路由不把旧值重复记入。
  observe('largest-contentful-paint', (list) => { if (!lcpClosed && (!activeRoute || activeRoute === initialRoute)) vitals.lcp = list.getEntries().at(-1)?.startTime ?? null })
  observe('layout-shift', (list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue
      if (entry.startTime - clsSession.last > 1000 || entry.startTime - clsSession.start > 5000) clsSession = { start: entry.startTime, last: entry.startTime, value: 0 }
      clsSession.value += entry.value
      clsSession.last = entry.startTime
      vitals.cls = Math.max(vitals.cls, clsSession.value)
    }
  })
  observe('event', (list) => {
    for (const entry of list.getEntries()) if (entry.interactionId) vitals.inp = Math.max(vitals.inp || 0, entry.duration)
  }, { durationThreshold: 40 })
  window.addEventListener('error', (event) => track('client_error', { kind: event.error?.name || (event.target !== window ? 'resource' : 'Error') }), true)
  window.addEventListener('unhandledrejection', () => track('client_error', { kind: 'UnhandledRejection' }))
  app.config.errorHandler = (error) => { track('client_error', { kind: 'vue' }); console.error(error) }
  const flush = () => client.flush()
  setInterval(flush, 15000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { reportVitals(); client.flush({ beacon: true }) } })
  window.addEventListener('pagehide', () => { reportVitals(); client.flush({ beacon: true }) })
}
