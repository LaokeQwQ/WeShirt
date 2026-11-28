import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { assistantConfig, callAssistant } from '../packages/core/assistant.js'
import { ASSISTANT_PHOTO_PROMPT, normalizeAssistantPhoto } from '../packages/core/assistant-vision.js'
import { createMemoryStore } from '../packages/core/store.js'
import { registerAssistantRoutes } from '../server/assistant.js'

const prefix = 'data:image/jpeg;base64,'
// Synthetic one-component JPEG frame and scan for metadata validation.
function jpeg(width = 2, size = 100) {
  const bytes = new Uint8Array(size)
  bytes.set([255, 216, 255, 192, 0, 11, 8, 0, 2, width >> 8, width & 255, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0])
  bytes.set([255, 217], size - 2)
  return prefix + Buffer.from(bytes).toString('base64')
}
const body = value => new Response(JSON.stringify(value))
const answers = {
  responses: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '查看洗护标签。' }] }] },
  'chat-completions': { choices: [{ message: { role: 'assistant', content: '查看洗护标签。' } }] },
  anthropic: { content: [{ type: 'text', text: '查看洗护标签。' }] },
}
const env = { ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'fixture-model', ASSISTANT_API_KEY: 'fixture-key' }

test('photo input rejects URLs, invalid magic, trailing data, large dimensions and excess bytes', () => {
  const photo = jpeg()
  assert.equal(normalizeAssistantPhoto(photo), photo)
  for (const value of ['https://example.test/photo.jpg', prefix + 'ZmFrZQ==', jpeg().slice(0, -1), photo.replace('jpeg', 'png')]) {
    assert.throws(() => normalizeAssistantPhoto(value), { status: 415, code: 'photo_format' })
  }
  assert.throws(() => normalizeAssistantPhoto(jpeg(1601)), { status: 413, code: 'photo_dimensions' })
  assert.throws(() => normalizeAssistantPhoto(jpeg(2, 1300001)), { status: 413, code: 'photo_too_large' })
})

for (const protocol of Object.keys(answers)) test(protocol + ' sends JPEG once per model request only on the active user message', async () => {
  const photo = jpeg(2, 160000)
  let request, reported
  const reply = await callAssistant({
    config: assistantConfig({ enabled: true, endpoint: 'https://provider.vendor.net/v1', apiKey: 'fixture-key', model: 'fixture-model', protocol }),
    input: '解释洗护标签',
    photoData: photo,
    history: [{ role: 'user', content: '历史问题' }, { role: 'assistant', content: '历史回答' }],
    onContext: value => { reported = value },
    fetchImpl: async (_, opts) => { request = JSON.parse(opts.body); return body(answers[protocol]) },
  })
  assert.equal(reply, '查看洗护标签。')
  assert.ok(reported.estimatedTokensUpperBound < 30000)
  const messages = protocol === 'responses' ? request.input : request.messages
  const previous = messages.find(m => m.content === '历史问题')
  assert.equal(typeof previous.content, 'string')
  const content = messages.at(-1).content
  if (protocol === 'responses') {
    assert.deepEqual(content, [{ type: 'input_text', text: '解释洗护标签' }, { type: 'input_image', image_url: photo }])
  } else if (protocol === 'chat-completions') {
    assert.deepEqual(content, [{ type: 'text', text: '解释洗护标签' }, { type: 'image_url', image_url: { url: photo } }])
  } else {
    assert.deepEqual(content, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo.slice(prefix.length) } }, { type: 'text', text: '解释洗护标签' }])
  }
})

test('an image-only chat uses the default question and stores no JPEG in history', async () => {
  const app = new Hono(), store = createMemoryStore(), photo = jpeg()
  await store.put('user:member', { id: 'member', dormBuilding: 'guiyuan' })
  let requests = 0
  registerAssistantRoutes(app, {
    store, env, authenticate: () => 'member',
    fetchImpl: async (_, opts) => {
      requests++
      assert.ok(JSON.stringify(opts.body).includes(photo))
      assert.ok(JSON.stringify(opts.body).includes(ASSISTANT_PHOTO_PROMPT))
      return body(answers.responses)
    },
  })
  const request = payload => app.request('/api/assistant/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal((await request({})).status, 400)
  assert.equal((await request({ photoData: 'https://example.test/remote.jpg' })).status, 415)
  assert.equal((await request({ photoData: photo, input: 'a'.repeat(1001) })).status, 400)
  const sent = await request({ photoData: photo })
  assert.equal(sent.status, 200)
  assert.equal(requests, 1)
  const data = await sent.json(), stored = await store.get('assistant:history:member')
  assert.deepEqual(stored.map(row => row.content), [ASSISTANT_PHOTO_PROMPT, '查看洗护标签。'])
  assert.equal(JSON.stringify({ data, stored }).includes(photo), false)
})

test('an image rejected by the model is surfaced without replaying as text or echoing upstream content', async () => {
  let calls = 0
  await assert.rejects(callAssistant({
    config: assistantConfig({ enabled: true, endpoint: 'https://provider.vendor.net/v1', apiKey: 'fixture-key', model: 'fixture-model' }),
    input: '查看照片', photoData: jpeg(),
    fetchImpl: async () => { calls++; return new Response('sensitive upstream text', { status: 400 }) },
  }), error => error.status === 422 && error.code === 'photo_not_supported' && !error.message.includes('sensitive'))
  assert.equal(calls, 1)
})
