const errors = {
  'not-allowed': '请在浏览器允许麦克风权限，或改用文字输入。',
  'service-not-allowed': '当前浏览器无法使用语音识别，请改用文字输入。',
  'audio-capture': '未检测到可用麦克风，请检查权限与设备。',
  'no-speech': '没有识别到语音，请再试一次。',
  network: '语音识别服务连接失败，请再试或改用文字输入。',
  'language-not-supported': '当前浏览器的语音服务不支持中文识别。',
}

export function createAssistantSpeech(browser, { onActive, onText, onError }) {
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition
  const supported = typeof Recognition === 'function' && browser.isSecureContext !== false
  let active = null
  function finish(instance, abort = false) {
    if (active !== instance) return
    active = null
    clearTimeout(instance.endTimer)
    instance.onresult = instance.onerror = instance.onend = null
    if (abort) {
      try { instance.abort() } catch { /* Recognition might not have started. */ }
    }
    onActive(false)
  }
  return {
    supported,
    start() {
      if (!supported || active) return
      try {
        const instance = new Recognition()
        active = instance
        instance.lang = 'zh-CN'
        instance.continuous = false
        instance.interimResults = false
        instance.onresult = event => {
          if (active !== instance) return
          const text = Array.from(event.results).slice(event.resultIndex ?? 0)
            .filter(result => result.isFinal).map(result => result[0]?.transcript?.trim()).filter(Boolean).join(' ')
          if (text) onText(text)
        }
        instance.onerror = event => {
          if (active !== instance) return
          finish(instance)
          if (event.error !== 'aborted') onError(errors[event.error] || '语音识别失败，请再试或改用文字输入。')
        }
        instance.onend = () => finish(instance)
        onActive(true)
        instance.start()
        if (active === instance) instance.endTimer = setTimeout(() => finish(instance, true), 30000)
      } catch {
        if (active) finish(active, true)
        onError('暂时无法启动语音识别，请检查麦克风权限。')
      }
    },
    stop() {
      if (!active) return
      try { active.stop() } catch { finish(active, true) }
    },
    abort() { if (active) finish(active, true) },
  }
}

const SAMPLE_RATE = 16000
const MAX_SECONDS = 30

export function pcm16Wav(samples, sourceRate) {
  if (!Number.isFinite(sourceRate) || sourceRate < 8000 || sourceRate > 192000) throw new Error('麦克风采样率不受支持')
  const sourceFrames = Math.min(samples.length, sourceRate * MAX_SECONDS)
  const frames = Math.floor(sourceFrames * SAMPLE_RATE / sourceRate)
  if (frames < SAMPLE_RATE / 5) throw new Error('语音太短，请再试一次')
  const bytes = new ArrayBuffer(44 + frames * 2)
  const data = new DataView(bytes)
  const ascii = (offset, text) => Array.from(text).forEach((character, i) => data.setUint8(offset + i, character.charCodeAt(0)))
  ascii(0, 'RIFF'); data.setUint32(4, bytes.byteLength - 8, true)
  ascii(8, 'WAVE'); ascii(12, 'fmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true); data.setUint16(22, 1, true)
  data.setUint32(24, SAMPLE_RATE, true); data.setUint32(28, SAMPLE_RATE * 2, true)
  data.setUint16(32, 2, true); data.setUint16(34, 16, true)
  ascii(36, 'data'); data.setUint32(40, frames * 2, true)
  const ratio = sourceRate / SAMPLE_RATE
  for (let i = 0; i < frames; i++) {
    const from = Math.floor(i * ratio)
    const to = Math.max(from + 1, Math.min(sourceFrames, Math.floor((i + 1) * ratio)))
    let total = 0
    for (let j = from; j < to; j++) total += samples[j]
    const sample = Math.min(1, Math.max(-1, total / (to - from)))
    data.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

export function createAssistantMic(browser, workletUrl, { onActive, onAudio, onError }) {
  const Audio = browser.AudioContext || browser.webkitAudioContext
  const supported = browser.isSecureContext !== false && typeof Audio === 'function' &&
    typeof browser.AudioWorkletNode === 'function' && typeof browser.navigator?.mediaDevices?.getUserMedia === 'function'
  let active = null
  function clean(instance) {
    clearTimeout(instance.endTimer)
    if (instance.node) {
      instance.node.port.onmessage = null
      instance.node.disconnect()
    }
    instance.source?.disconnect()
    instance.stream?.getTracks().forEach(track => track.stop())
    if (instance.context?.state !== 'closed') void instance.context?.close().catch(() => {})
  }
  function finish(instance, keepAudio) {
    if (active !== instance) return
    active = null
    clean(instance)
    onActive(false)
    if (keepAudio) {
      try {
        const samples = new Float32Array(instance.size)
        let offset = 0
        for (const chunk of instance.chunks) { samples.set(chunk, offset); offset += chunk.length }
        onAudio(pcm16Wav(samples, instance.sampleRate))
      } catch (error) { onError(error.message || '未录到语音，请再试一次。') }
    }
  }
  return {
    supported,
    async start() {
      if (!supported || active) return
      const instance = { chunks: [], size: 0 }
      active = instance
      onActive(true)
      try {
        const context = instance.context = new Audio()
        const resumed = context.resume().catch(() => {})
        instance.stream = await browser.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false })
        if (active !== instance) { clean(instance); return }
        await Promise.all([resumed, context.audioWorklet.addModule(workletUrl)])
        if (active !== instance) return
        instance.sampleRate = context.sampleRate
        instance.source = context.createMediaStreamSource(instance.stream)
        const node = instance.node = new browser.AudioWorkletNode(context, 'assistant-mic', { channelCount: 1, channelCountMode: 'explicit' })
        node.port.onmessage = ({ data }) => {
          if (active !== instance) return
          if (data.done) { finish(instance, true); return }
          if (!(data.samples instanceof Float32Array) || instance.size + data.samples.length > context.sampleRate * MAX_SECONDS) return
          instance.chunks.push(data.samples)
          instance.size += data.samples.length
        }
        instance.source.connect(node).connect(context.destination)
        instance.endTimer = setTimeout(() => finish(instance, true), (MAX_SECONDS + 1) * 1000)
      } catch (error) {
        if (active !== instance) return
        finish(instance, false)
        onError(error.name === 'NotAllowedError' ? errors['not-allowed'] : '无法使用麦克风，请检查设备权限或改用文字输入。')
      }
    },
    stop() {
      const instance = active
      if (!instance) return
      if (instance.node) instance.node.port.postMessage('stop')
      else finish(instance, false)
    },
    abort() { if (active) finish(active, false) },
  }
}
