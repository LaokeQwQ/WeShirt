import test from 'node:test'
import assert from 'node:assert/strict'
import { checkAssistantRefusal, readAssistantStream } from '../packages/core/assistant-stream.js'
import { nextRefusalState, assistantRefusalGuard } from '../server/assistant-refusal.js'
import { createMemoryStore } from '../packages/core/store.js'
import { readSpeechWav, deepSeekSpeechKey, transcribeSpeech } from '../server/assistant-speech.js'

test('third consecutive refusal in three hours suspends the same account for eight hours', async () => {
  const hour = 60 * 60_000
  let now = hour
  const guard = assistantRefusalGuard(createMemoryStore(), null, () => now)
  assert.equal(await guard.record('owner', true), 0)
  now += hour
  assert.equal(await guard.record('owner', true), 0)
  now += hour
  assert.equal(await guard.record('owner', true), now + 8 * hour)
  assert.equal(await guard.blockedUntil('other'), 0)
  assert.equal(await guard.blockedUntil('owner'), 11 * hour)
  now += 8 * hour
  assert.equal(await guard.blockedUntil('owner'), 0)
  assert.equal(await guard.record('owner', true), 0)
  assert.equal(nextRefusalState({ recent: [now] }, now, false), null)
})

test('recognizes three provider refusal formats and streaming refusal completion', async () => {
  for (const output of [{ stop_reason: 'refusal' }, { choices: [{ finish_reason: 'content_filter' }] },
    { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }]) {
    assert.throws(() => checkAssistantRefusal(output), { code: 'assistant_refusal' })
  }
  const response = new Response('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n')
  await assert.rejects(readAssistantStream(response, { protocol: 'responses', responseBytes: 16384,
    signal: new AbortController().signal, onDelta: () => assert.fail('must not emit') }), { code: 'assistant_refusal' })
})

test('DeepSeek voice rejects malformed uploads and sends valid WAV only to the fixed provider', async () => {
  const cfg = { enabled: true, apiKey: 'test-only', endpoint: 'https://example.test/v1' }
  assert.equal(deepSeekSpeechKey(cfg, {}), '')
  assert.equal(deepSeekSpeechKey({ ...cfg, endpoint: 'https://api.deepseek.com/v1' }, {}), cfg.apiKey)
  const request = bytes => new Request('https://example.test/voice', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes })
  await assert.rejects(readSpeechWav(request(new Uint8Array(80))), { code: 'speech_format' })
  await assert.rejects(readSpeechWav(request(new Uint8Array(960045))), { code: 'speech_too_long' })
  const wav = new Uint8Array(44 + 3200)
  const view = new DataView(wav.buffer)
  for (const [at, val] of [[0, 0x52494646], [8, 0x57415645], [12, 0x666d7420], [36, 0x64617461]]) view.setUint32(at, val)
  for (const [at, val] of [[4, 3236], [16, 16], [24, 16000], [28, 32000], [40, 3200]]) view.setUint32(at, val, true)
  for (const [at, val] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(at, val, true)
  const reply = await transcribeSpeech(await readSpeechWav(request(wav)), cfg.apiKey, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/v1/tools/asr')
      assert.equal(options.redirect, 'error')
      assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=/)
      assert.ok(options.body.length > wav.length)
      return Response.json({ text: ' 查询洗衣时间 ' })
    },
  })
  assert.deepEqual(reply, { text: '查询洗衣时间' })
})
