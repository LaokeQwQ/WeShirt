import { AssistantError } from './assistant-stream.js'

const PREFIX = 'data:image/jpeg;base64,'
const MAX_BYTES = 1300000
const MAX_ENCODED = Math.ceil(MAX_BYTES / 3) * 4
const MAX_EDGE = 1600
const SOF = new Set([192, 193, 194])
export const ASSISTANT_PHOTO_BODY_BYTES = MAX_ENCODED + 196608
export const ASSISTANT_PHOTO_PROMPT = '请根据这张照片提供洗衣或洗护建议。'
export const ASSISTANT_PHOTO_CONTEXT_ALLOWANCE = 4096

export function normalizeAssistantPhoto(value) {
  const fail = (code, message, status = 400) => { throw new AssistantError(code, message, status) }
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) fail('photo_format', '请上传有效的 JPEG 照片', 415)
  const data = value.slice(PREFIX.length)
  if (data.length > MAX_ENCODED) fail('photo_too_large', '照片不能超过 1.3 MB', 413)
  if (!data || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail('photo_format', '照片编码无效', 415)
  let binary
  try { binary = atob(data) } catch { fail('photo_format', '照片编码无效', 415) }
  if (binary.length > MAX_BYTES) fail('photo_too_large', '照片不能超过 1.3 MB', 413)
  const invalid = () => fail('photo_format', '请重新选择有效的 JPEG 照片', 415)
  const byte = index => binary.charCodeAt(index)
  const u16 = index => (byte(index) << 8) | byte(index + 1)
  if (binary.length < 20 || btoa(binary) !== data || u16(0) !== 0xffd8 || u16(binary.length - 2) !== 0xffd9) invalid()
  let frame = false
  for (let offset = 2; offset + 4 <= binary.length;) {
    if (byte(offset++) !== 255) invalid()
    while (byte(offset) === 255) offset++
    const marker = byte(offset++)
    if (offset + 2 > binary.length) invalid()
    const length = u16(offset)
    if (length < 2 || offset + length > binary.length - 2) invalid()
    if (SOF.has(marker)) {
      const components = byte(offset + 7)
      if (frame || length < 11 || length !== 8 + 3 * components || ![1, 3, 4].includes(components)) invalid()
      const height = u16(offset + 3), width = u16(offset + 5)
      if (!height || !width) invalid()
      if (height > MAX_EDGE || width > MAX_EDGE) fail('photo_dimensions', '照片长边不能超过 1600 像素', 413)
      frame = true
    }
    if (marker === 218 && frame && length >= 8 && offset + length < binary.length - 2) return value
    offset += length
  }
  return invalid()
}

export function assistantImageContent(input, image, protocol) {
  if (protocol === 'responses') return [{ type: 'input_text', text: input }, { type: 'input_image', image_url: image }]
  if (protocol === 'anthropic') return [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.slice(PREFIX.length) } }, { type: 'text', text: input }]
  return [{ type: 'text', text: input }, { type: 'image_url', image_url: { url: image } }]
}
