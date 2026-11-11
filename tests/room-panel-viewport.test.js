import test from 'node:test'
import assert from 'node:assert/strict'
import { availableRoomHeight } from '../frontend/src/room/panelViewport.js'

test('room height respects optional account/building bars and actual safe-area navigation', () => {
  assert.equal(availableRoomHeight({ pageTop: 38, viewportHeight: 844, tabbarTop: 760 }), 722)
  assert.equal(availableRoomHeight({ pageTop: 80, viewportHeight: 844, tabbarTop: 794 }), 714)
  assert.equal(availableRoomHeight({ pageTop: 38, viewportHeight: 800, tabbarTop: 750 }), 712)
})

test('software keyboard bounds the room when bottom navigation remains outside visible viewport', () => {
  assert.equal(availableRoomHeight({ pageTop: 38, viewportHeight: 430, tabbarTop: 794 }), 392)
  assert.equal(availableRoomHeight({ pageTop: 38, viewportHeight: 430, viewportTop: 30, tabbarTop: 794 }), 422)
  assert.equal(availableRoomHeight({ pageTop: 38, viewportHeight: 390, tabbarTop: 340 }), 302)
})

test('transient hidden viewport and invalid measurements never produce a negative or non-finite size', () => {
  assert.equal(availableRoomHeight({ pageTop: 38, viewportHeight: 0, tabbarTop: 794 }), 0)
  assert.equal(availableRoomHeight({ pageTop: NaN, viewportHeight: 500, viewportTop: NaN }), 500)
  assert.equal(availableRoomHeight({ pageTop: 600, viewportHeight: 500, tabbarTop: 0 }), 0)
})
