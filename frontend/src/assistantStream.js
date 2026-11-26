const MAX_EVENT_BYTES = 10 * 1024 * 1024
const MAX_STREAM_BYTES = 12 * 1024 * 1024
const MAX_REPLY_LENGTH = 6000

/** Parse the authenticated chat response without buffering the whole stream. */
export async function readAssistantEvents(response, { signal, onDelta, onReset, makeError }) {
  const eventId = response.headers.get('X-Event-ID')
  const invalid = () => makeError('助手返回内容无效，请重试', { status: 502, code: 'invalid_stream', eventId })
  if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw invalid()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let pending = '', event = '', data = [], eventSize = 0, totalSize = 0, replySize = 0
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (signal.aborted || done) break
      totalSize += value.byteLength
      if (totalSize > MAX_STREAM_BYTES) throw invalid()
      pending += decoder.decode(value, { stream: true })
      let start = 0
      // Split on complete LF/CRLF lines, retaining UTF-8 and a partial line.
      for (let end = pending.indexOf('\n', start); end !== -1; end = pending.indexOf('\n', start)) {
        const line = pending.slice(start, end).replace(/\r$/, '')
        start = end + 1
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          const part = line.slice(5).replace(/^ /, '')
          eventSize += part.length + 1
          if (eventSize > MAX_EVENT_BYTES) throw invalid()
          data.push(part)
        } else if (!line) {
          if (data.length && ['delta', 'reset', 'done', 'error'].includes(event)) {
            let value
            try { value = JSON.parse(data.join('\n')) } catch { throw invalid() }
            if (event === 'delta') {
              if (typeof value?.text !== 'string') throw invalid()
              replySize += value.text.length
              if (replySize > MAX_REPLY_LENGTH) throw invalid()
              onDelta(value.text)
            } else if (event === 'reset') {
              replySize = 0
              onReset()
            } else if (event === 'done') {
              if (typeof value?.reply !== 'string' || !value.reply || value.reply.length > MAX_REPLY_LENGTH ||
                !Array.isArray(value.messages) || value.messages.length > 256 || !value.usage ||
                !value.messages.every(message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string' &&
                  message.content.length <= MAX_REPLY_LENGTH && typeof message.at === 'string')) throw invalid()
              return value
            } else {
              const problem = value?.error
              const status = Number.isInteger(problem?.status) && problem.status >= 400 && problem.status <= 599 ? problem.status : 502
              const code = /^[a-z][a-z0-9_]{1,39}$/.test(problem?.code || '') ? problem.code : 'stream_error'
              throw makeError(problem?.message || '助手暂时无法继续生成', { status, code, eventId: problem?.eventId || eventId })
            }
          }
          event = ''; data = []; eventSize = 0
        }
      }
      pending = pending.slice(start)
      if (pending.length > MAX_EVENT_BYTES) throw invalid()
    }
    if (signal.aborted) throw new DOMException('Request aborted', 'AbortError')
    throw makeError('助手连接中断，回答未完成', { code: 'stream_interrupted', eventId })
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    try { reader.releaseLock() } catch { /* an aborted network read may still be settling */ }
  }
}
