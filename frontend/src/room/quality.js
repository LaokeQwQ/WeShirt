export const ROOM_QUALITY = Object.freeze({
  low: { dprCap: 1.15, shadow: false },
  mid: { dprCap: 1.5, shadow: true },
  high: { dprCap: 2, shadow: true },
})
export function roomPixelRatio(quality, devicePixelRatio = 1) {
  const ratio = Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
  return Math.max(1, Math.min(ratio, (ROOM_QUALITY[quality] || ROOM_QUALITY.high).dprCap))
}

// 只观察实际动态帧，目标取当前限帧间隔。静态4fps、减少动态及后台不算掉帧。
// 三个连续坏窗口才降一级；恢复需要12个好窗口和30秒冷却。
export function createAdaptiveRoomQuality({ warmupMs = 8000, windowMs = 2000, badWindows = 3,
  goodWindows = 12, cooldownMs = 30000, minSamples = 12 } = {}) {
  let warmUntil = null, observedAt = null, lastAt = null, lastTarget = null, lastTier = null
  let window = null, bad = 0, good = 0, lastChangeAt = -Infinity
  const clear = () => { window = null; lastAt = lastTarget = null }
  function reset(now = 0) { warmUntil = now + warmupMs; observedAt = now; bad = good = 0; lastTier = null; clear() }
  function sample({ now, frameCostMs, targetIntervalMs = 16.7, quality = 'high', preference = 'auto', visible = true, active = true } = {}) {
    if (!Number.isFinite(now)) return null
    if (warmUntil === null) reset(now)
    if (observedAt !== null && (now < observedAt || now - observedAt > 1000)) reset(now)
    observedAt = now
    if (!visible || preference !== 'auto') { reset(now); return null }
    if (!active || !Number.isFinite(frameCostMs) || frameCostMs < 0) { bad = good = 0; clear(); return null }
    if (now < warmUntil) return null
    const target = Math.max(16.7, Number(targetIntervalMs) || 16.7)
    if (quality !== lastTier || lastTarget !== null && Math.abs(target - lastTarget) > lastTarget * 0.25) {
      bad = good = 0; clear(); lastTier = quality
    }
    if (!window) window = { at: now, n: 0, cost: 0, slow: 0, gaps: 0, elapsed: 0, late: 0 }
    const costLimit = Math.max(22, target * 0.75)
    window.n++; window.cost += frameCostMs
    if (frameCostMs > costLimit) window.slow++
    if (lastAt !== null) {
      const gap = now - lastAt
      window.gaps++; window.elapsed += gap
      if (gap > Math.max(target * 1.45, target + 10)) window.late++
    }
    lastAt = now; lastTarget = target
    if (now - window.at < windowMs || window.n < minSamples || window.gaps < minSamples - 1) return null
    const finished = window; window = null
    const averageCost = finished.cost / finished.n, lateShare = finished.late / finished.gaps
    const struggling = lateShare >= 0.35 && finished.elapsed / finished.gaps > target * 1.35
      || averageCost > costLimit && finished.slow / finished.n >= 0.35
    const headroom = averageCost <= Math.min(5, target * 0.2) && lateShare <= 0.05
    bad = struggling ? bad + 1 : 0
    good = !struggling && headroom ? good + 1 : 0
    const levels = ['low', 'mid', 'high'], index = levels.indexOf(quality)
    let direction = null, changeTo = null
    if (now - lastChangeAt >= cooldownMs) {
      if (bad >= badWindows && index > 0) { direction = 'down'; changeTo = levels[index - 1] }
      else if (good >= goodWindows && index >= 0 && index < 2) { direction = 'up'; changeTo = levels[index + 1] }
    }
    if (changeTo) { lastChangeAt = now; bad = good = 0; lastTier = changeTo; clear() }
    return { averageCost, direction, changeTo }
  }
  return { sample, reset }
}
