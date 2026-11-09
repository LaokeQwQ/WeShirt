// WS 只传变化提示，正文始终从已鉴权 HTTP 接口补拉；没有已配置网关时走可见页轮询。
export function createChannelTransport({ configure, refresh, onState = () => {}, WebSocketImpl = globalThis.WebSocket, visible = () => document.visibilityState === 'visible', now = () => Date.now() }) {
  let channel = '', socket, stopped = true, generation = 0, retry, fallback, expiry, heartbeat, attempt = 0, connected = false
  const clear = () => { clearTimeout(retry); clearTimeout(fallback); clearTimeout(expiry); clearInterval(heartbeat) }
  const validChannel = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)
  function poll() { clearTimeout(fallback); if (stopped || !visible()) return; fallback = setTimeout(() => { if (!stopped && visible()) refresh(); poll() }, connected ? 120000 : 45000) }
  function close() { const old = socket; socket = null; if (old) { old.onclose = null; old.close() } connected = false }
  async function connect() {
    if (stopped || !visible() || !validChannel(channel)) return
    const version = generation
    onState('polling'); poll()
    try {
      const config = await configure(channel)
      if (stopped || version !== generation || !visible() || !config?.enabled) return
      const url = new URL(config.url)
      if (!WebSocketImpl || url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || config.protocol !== 'weshirt.channel.v1' || typeof config.ticket !== 'string' || config.ticket.length > 4096 || !Number.isFinite(config.expiresAt) || config.expiresAt <= now()) return
      const ws = new WebSocketImpl(url.href, config.protocol); socket = ws
      ws.onopen = () => { if (version !== generation || stopped) return close(); ws.send(JSON.stringify({ type: 'authenticate', ticket: config.ticket })); expiry = setTimeout(() => ws.close(), Math.min(120000, config.expiresAt - now())) }
      ws.onmessage = (event) => {
        if (version !== generation || stopped || typeof event.data !== 'string' || event.data.length > 4096) return
        let data; try { data = JSON.parse(event.data) } catch { return ws.close() }
        if (data.type === 'pong') return
        if (data.channel !== channel || !['ready', 'channel.changed'].includes(data.type)) return ws.close()
        if (data.type === 'ready') { connected = true; attempt = 0; onState('connected'); poll(); clearInterval(heartbeat); heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })) }, 25000) }
        refresh(); globalThis.dispatchEvent?.(new Event('community:changed'))
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => { if (version !== generation || stopped) return; connected = false; clearTimeout(expiry); clearInterval(heartbeat); onState('polling'); poll(); retry = setTimeout(connect, Math.min(60000, 3000 * 2 ** Math.min(attempt++, 4))) }
    } catch { if (!stopped && version === generation) retry = setTimeout(connect, Math.min(60000, 5000 * 2 ** Math.min(attempt++, 4))) }
  }
  return {
    start(value) { clear(); close(); generation++; channel = value; stopped = false; connect() },
    visibilityChanged() { clear(); close(); generation++; if (!stopped && visible()) { refresh(); connect() } },
    stop() { stopped = true; generation++; clear(); close(); onState('stopped') },
  }
}
