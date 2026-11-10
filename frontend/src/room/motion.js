// OrbitControls 的阻尼按 update 次数衰减；按时间换算避免低帧率拖尾变慢。
export function roomDampingFactor(deltaSeconds, dragging = false) {
  if (dragging) return .42
  const seconds = Math.min(.1, Math.max(.001, Number(deltaSeconds) || 1/60))
  return 1 - Math.pow(1 - .2, seconds * 60)
}
