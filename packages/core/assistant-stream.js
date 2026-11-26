import { streamChunkBytes } from './stream-bytes.js'

export class AssistantError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'AssistantError'; this.code = code; this.status = status }
}

export const isEventStream = response => /^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')
const invalidStream = () => new AssistantError('upstream_format', 'AI 返回的流式内容格式无效', 502)
const streamError = () => new AssistantError('upstream_error', 'AI 服务暂时不可用，请稍后重试', 502)
const tooLarge = () => new AssistantError('upstream_size', 'AI 响应过大，请缩短问题后重试', 502)

async function* eventData(body, { maxBytes, maxEventBytes, signal }) {
  if (!body) throw invalidStream()
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const cancel = () => { reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let remainder = '', data = [], dataLength = 0, consumed = 0
  try {
    while (true) {
      if (signal.aborted) throw invalidStream()
      const { done, value } = await reader.read()
      if (signal.aborted) throw invalidStream()
      if (done) break
      const chunk = streamChunkBytes(value, maxBytes - consumed)
      if (!chunk) throw tooLarge()
      consumed += chunk.byteLength
      remainder += decoder.decode(chunk, { stream: true })
      let start = 0
      for (let index = 0; index < remainder.length; index++) {
        const character = remainder[index]
        if (character !== '\r' && character !== '\n') continue
        if (character === '\r' && index + 1 === remainder.length) break
        const line = remainder.slice(start, index)
        if (character === '\r' && remainder[index + 1] === '\n') index++
        start = index + 1
        if (!line) {
          if (data.length) yield data.join('\n')
          data = []; dataLength = 0
        } else if (line === 'data' || line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '')
          dataLength += value.length + 1
          if (dataLength > maxEventBytes) throw tooLarge()
          data.push(value)
        }
      }
      remainder = remainder.slice(start)
      if (remainder.length > maxEventBytes) throw tooLarge()
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    try { reader.releaseLock() } catch { /* a cancellation may still be pending */ }
  }
}

function streamObject(value) {
  try {
    const data = JSON.parse(value)
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch { /* provider text is not returned to clients */ }
  throw invalidStream()
}

function blockIndex(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 20) throw invalidStream()
  return value
}

async function responses(events, emit) {
  for await (const value of events) {
    const data = streamObject(value)
    if (data.type === 'response.output_text.delta') await emit(data.delta)
    else if (data.type === 'response.completed') return data.response
    else if (['error', 'response.failed', 'response.incomplete'].includes(data.type)) throw streamError()
  }
  throw invalidStream()
}

async function chatCompletions(events, emit) {
  const message = { role: 'assistant', content: '' }
  const calls = []
  let finish = null
  for await (const value of events) {
    if (value === '[DONE]') {
      if (!finish || (finish === 'tool_calls') !== Boolean(calls.length)) throw invalidStream()
      if (calls.length) message.tool_calls = calls.filter(Boolean)
      return { choices: [{ message }] }
    }
    const data = streamObject(value)
    if (data.error) throw streamError()
    const choice = Array.isArray(data.choices) && data.choices.find(row => row?.index === 0)
    if (!choice) continue
    const delta = choice.delta || {}
    if (typeof delta.content === 'string') {
      await emit(delta.content)
      message.content += delta.content
    }
    if (Array.isArray(delta.tool_calls)) for (const update of delta.tool_calls) {
      const index = blockIndex(update?.index)
      const call = calls[index] ||= { type: 'function', id: '', function: { name: '', arguments: '' } }
      if (typeof update.id === 'string') call.id += update.id
      if (typeof update.function?.name === 'string') call.function.name += update.function.name
      if (typeof update.function?.arguments === 'string') call.function.arguments += update.function.arguments
      if (call.id.length > 200 || call.function.name.length > 200 || call.function.arguments.length > 4096) throw invalidStream()
    }
    if (choice.finish_reason != null) {
      if (!['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) throw streamError()
      finish = choice.finish_reason
    }
  }
  throw invalidStream()
}

async function anthropic(events, emit) {
  const blocks = []
  let finish = null
  for await (const value of events) {
    const data = streamObject(value)
    if (data.type === 'error') throw streamError()
    if (data.type === 'message_delta') finish = data.delta?.stop_reason ?? finish
    if (data.type === 'message_stop') {
      if (finish === 'refusal') throw streamError()
      if (blocks.some(block => !block.closed)) throw invalidStream()
      return { content: blocks.filter(Boolean).map(block => block.content) }
    }
    if (data.type === 'content_block_start') {
      const index = blockIndex(data.index)
      if (blocks[index] || !data.content_block || typeof data.content_block.type !== 'string') throw invalidStream()
      const content = data.content_block
      blocks[index] = { content, arguments: '', closed: false }
      if (content.type === 'text') {
        content.text = typeof content.text === 'string' ? content.text : ''
        await emit(content.text)
      } else if (content.type === 'thinking') {
        content.thinking = typeof content.thinking === 'string' ? content.thinking : ''
        content.signature = typeof content.signature === 'string' ? content.signature : ''
      }
    } else if (data.type === 'content_block_delta' || data.type === 'content_block_stop') {
      const block = blocks[blockIndex(data.index)]
      if (!block || block.closed) throw invalidStream()
      const content = block.content
      if (data.type === 'content_block_stop') {
        block.closed = true
        if (content.type === 'tool_use' && block.arguments) content.input = streamObject(block.arguments)
        continue
      }
      const delta = data.delta
      if (content.type === 'text' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        await emit(delta.text)
        content.text += delta.text
      } else if (content.type === 'thinking' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        content.thinking += delta.thinking
      } else if (content.type === 'thinking' && delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
        content.signature += delta.signature
      } else if (content.type === 'tool_use' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block.arguments += delta.partial_json
        if (block.arguments.length > 4096) throw invalidStream()
      }
    }
  }
  throw invalidStream()
}

const parse = { responses, 'chat-completions': chatCompletions, anthropic }

/** Emit visible text only and rebuild the normalized provider reply for the shared tool validation. */
export function readAssistantStream(response, { protocol, responseBytes, signal, onDelta }) {
  const events = eventData(response.body, { maxBytes: responseBytes * 16, maxEventBytes: responseBytes, signal })
  let textLength = 0
  return parse[protocol](events, text => {
    if (typeof text !== 'string' || !text) return
    textLength += text.length
    if (textLength > 6000) throw tooLarge()
    return onDelta(text)
  })
}
