// EdgeOne streams may yield strings, ArrayBuffers or any ArrayBufferView.
// Normalize before measuring or copying so offsets and UTF-8 limits stay exact.
export function streamChunkBytes(value, maxBytes = Infinity) {
  let bytes
  if (typeof value === 'string') {
    // UTF-8 needs at least one byte per UTF-16 code unit. Reject before encoding
    // a clearly oversized string, then check its actual encoded size as well.
    if (value.length > maxBytes) return null
    bytes = new TextEncoder().encode(value)
  } else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  else throw new TypeError('Unsupported stream chunk')
  return bytes.byteLength > maxBytes ? null : bytes
}

export async function readStreamBytes(body, maxBytes) {
  if (!body) return new Uint8Array()
  const reader = body.getReader(), chunks = []
  const cancel = () => { try { reader.cancel().catch(() => {}) } catch { /* best effort */ } }
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = streamChunkBytes(value, maxBytes - size)
      if (!chunk) { cancel(); return null }
      size += chunk.byteLength
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } catch (error) { cancel(); throw error }
  finally { try { reader.releaseLock() } catch { /* a cancellation may still be pending */ } }
}
