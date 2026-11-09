import { normalizeTelemetryEvent } from '../../packages/core/telemetry.js'

// 有界队列、按批发送；不持久化事件，不产生用户或设备标识。
export function createTelemetryClient({ send, context, enabled = () => true, random = Math.random } = {}) {
  let queue = []
  let inflight = null
  return {
    track(name, fields = {}) {
      if (!enabled()) { queue = []; return }
      if (name === 'api_request' && fields.status > 0 && fields.status < 400 && random() >= .2) return
      const event = normalizeTelemetryEvent({ ...context(), ...fields, name })
      if (event) queue = [...queue.slice(-39), event]
    },
    async flush({ beacon = false } = {}) {
      if (!enabled()) { queue = []; return }
      if (inflight || !queue.length) return inflight
      const events = queue.splice(0, 20)
      // 发送失败丢弃当前批次，避免弱网持续积压和无限重试。
      inflight = Promise.resolve().then(() => send({ events }, beacon)).catch(() => {}).finally(() => { inflight = null })
      return inflight
    },
    clear() { queue = [] },
    get pending() { return queue.length },
  }
}
