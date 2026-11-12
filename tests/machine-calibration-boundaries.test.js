import test from 'node:test'
import assert from 'node:assert/strict'
import { observeCalibration, calibrateMachineBoard, calibrationKey } from '../packages/core/machine-time-calibration.js'
import { createMemoryStore } from '../packages/core/store.js'
const M = 60000, T = Date.parse('2026-11-12T12:00:00Z'), iso = n => new Date(n).toISOString()
const machine = (state = 'occupied', end = T + 10 * M) => ({ id: 'm1', state, finishAt: iso(end) })
const start = () => observeCalibration({ autoEnabled: true }, machine(), { now: T, snapshotAt: iso(T), previousSnapshotAt: iso(T - M), previousMachine: machine('idle') })
test('程序延长或原始截止时间缺失会中止学习，不能当成机器时钟偏差', () => {
  for (const row of [machine('occupied', T + 30 * M), { id: 'm1', state: 'occupied', finishAt: null }]) {
    const value = observeCalibration(start(), row, { now: T + M, snapshotAt: iso(T + M), previousSnapshotAt: iso(T), previousMachine: machine() })
    assert.equal(value.cycle, undefined)
    assert.equal(value.samples, undefined)
  }
})
test('上次平台已报空闲但观察链有缺口，或上次查询失败时不能建立完整周期', () => {
  const discontinuous = observeCalibration({ ...start(), lastObservation: T - M }, machine(), { now: T + M, snapshotAt: iso(T + M), previousSnapshotAt: iso(T), previousMachine: machine() })
  assert.equal(discontinuous.cycle, undefined)
  const failedIdle = observeCalibration({ autoEnabled: true }, machine(), { now: T, snapshotAt: iso(T), previousSnapshotAt: iso(T - M), previousMachine: { ...machine('idle'), queryFailed: true } })
  assert.equal(failedIdle.cycle, undefined)
})
test('整份采样遗漏某台机器时立即丢弃该机器的学习周期', async () => {
  const store = createMemoryStore()
  await store.put(calibrationKey('b1'), { machines: { m1: start() } })
  await calibrateMachineBoard({ store, buildingId: 'b1', now: T + M, previousBoard: { updatedAt: iso(T), floors: [{ machines: [machine()] }] }, board: { updatedAt: iso(T + M), floors: [] } })
  assert.equal((await store.get(calibrationKey('b1'))).machines.m1.cycle, undefined)
})
