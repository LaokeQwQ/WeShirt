import test from 'node:test'
import assert from 'node:assert/strict'
import { createPointerGesture, chooseInitialQuality, normalizeQualityPreference, renderInterval, labelSignature } from '../frontend/src/room/strategy.js'

const event = (pointerId = 1, x = 0, y = 0, timeStamp = 0) => ({ pointerId, clientX: x, clientY: y, timeStamp, button: 0, isPrimary: true })

test('正常轻触可选机位，拖远又拖回、长按及右键均不触发', () => {
  const gesture = createPointerGesture()
  gesture.down(event()); assert.equal(gesture.up(event(1, 2, 3, 150)), true)
  gesture.down(event()); gesture.move(event(1, 30)); gesture.move(event()); assert.equal(gesture.up(event(1, 0, 0, 300)), false)
  gesture.down(event()); assert.equal(gesture.up(event(1, 0, 0, 900)), false)
  gesture.down({ ...event(), button: 2 }); assert.equal(gesture.up(event(1, 0, 0, 100)), false)
})

test('双指缩放所有手指离开前不会误选，随后可正常点击', () => {
  const gesture = createPointerGesture()
  gesture.down(event(1)); gesture.down({ ...event(2), isPrimary: false })
  assert.equal(gesture.up(event(2, 0, 0, 20)), false)
  assert.equal(gesture.up(event(1, 0, 0, 40)), false)
  gesture.down(event(3)); assert.equal(gesture.up(event(3, 0, 0, 100)), true)
})

test('指针取消、错误指针释放和失焦后不误选', () => {
  const gesture = createPointerGesture()
  gesture.down(event(1)); assert.equal(gesture.up(event(2, 0, 0, 10)), false)
  gesture.cancel(1); assert.equal(gesture.up(event(1, 0, 0, 20)), false)
  gesture.down(event(3)); gesture.cancel(); assert.equal(gesture.active, false)
  assert.equal(gesture.up(event(3, 0, 0, 30)), false)
})

test('用户画质优先、旧非法值回自动，自动尊重设备与减少动态偏好', () => {
  assert.equal(normalizeQualityPreference('unexpected'), 'auto')
  assert.equal(chooseInitialQuality({ preference: 'high', deviceMemory: 2, reducedMotion: true }), 'high')
  assert.equal(chooseInitialQuality({ deviceMemory: 2 }), 'low')
  assert.equal(chooseInitialQuality({ hardwareConcurrency: 4 }), 'low')
  assert.equal(chooseInitialQuality({ reducedMotion: true }), 'low')
  assert.equal(chooseInitialQuality({ devicePixelRatio: 3 }), 'mid')
  assert.equal(chooseInitialQuality(), 'high')
})

test('静态空闲仅4fps，运行机位和交互分别提高帧率，减少动态仍降低闲置消耗', () => {
  assert.equal(renderInterval({ animated: false, quality: 'high' }), 250)
  assert.equal(renderInterval({ animated: true, quality: 'low' }), 66)
  assert.equal(renderInterval({ animated: true, quality: 'high' }), 33)
  assert.equal(renderInterval({ busy: true, quality: 'high' }), 16)
  assert.equal(renderInterval({ busy: true, quality: 'low' }), 33)
  assert.equal(renderInterval({ animated: true, reducedMotion: true }), 250)
})

test('标牌仅在可见编号、状态、分钟或估值标记变更时重绘', () => {
  const occupied = { no: 'D1', state: 'occupied', leftMin: 30, estimated: false }
  assert.equal(labelSignature(occupied), labelSignature({ ...occupied, machineId: 'other' }))
  assert.notEqual(labelSignature(occupied), labelSignature({ ...occupied, leftMin: 29 }))
  assert.notEqual(labelSignature(occupied), labelSignature({ ...occupied, estimated: true }))
  assert.equal(labelSignature({ no: 1, state: 'idle', leftMin: 0 }), labelSignature({ no: 1, state: 'idle', leftMin: null }))
})
