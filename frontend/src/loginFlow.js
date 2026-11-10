export function safeLoginTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value) || /^\/login(?:[?#/]|$)/.test(value)) return '/'
  return value
}
export function createSingleFlight(fn) {
  let running = null
  return (...args) => {
    if (running) return running
    running = Promise.resolve().then(()=>fn(...args)).finally(()=>{ running = null })
    return running
  }
}

export function canAutoDingLogin({ userAgent = '', ready = false, loggedIn = false, hasError = false, session, local } = {}) {
  if (!ready || loggedIn || hasError || !/DingTalk/i.test(userAgent)) return false
  try { return !session.getItem('ws_ding_auto_attempt') && !session.getItem('ws_ding_guest') && !local.getItem('ws_ding_auto_disabled') }
  catch { return false }
}
