import { AssistantError } from '../packages/core/assistant-stream.js'
import { readStreamBytes } from '../packages/core/stream-bytes.js'

const ASR_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr'
const MAX_WAV_BYTES = 44 + 30 * 16_000 * 2
const encoder = new TextEncoder()

export function deepSeekSpeechKey(config, env) {
  if (!config.enabled) return ''
  const dedicated = String(env.DEEPSEEK_ASR_API_KEY || env.DEEPSEEK_API_KEY || '').trim()
  if (dedicated) return dedicated
  // Only reuse a chat key already intended for the official DeepSeek origin.
  try { return new URL(config.endpoint).origin === new URL(ASR_ENDPOINT).origin ? config.apiKey : '' }
  catch { return '' }
}

export async function readSpeechWav(request) {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (type !== 'audio/wav') throw new AssistantError('speech_format', '语音须为 WAV 格式', 415)
  const tooLarge = () => new AssistantError('speech_too_long', '每段语音最多 30 秒', 413)
  if (Number(request.headers.get('content-length')) > MAX_WAV_BYTES) throw tooLarge()
  const bytes = await readStreamBytes(request.body, MAX_WAV_BYTES)
  if (!bytes) throw tooLarge()
  const valid = () => {
    if (bytes.length < 44 + 3200 || bytes.length % 2) return false
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return view.getUint32(0) === 0x52494646 && view.getUint32(4, true) === bytes.length - 8 &&
      view.getUint32(8) === 0x57415645 && view.getUint32(12) === 0x666d7420 && view.getUint32(16, true) === 16 &&
      view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16_000 &&
      view.getUint32(28, true) === 32_000 && view.getUint16(32, true) === 2 && view.getUint16(34, true) === 16 &&
      view.getUint32(36) === 0x64617461 && view.getUint32(40, true) === bytes.length - 44
  }
  if (!valid()) throw new AssistantError('speech_format', '录音太短或格式无效，请重试', 422)
  return bytes
}

export async function transcribeSpeech(bytes, key, { fetchImpl = fetch, signal } = {}) {
  const boundary = 'weshirt-' + crypto.randomUUID()
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`)
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(prefix.length + bytes.length + suffix.length)
  body.set(prefix)
  body.set(bytes, prefix.length)
  body.set(suffix, prefix.length + bytes.length)
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (signal?.aborted) stop()
  else signal?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 22_000)
  try {
    const response = await fetchImpl(ASR_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal, body,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 429) throw new AssistantError('speech_rate_limit', '语音服务繁忙，请稍后再试', 429)
      throw new AssistantError('speech_provider', '语音服务暂时无法识别，请稍后重试', 502)
    }
    const raw = await readStreamBytes(response.body, 16_384)
    const output = raw ? JSON.parse(new TextDecoder().decode(raw)) : null
    const text = typeof output?.text === 'string' ? Array.from(output.text.trim()).slice(0, 1800).join('') : ''
    if (!text) throw new AssistantError('speech_empty', '没有听清，请再说一次', 422)
    return { text }
  } catch (error) {
    if (error instanceof AssistantError) throw error
    throw new AssistantError('speech_unavailable', '暂时无法连接语音识别服务，请重试', 503)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}
