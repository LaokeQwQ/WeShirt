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
