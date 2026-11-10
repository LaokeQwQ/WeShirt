import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdaptiveRoomQuality, roomPixelRatio } from '../frontend/src/room/quality.js'

function harness(options) {
  const monitor = createAdaptiveRoomQuality(options); let now = 0, quality = 'high'; const changes = []
  monitor.reset(now)
  function frames(duration, { gap = 33.34, cost = 4, interval = 33, active = true, visible = true, preference = 'auto' } = {}) {
    const end = now + duration
    for (; now < end;) { now += gap; const result = monitor.sample({ now, quality, frameCostMs: cost, targetIntervalMs: interval, active, visible, preference }); if (result?.changeTo) { quality = result.changeTo; changes.push({ at: now, ...result }) } }
    return changes
  }
  return { monitor, frames, changes, get now() { return now }, get quality() { return quality }, jump(ms) { now += ms } }
}

test('clear defaults use DPR up to2 and never below1, while manual tiers keep their bounded resolution', () => {
  assert.equal(roomPixelRatio('high', 3), 2); assert.equal(roomPixelRatio('high', 2), 2)
  assert.equal(roomPixelRatio('high', 1), 1); assert.equal(roomPixelRatio('high', 0.8), 1)
  assert.equal(roomPixelRatio('high', NaN), 1); assert.equal(roomPixelRatio('mid', 3), 1.5)
  assert.equal(roomPixelRatio('low', 3), 1.15)
})

test('initial warmup and a single stutter never downgrade; three consecutive poor windows lower only one tier', () => {
  const h = harness()
  h.frames(7500, { gap: 70, cost: 50 })
  assert.equal(h.quality, 'high')
  h.frames(5000, { gap: 70, cost: 50 })
  assert.equal(h.quality, 'high', 'two poor windows after warmup are insufficient')
  h.frames(2100, { gap: 70, cost: 50 })
  assert.equal(h.quality, 'mid'); assert.equal(h.changes.length, 1); assert.equal(h.changes[0].direction, 'down')
  h.frames(5000, { gap: 70, cost: 50 })
  assert.equal(h.changes.length, 1, 'degradation also observes the cooldown')
})

test('own30/20/15fps caps, static4fps and reduced-motion idle do not masquerade as dropped frames', () => {
  for (const interval of [33, 50, 66]) { const h = harness(); h.frames(45000, { gap: interval, interval }); assert.equal(h.quality, 'high') }
  const h = harness(); h.frames(45000, { gap: 250, interval: 250, active: false, cost: 40 }); assert.equal(h.quality, 'high')
})

test('frequent missed render deadlines are detected even if asynchronous GPU submission looks cheap', () => {
  const h = harness(); h.frames(16000, { gap: 60, interval: 33, cost: 2 })
  assert.equal(h.quality, 'mid'); assert.equal(h.changes.length, 1)
})

test('very low dynamic frame rates extend the window to enough samples and still degrade instead of resetting forever', () => {
  const h = harness(); h.frames(21000, { gap: 250, interval: 33, cost: 3 })
  assert.equal(h.quality, 'mid'); assert.equal(h.changes.length, 1)
})

test('isolated bad windows reset on recovery and never accumulate into a downgrade', () => {
  const h = harness(); h.frames(8500)
  for (let i = 0; i < 3; i++) { h.frames(2100, { gap: 60, cost: 40 }); h.frames(4500) }
  assert.equal(h.quality, 'high'); assert.equal(h.changes.length, 0)
})

test('manual quality remains fixed even under sustained load, then automatic choice gets a fresh warmup', () => {
  const h = harness(); h.frames(40000, { gap: 70, cost: 60, preference: 'high' })
  assert.equal(h.quality, 'high')
  h.frames(6000, { gap: 70, cost: 60 })
  assert.equal(h.quality, 'high'); assert.equal(h.changes.length, 0)
})

test('background, resume gaps and schedule changes discard stale stutters rather than combine samples', () => {
  const h = harness(); h.frames(12000, { gap: 60, cost: 40 })
  h.frames(10000, { gap: 250, cost: 60, visible: false })
  h.frames(7000, { gap: 60, cost: 40 }); assert.equal(h.changes.length, 0)
  h.jump(5000); h.frames(7000, { gap: 60, cost: 40 }); assert.equal(h.changes.length, 0)
  const schedule = harness(); schedule.frames(11000, { gap: 35, cost: 35, interval: 16 })
  schedule.frames(4000, { gap: 66, interval: 66, cost: 3 }); assert.equal(schedule.quality, 'high')
})

test('recovery needs sustained headroom and30-second cooldown, preventing immediate oscillation', () => {
  const h = harness(); h.frames(15000, { gap: 60, cost: 40 }); assert.equal(h.quality, 'mid')
  h.frames(26000, { gap: 50, interval: 50, cost: 3 }); assert.equal(h.quality, 'mid')
  h.frames(6000, { gap: 50, interval: 50, cost: 3 }); assert.equal(h.quality, 'high')
  assert.deepEqual(h.changes.map((change) => change.direction), ['down', 'up'])
  h.frames(10000, { gap: 60, cost: 40 }); assert.equal(h.quality, 'high')
})
