// Small, standards-based shims needed by this app on supported embedded browsers.
// Loaded before the app's modules; native implementations are always preserved.
export function installBrowserCompatibility(target = globalThis) {
  const define = (object, key, value) => {
    if (object && typeof object[key] !== 'function') Object.defineProperty(object, key, { configurable: true, writable: true, value })
  }
  define(target.Object, 'hasOwn', function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key) })
  const at = function at(index = 0) {
    if (this == null) throw new TypeError('Cannot read an indexed value of null')
    const object = Object(this), length = Math.floor(Math.min(Math.max(+object.length || 0, 0), Number.MAX_SAFE_INTEGER))
    let offset = +index || 0
    offset = offset < 0 ? Math.ceil(offset) : Math.floor(offset)
    if (offset < 0) offset += length
    return offset >= 0 && offset < length ? object[offset] : undefined
  }
  define(target.Array?.prototype, 'at', at)
  define(target.String?.prototype, 'at', function atString(index = 0) {
    if (this == null) throw new TypeError('Cannot read an indexed value of null')
    return at.call(String(this), index)
  })
  define(target.crypto, 'randomUUID', function randomUUID() {
    const bytes = new Uint8Array(16)
    target.crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
  })
  define(target.AbortSignal, 'timeout', function timeout(milliseconds) {
    const duration = Number(milliseconds)
    if (!Number.isInteger(duration) || duration < 0 || duration > Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid timeout')
    const controller = new target.AbortController()
    target.setTimeout(() => {
      let reason
      try { reason = new target.DOMException('The operation timed out', 'TimeoutError') }
      catch { reason = new Error('The operation timed out'); reason.name = 'TimeoutError' }
      controller.abort(reason)
    }, Math.min(duration, 2147483647))
    return controller.signal
  })
}

installBrowserCompatibility()
