export function createMessageHold({ delay = 500, movement = 10, schedule = setTimeout, unschedule = clearTimeout, now = () => Date.now() } = {}) {
  let timer = null, point = null, blockUntil = 0
  const cancel = () => { if (timer !== null) unschedule(timer); timer = null; point = null }
  return {
    cancel,
    start(event, action) {
      cancel()
      if (event.isPrimary === false || event.button != null && event.button !== 0) return
      point = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
      timer = schedule(() => { timer = null; point = null; blockUntil = now() + 750; action() }, delay)
    },
    move(event) { if (point && (event.pointerId !== point.pointerId || Math.hypot(event.clientX - point.x, event.clientY - point.y) > movement)) cancel() },
    suppressClick(event) { if (now() <= blockUntil) { event.preventDefault(); event.stopPropagation(); return true }; return false },
  }
}
