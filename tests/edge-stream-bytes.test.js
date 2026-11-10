import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { streamChunkBytes, readStreamBytes } from '../packages/core/stream-bytes.js'
import { readBoundedJson } from '../packages/core/assistant.js'
import { readMediaBytes, inspectMp4 } from '../packages/core/community-media.js'

const encode = (value) => new TextEncoder().encode(value)
function view(value, kind) {
  const bytes = typeof value === 'string' ? encode(value) : value
  const padded = new Uint8Array(bytes.byteLength + 12)
  padded.fill(255); padded.set(bytes, 5)
  if (kind === 'arraybuffer') return padded.buffer.slice(5, 5 + bytes.byteLength)
  if (kind === 'dataview') return new DataView(padded.buffer, 5, bytes.byteLength)
  return padded.subarray(5, 5 + bytes.byteLength)
}
function body(chunks, { error, pendingCancel = false } = {}) {
  let at = 0, cancelled = 0, released = 0
  return {
    get cancelled() { return cancelled },
    get released() { return released },
    getReader() { return {
      async read() { if (error) throw error; return at < chunks.length ? { value: chunks[at++], done: false } : { done: true } },
      cancel() { cancelled++; return pendingCancel ? new Promise(() => {}) : Promise.resolve() },
      releaseLock() { released++ },
    } },
  }
}

test('Edge documented chunk types preserve bytes, view offsets and UTF-8', async () => {
  const text = '中文与emoji 🧺', expected = encode(text)
  for (const value of [text, view(text, 'arraybuffer'), view(text, 'dataview'), view(text, 'uint8array')]) {
    assert.deepEqual(streamChunkBytes(value), expected)
    const source = body([value])
    assert.deepEqual(await readStreamBytes(source, expected.byteLength), expected)
    assert.equal(source.released, 1); assert.equal(source.cancelled, 0)
  }
  const source = body(['{"name":', view('"中文', 'arraybuffer'), view('emoji ', 'dataview'), view('🧺"}', 'uint8array')])
  assert.equal(new TextDecoder().decode(await readStreamBytes(source, 100)), '{"name":"中文emoji 🧺"}')
})

test('stream limits count UTF-8 bytes and accumulated chunks, not characters or backing buffers', async () => {
  assert.equal(streamChunkBytes('中文', 5), null)
  assert.equal(streamChunkBytes('🧺', 3), null)
  assert.deepEqual(streamChunkBytes(view('ok', 'dataview'), 2), encode('ok'))
  for (const chunks of [['中文'], ['中', view('ab', 'arraybuffer')], [view('中文', 'dataview')]]) {
    const source = body(chunks)
    assert.equal(await readStreamBytes(source, 4), null)
    assert.equal(source.cancelled, 1); assert.equal(source.released, 1)
  }
})

test('unsupported chunks and read errors cancel and release without exposing the underlying data', async () => {
  for (const value of [{ byteLength: Infinity }, { byteLength: NaN }, [1, 2, 3], undefined]) {
    const source = body([value])
    await assert.rejects(() => readStreamBytes(source, 20), { name: 'TypeError', message: 'Unsupported stream chunk' })
    assert.equal(source.cancelled, 1); assert.equal(source.released, 1)
  }
  const error = new Error('synthetic-read-failure'), source = body([], { error })
  await assert.rejects(() => readStreamBytes(source, 20), (result) => result === error)
  assert.equal(source.cancelled, 1); assert.equal(source.released, 1)
})

test('a pending cancellation does not delay the size rejection or release', async () => {
  const source = body(['中文'], { pendingCancel: true })
  assert.equal(await readStreamBytes(source, 1), null)
  assert.equal(source.cancelled, 1); assert.equal(source.released, 1)
})

test('real MP4 upload bytes remain exact with ArrayBuffer and offset DataView chunks', async () => {
  const fixture = new Uint8Array(await readFile(new URL('./fixtures/community-real.mp4', import.meta.url)))
  const expected = inspectMp4(fixture), headers = new Headers()
  for (const kind of ['arraybuffer', 'dataview', 'uint8array']) {
    const split = Math.floor(fixture.byteLength / 2)
    const source = body([view(fixture.subarray(0, split), kind), view(fixture.subarray(split), kind)])
    const bytes = await readMediaBytes({ headers, body: source })
    assert.deepEqual(bytes, fixture)
    assert.deepEqual(inspectMp4(bytes), expected)
    assert.equal(source.released, 1)
  }
  const source = body([view(fixture, 'arraybuffer')])
  await assert.rejects(() => readMediaBytes({ headers, body: source }, fixture.byteLength - 1), { code: 'too_large', status: 413 })
  assert.equal(source.cancelled, 1); assert.equal(source.released, 1)
})

test('AI request and upstream JSON readers accept Edge chunks and retain their byte limits', async () => {
  const json = '{"answer":"中文 🧺"}', headers = new Headers()
  for (const chunk of [json, view(json, 'arraybuffer'), view(json, 'dataview'), view(json, 'uint8array')]) {
    const source = body([chunk])
    assert.deepEqual(await readBoundedJson({ headers, body: source }, encode(json).byteLength), { answer: '中文 🧺' })
    assert.equal(source.released, 1)
  }
  const source = body(['中文'], { pendingCancel: true })
  await assert.rejects(() => readBoundedJson({ headers, body: source }, 5), { code: 'body_too_large', status: 413 })
  assert.equal(source.cancelled, 1); assert.equal(source.released, 1)
})
