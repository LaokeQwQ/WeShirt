import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteMobileAtomicStore } from '../packages/core/mobile-store.js'

const env = { MOBILE_ATOMIC_STORE_URL: 'https://bridge.example/atomic', MOBILE_ATOMIC_STORE_SECRET: 'test-only-private-bridge-key-at-least-32' }
const ok = result => Response.json({ protocolVersion: 1, ok: true, result })

test('transient bridge read failures recover once and return the fresh authoritative result', async () => {
  for (const kind of ['http', 'network', 'body']) {
    let calls = 0
    const remote = createRemoteMobileAtomicStore(env, async (_url, options) => {
      assert.equal(JSON.parse(options.body).op, 'get')
      assert.equal(options.redirect, 'error')
      if (++calls === 1) {
        if (kind === 'network') throw Error('connection reset')
        if (kind === 'body') return new Response(new ReadableStream({ start(c) { c.error(Error('read interrupted')) } }))
        return new Response('unavailable', { status: 503 })
      }
      return ok({ version: 'after-recovery', value: { revoked: true } })
    })
    assert.deepEqual(await remote.get('mobile:session:current'), { version: 'after-recovery', value: { revoked: true } })
    assert.equal(calls, 2)
  }
})

test('persistent bridge read failure stays unavailable after two attempts, never becomes missing data', async () => {
  let calls = 0
  const remote = createRemoteMobileAtomicStore(env, async () => { calls++; return new Response(null, { status: 502 }) })
  await assert.rejects(remote.get('mobile:session:current'), /mobile_store_unavailable/)
  assert.equal(calls, 2)
})

test('a stalled read gets one fresh attempt within the original eight second budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 })
  let calls = 0
  const remote = createRemoteMobileAtomicStore(env, async (_url, options) => {
    if (++calls > 1) return ok({ version: 'fresh', value: { enabled: false } })
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  })
  const pending = remote.get('mobile:session:current')
  t.mock.timers.tick(4000)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(100)
  assert.deepEqual(await pending, { version: 'fresh', value: { enabled: false } })
  assert.equal(calls, 2)
  assert.ok(Date.now() < 18000)
})

test('authorization and malformed bridge responses fail immediately without retry or fallback', async () => {
  for (const reply of [() => new Response(null, { status: 401 }), () => ok({ value: {} }), () => Response.json({ ok: true }), () => new Response('invalid-json')]) {
    let calls = 0
    const remote = createRemoteMobileAtomicStore(env, async () => { calls++; return reply() })
    await assert.rejects(remote.get('mobile:session:current'), /mobile_store_unavailable/)
    assert.equal(calls, 1)
  }
})

test('an uncertain compare-and-set is never retried even when the server committed it', async () => {
  let calls = 0, committed = false
  const remote = createRemoteMobileAtomicStore(env, async (_url, options) => {
    assert.equal(JSON.parse(options.body).op, 'compareAndSet')
    calls++; committed = true
    throw Error('connection lost after commit')
  })
  await assert.rejects(remote.compareAndSet('mobile:session:current', 'before', { revoked: true }, { expiresAt: Date.now() + 10000 }), /mobile_store_unavailable/)
  assert.equal(committed, true)
  assert.equal(calls, 1)
})
