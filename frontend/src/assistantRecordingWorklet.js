class AssistantMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recorded = 0
    this.limit = 30 * sampleRate
    this.buffer = new Float32Array(sampleRate)
    this.used = 0
    this.done = false
    this.port.onmessage = () => this.finish()
  }

  flush() {
    if (!this.used) return
    const samples = this.buffer.slice(0, this.used)
    this.port.postMessage({ samples }, [samples.buffer])
    this.used = 0
  }

  finish() {
    if (this.done) return
    this.flush()
    this.done = true
    this.port.postMessage({ done: true })
  }

  process(inputs) {
    if (this.done) return false
    const mono = inputs[0]?.[0]
    if (mono?.length) {
      const count = Math.min(mono.length, this.limit - this.recorded)
      for (let i = 0; i < count; i++) {
        this.buffer[this.used++] = mono[i]
        if (this.used === this.buffer.length) this.flush()
      }
      this.recorded += count
      if (this.recorded >= this.limit) this.finish()
    }
    return !this.done
  }
}

registerProcessor('assistant-mic', AssistantMicProcessor)
