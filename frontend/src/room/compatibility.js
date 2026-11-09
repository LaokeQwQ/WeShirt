const REASONS = new Set(['webgl2_unavailable', 'module_failed', 'load_timeout', 'initialization_failed', 'render_failed', 'context_lost'])
export function roomFailureReason(reason) { return REASONS.has(reason) ? reason : 'render_failed' }
export function isEmbeddedRoomBrowser(userAgent = globalThis.navigator?.userAgent || '') {
  return /DingTalk|AliApp\(DingTalk/i.test(userAgent)
}

// Probe the actual API; the WebGL2 constructor alone does not mean the GPU is enabled.
export function probeRoomSupport({ document = globalThis.document } = {}) {
  let context
  try {
    const canvas = document?.createElement('canvas')
    context = canvas?.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'default' })
    return { ok: Boolean(context), reason: context ? null : 'webgl2_unavailable' }
  } catch { return { ok: false, reason: 'webgl2_unavailable' } }
  finally { try { context?.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* Probe cleanup is best effort. */ } }
}

// Keep normal browsers' quality selection; embedded WebViews begin with a smaller GPU load.
export function createCompatibleRenderer(Renderer, options = {}, { document = globalThis.document, userAgent = globalThis.navigator?.userAgent || '' } = {}) {
  const { quality = 'mid', ...base } = options
  const embedded = isEmbeddedRoomBrowser(userAgent)
  const choices = embedded ? ['low'] : [quality, 'low']
  for (const selected of [...new Set(choices)]) {
    const canvas = document.createElement('canvas')
    const conservative = embedded || selected === 'low'
    try {
      const renderer = new Renderer({ ...base, canvas,
        antialias: conservative ? false : base.antialias !== false,
        powerPreference: conservative ? 'default' : base.powerPreference || 'high-performance',
      })
      if (renderer.debug) renderer.debug.onShaderError = () => {
        const error = new Error('3D shader compilation failed')
        error.code = 'ROOM_SHADER_FAILED'
        throw error
      }
      return { renderer, quality: selected, conservative }
    } catch {
      try { canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* Do not retain a failed context. */ }
    }
  }
  const error = new Error('3D initialization failed')
  error.code = 'ROOM_INITIALIZATION_FAILED'
  throw error
}

export function signalRoomFailure(element, reason = 'render_failed') {
  const EventClass = element?.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent
  if (element?.dispatchEvent && EventClass) element.dispatchEvent(new EventClass('weshirt-room-failure', {
    bubbles: true, detail: { reason: roomFailureReason(reason) },
  }))
}

// A timed-out import can still settle; generations keep it from replacing the fallback/retry.
export function createRoomLoadSession({ load, probe = probeRoomSupport, onChange = () => {}, timeoutMs = 15000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let generation = 0, timer = null, disposed = false
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null }
  const update = state => { if (!disposed) onChange(state) }
  const fail = reason => { generation++; clear(); update({ phase: 'failed', reason: roomFailureReason(reason), component: null }) }
  return {
    async start() {
      if (disposed) return
      const request = ++generation
      clear(); update({ phase: 'checking', reason: null, component: null })
      let supported
      try { supported = probe().ok } catch { supported = false }
      if (!supported) { fail('webgl2_unavailable'); return }
      update({ phase: 'loading', reason: null, component: null })
      timer = setTimer(() => { if (request === generation) fail('load_timeout') }, timeoutMs)
      try {
        const module = await load()
        if (disposed || request !== generation) return
        clear()
        if (!module?.default) { fail('module_failed'); return }
        update({ phase: 'ready', reason: null, component: module.default })
      } catch { if (!disposed && request === generation) fail('module_failed') }
    },
    fail,
    dispose() { disposed = true; generation++; clear() },
  }
}
