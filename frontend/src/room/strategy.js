export const QUALITY_LEVELS = ['low', 'mid', 'high']
export function normalizeQualityPreference(value) {
  return QUALITY_LEVELS.includes(value) ? value : 'auto'
}
export function chooseInitialQuality({ preference, deviceMemory = 0, hardwareConcurrency = 0, devicePixelRatio = 1, reducedMotion = false } = {}) {
  const selected = normalizeQualityPreference(preference)
  if (selected !== 'auto') return selected
  if (reducedMotion || (deviceMemory > 0 && deviceMemory <= 4) || (hardwareConcurrency > 0 && hardwareConcurrency <= 4)) return 'low'
  return devicePixelRatio >= 3 ? 'mid' : 'high'
}
export function renderInterval({ busy = false, animated = false, reducedMotion = false, quality = 'mid' } = {}) {
  if (busy) return reducedMotion || quality === 'low' ? 33 : 16
  if (!animated || reducedMotion) return 250
  return quality === 'low' ? 66 : quality === 'high' ? 33 : 50
}
export function labelSignature({ no, state, leftMin, estimated }) {
  return `${no}:${state}:${state === 'occupied' ? leftMin : ''}:${state === 'occupied' && estimated ? 1 : 0}`
}
// 拖回原点也不算点击；多指必须全部离开后才能重新点击。
export function createPointerGesture({ distance = 8, durationMs = 600 } = {}) {
  const active = new Set()
  let origin = null
  let blocked = false
  return {
    down(event) {
      active.add(event.pointerId)
      if (active.size > 1 || event.isPrimary === false || (event.button != null && event.button !== 0)) blocked = true
      if (!blocked && active.size === 1) origin = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
    },
    move(event) {
      if (origin?.id === event.pointerId && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > distance) blocked = true
    },
    up(event) {
      const known = active.has(event.pointerId)
      const tap = known && !blocked && origin?.id === event.pointerId && active.size === 1 &&
        event.timeStamp - origin.at <= durationMs && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <= distance
      active.delete(event.pointerId)
      if (!active.size) { origin = null; blocked = false }
      return Boolean(tap)
    },
    cancel(pointerId) {
      if (pointerId == null) { active.clear(); origin = null; blocked = false; return }
      active.delete(pointerId)
      blocked = true
      if (!active.size) { origin = null; blocked = false }
    },
    get active() { return active.size > 0 },
  }
}
