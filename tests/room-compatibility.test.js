import test from 'node:test'
import assert from 'node:assert/strict'
import { probeRoomSupport, createCompatibleRenderer, createRoomLoadSession, signalRoomFailure } from '../frontend/src/room/compatibility.js'

test('capability checks the actual WebGL2 context and releases its probe', () => {
  let released = 0
  const document = { createElement: () => ({ getContext: type => { assert.equal(type, 'webgl2'); return { getExtension: () => ({ loseContext: () => released++ }) } } }) }
  assert.deepEqual(probeRoomSupport({ document }), { ok: true, reason: null })
  assert.equal(released, 1)
  assert.deepEqual(probeRoomSupport({ document: { createElement: () => ({ getContext: () => null }) } }), { ok: false, reason: 'webgl2_unavailable' })
  assert.equal(probeRoomSupport({ document: { createElement: () => { throw Error('private driver details') } } }).ok, false)
})

test('normal browser retries a failed high-performance context at low load on a new canvas', () => {
  const options = [], canvases = []
  const document = { createElement: () => { const canvas = { getContext: () => null }; canvases.push(canvas); return canvas } }
  class Renderer { constructor(value) { options.push(value); if (options.length === 1) throw Error('driver details'); this.domElement = value.canvas } }
  const result = createCompatibleRenderer(Renderer, { quality: 'high', antialias: true, alpha: false, powerPreference: 'high-performance' }, { document, userAgent: 'Chrome' })
  assert.equal(result.quality, 'low'); assert.equal(result.conservative, true)
  assert.equal(options[0].antialias, true); assert.equal(options[0].powerPreference, 'high-performance')
  assert.equal(options[1].antialias, false); assert.equal(options[1].powerPreference, 'default')
  assert.notEqual(canvases[0], canvases[1]); assert.equal(result.renderer.domElement, canvases[1])
})

test('DingTalk starts conservatively without rejecting a capable embedded browser', () => {
  const options = []
  class Renderer { constructor(value) { options.push(value) } }
  const result = createCompatibleRenderer(Renderer, { quality: 'high', antialias: true }, { document: { createElement: () => ({}) }, userAgent: 'Android AliApp(DingTalk/8.0)' })
  assert.equal(result.quality, 'low'); assert.equal(result.conservative, true)
  assert.equal(options.length, 1); assert.equal(options[0].antialias, false); assert.equal(options[0].powerPreference, 'default')
})

test('unrecoverable renderer failure exposes a fixed error without driver details', () => {
  class Renderer { constructor() { throw Error('synthetic-secret-driver') } }
  assert.throws(() => createCompatibleRenderer(Renderer, {}, { document: { createElement: () => ({ getContext: () => null }) }, userAgent: '' }), error => {
    assert.equal(error.code, 'ROOM_INITIALIZATION_FAILED'); assert.equal(error.message, '3D initialization failed')
    assert.equal(JSON.stringify(error).includes('synthetic-secret'), false); return true
  })
})

test('shader linking failures reach the scene boundary with a fixed diagnostic', () => {
  class Renderer { constructor() { this.debug = {} } }
  const { renderer } = createCompatibleRenderer(Renderer, {}, { document: { createElement: () => ({}) }, userAgent: '' })
  assert.throws(() => renderer.debug.onShaderError('private driver', 'private shader'), error => error.code === 'ROOM_SHADER_FAILED' && !error.message.includes('private'))
})

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
function harness(load, probe = () => ({ ok: true })) {
  const states = [], timers = new Map(); let nextTimer = 0
  const session = createRoomLoadSession({ load, probe, onChange: state => states.push(state),
    setTimer: fn => { timers.set(++nextTimer,fn); return nextTimer }, clearTimer: id => timers.delete(id) })
  return { session, states, timers, timeout: () => [...timers.values()].forEach(fn => fn()) }
}

test('unsupported WebGL2 keeps the fallback usable and does not load the heavy scene', async () => {
  let loaded=0
  const { session, states, timers } = harness(() => { loaded++; return Promise.resolve({ default: {} }) }, () => ({ ok: false }))
  await session.start()
  assert.equal(loaded,0); assert.equal(states.at(-1).reason,'webgl2_unavailable'); assert.equal(timers.size,0)
})

test('timed-out imports cannot overwrite the fallback or a later successful retry', async () => {
  const old = deferred(), fresh = deferred(); let calls=0
  const { session, states, timeout, timers } = harness(() => ++calls === 1 ? old.promise : fresh.promise)
  const first = session.start(); timeout()
  assert.equal(states.at(-1).reason,'load_timeout')
  const second = session.start(); const component = { name: 'fresh' }; fresh.resolve({ default: component }); await second
  assert.equal(states.at(-1).component,component); assert.equal(timers.size,0)
  old.resolve({ default: { name: 'outdated' } }); await first
  assert.equal(states.at(-1).component,component)
})

test('module failures and runtime failure have fixed categories, and disposal silences late changes', async () => {
  const { session, states } = harness(() => Promise.reject(Error('secret URL')))
  await session.start(); assert.equal(states.at(-1).reason,'module_failed')
  session.fail('untrusted-details'); assert.equal(states.at(-1).reason,'render_failed')
  assert.equal(JSON.stringify(states).includes('secret'),false)
  const pending=deferred(), active=harness(() => pending.promise)
  const request=active.session.start(); active.session.dispose(); const count=active.states.length
  pending.resolve({ default: {} }); await request
  assert.equal(active.states.length,count); assert.equal(active.timers.size,0)
})

test('room failures dispatch only allowlisted reasons for the outer recoverable boundary', () => {
  let emitted
  class CustomEvent { constructor(type, options) { this.type=type;Object.assign(this,options) } }
  const element={ ownerDocument:{ defaultView:{ CustomEvent } }, dispatchEvent:event=>{emitted=event} }
  signalRoomFailure(element,'context_lost')
  assert.equal(emitted.type,'weshirt-room-failure');assert.equal(emitted.bubbles,true);assert.deepEqual(emitted.detail,{reason:'context_lost'})
  signalRoomFailure(element,'secret-token');assert.deepEqual(emitted.detail,{reason:'render_failed'})
})
