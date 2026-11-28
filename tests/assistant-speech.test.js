import test from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantMic, createAssistantSpeech, pcm16Wav } from '../frontend/src/assistantSpeech.js'

test('assistant recordings encode bounded mono 16kHz PCM16 WAV with valid sample sizes', async () => {
  const input = new Float32Array(48_000 * 31).fill(0.5)
  const file = pcm16Wav(input, 48_000)
  const buffer = await file.arrayBuffer()
  const data = new DataView(buffer)
  assert.equal(file.type, 'audio/wav')
  assert.equal(file.size, 44 + 30 * 16_000 * 2)
  assert.equal(Buffer.from(buffer, 0, 4).toString(), 'RIFF')
  assert.equal(data.getUint32(4, true), file.size - 8)
  assert.equal(data.getUint16(20, true), 1)
  assert.equal(data.getUint16(22, true), 1)
  assert.equal(data.getUint32(24, true), 16_000)
  assert.equal(data.getUint16(34, true), 16)
  assert.equal(data.getUint32(40, true), file.size - 44)
  assert.equal(data.getInt16(44, true), 16_384)
  assert.throws(() => pcm16Wav(new Float32Array(300), 16_000), /太短/)
})

test('browser fallback starts only on demand and abort discards later recognition events', () => {
  const events = []
  let instance
  class Recognition {
    constructor() { instance = this }
    start() { events.push('start') }
    abort() { events.push('abort') }
  }
  const voice = createAssistantSpeech({ webkitSpeechRecognition: Recognition }, {
    onActive: value => events.push(value),
    onText: value => events.push(value),
    onError: value => events.push(value),
  })
  assert.equal(voice.supported, true)
  assert.deepEqual(events, [])
  voice.start()
  assert.equal(instance.lang, 'zh-CN')
  const lateResult = instance.onresult
  const final = Object.assign([{ transcript: ' 洗衣 ' }], { isFinal: true })
  instance.onresult({ results: [final] })
  voice.abort()
  lateResult({ results: [final] })
  assert.deepEqual(events, [true, 'start', '洗衣', 'abort', false])
})

test('closing during browser permission prompt releases the late microphone grant without uploading', async () => {
  const events = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  class Context {
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
  }
  const voice = createAssistantMic({
    AudioContext: Context, AudioWorkletNode: class {},
    navigator: { mediaDevices: { getUserMedia: () => pending } },
  }, 'fixture.js', {
    onActive: active => events.push(active),
    onAudio: audio => events.push(audio),
    onError: error => events.push(error),
  })
  const start = voice.start()
  voice.abort()
  release({ getTracks: () => [{ stop: () => events.push('released') }] })
  await start
  assert.deepEqual(events, [true, false, 'released'])
})
