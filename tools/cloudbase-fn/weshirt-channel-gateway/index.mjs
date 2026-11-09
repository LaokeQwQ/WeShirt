import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'

export const PROTOCOL = 'weshirt.channel.v1'
const CHANNEL = /^[a-z][a-z0-9_-]{0,63}$/
const REVISION = /^[A-Za-z0-9_-]{1,100}$/
const MAX_FRAME = 4096

export class RelayError extends Error {
  constructor(code, { retry = false, waitMs = 0 } = {}) {
    super(code)
    this.code = code
    this.retry = retry
    this.waitMs = waitMs
  }
}

// Configuration is deployment-owned; clients cannot supply a destination URL.
export function publicOrigin(value) {
  const u = new URL(String(value || ''))
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|test|invalid)$/.test(host)) {
    throw new Error('invalid_relay_origin')
  }
  return u.origin
}

export function loadConfig(env = process.env) {
  const apiOrigin = publicOrigin(env.EDGE_API_ORIGIN)
  const origins = new Set(String(env.COMMUNITY_WS_ALLOWED_ORIGINS || '').split(',').filter(Boolean).map(v => publicOrigin(v.trim())))
  if (!origins.size) throw new Error('missing_relay_origins')
  return { apiOrigin, origins }
}

// This is only a shape/expiry prefilter. The fixed backend verifies the signature,
// account, channel ACL and persistent connection lease before ready is emitted.
export function ticketDetails(ticket, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket)) throw new RelayError('invalid_ticket')
  let p
  try { p = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url').toString('utf8')) } catch { throw new RelayError('invalid_ticket') }
  if (p?.role !== 'community_ws' || typeof p.uid !== 'string' || !p.uid || p.uid.length > 128 ||
      !CHANNEL.test(p.channel) || typeof p.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(p.nonce) ||
      !Number.isSafeInteger(p.exp) || p.exp <= now || p.exp > now + 125000) throw new RelayError('invalid_ticket')
  return { channel: p.channel, exp: p.exp }
}

function checkedState(value) {
  if (!value || !CHANNEL.test(value.channel) ||
      !(Number.isSafeInteger(value.revision) && value.revision >= 0 || typeof value.revision === 'string' && REVISION.test(value.revision)) ||
      !Number.isSafeInteger(value.inboxCount) || value.inboxCount < 0 || value.inboxCount > 1000000) throw new RelayError('invalid_state')
  return { channel: value.channel, revision: value.revision, inboxCount: value.inboxCount }
}

export function createStateReader(apiOrigin, { fetchImpl = fetch, timeoutMs = 3500 } = {}) {
  const destination = new URL('/api/messages/realtime/state', publicOrigin(apiOrigin)).href
  const releaseDestination = new URL('/api/messages/realtime/release', publicOrigin(apiOrigin)).href
  const read = async (ticket, signal, connectionId) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, timeoutMs)
    try {
      const response = await fetchImpl(destination, {
        method: 'GET', headers: { Authorization: `Bearer ${ticket}`, Accept: 'application/json', 'X-Community-WS-Connection': connectionId },
        redirect: 'error', cache: 'no-store', signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401 || response.status === 403) throw new RelayError('access_denied')
        if (response.status === 429) {
          const seconds = Number(response.headers.get('retry-after'))
          throw new RelayError('rate_limited', { retry: true, waitMs: Number.isFinite(seconds) ? Math.min(20000, Math.max(4000, seconds * 1000)) : 8000 })
        }
        throw new RelayError('state_unavailable', { retry: response.status >= 500 })
      }
      const reader = response.body?.getReader()
      if (!reader) throw new RelayError('invalid_state')
      const parts = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_FRAME) { await reader.cancel(); throw new RelayError('invalid_state') }
          parts.push(Buffer.from(value))
        }
      } finally { reader.releaseLock() }
      let result
      try { result = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw new RelayError('invalid_state') }
      return checkedState(result)
    } catch (error) {
      if (error instanceof RelayError) throw error
      throw new RelayError('state_unavailable', { retry: true })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  read.release = async (ticket, connectionId) => {
    try {
      const response = await fetchImpl(releaseDestination, {
        method: 'POST', headers: { Authorization: `Bearer ${ticket}`, 'X-Community-WS-Connection': connectionId },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(1000),
      })
      await response.body?.cancel()
    } catch { /* A failed release expires with the short backend lease. */ }
  }
  return read
}

export function attachRelay(socket, readState, {
  now = Date.now, pollMs = 4000, authMs = 5000, maxLifetimeMs = 120000,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let closed = false, authenticating = false, ticket = '', channel = '', baseline = null
  const connectionId = randomBytes(12).toString('hex')
  let pollTimer, expiryTimer, failureCount = 0, lastPing = 0
  const abort = new AbortController()
  const send = (value) => {
    if (closed || socket.readyState !== 1) return false
    if (socket.bufferedAmount > MAX_FRAME * 2) { close(1013, 'slow_connection'); return false }
    try { socket.send(JSON.stringify(value)); return true } catch { close(1011, 'connection_failed'); return false }
  }
  function dispose() {
    if (closed) return
    closed = true
    const releasedTicket = ticket
    ticket = ''
    abort.abort()
    clearTimer(authTimer); clearTimer(pollTimer); clearTimer(expiryTimer)
    if (releasedTicket && readState.release) void Promise.resolve().then(() => readState.release(releasedTicket, connectionId)).catch(() => {})
  }
  function close(code, reason) {
    if (closed) return
    dispose()
    try { socket.close(code, reason) } catch { socket.terminate?.() }
  }
  const authTimer = setTimer(() => close(4401, 'authentication_required'), authMs)
  async function poll(first = false) {
    if (closed) return
    try {
      const state = checkedState(await readState(ticket, abort.signal, connectionId))
      if (closed) return
      if (state.channel !== channel) throw new RelayError('access_denied')
      failureCount = 0
      if (first) send({ type: 'ready', channel, expiresAt: new Date(expiresAt).toISOString(), revision: state.revision, inboxCount: state.inboxCount })
      else if (!baseline || state.revision !== baseline.revision || state.inboxCount !== baseline.inboxCount) {
        send({ type: 'channel.changed', ...state })
      }
      baseline = state
      if (!closed) pollTimer = setTimer(() => poll(), pollMs)
    } catch (error) {
      if (closed) return
      if (!(error instanceof RelayError) || !error.retry || ++failureCount >= 3 || first) {
        close(error?.code === 'access_denied' ? 4403 : 1013, error?.code === 'access_denied' ? 'access_denied' : 'service_unavailable')
      } else {
        pollTimer = setTimer(() => poll(), Math.max(error.waitMs || 0, Math.min(16000, pollMs * 2 ** failureCount)))
      }
    }
  }
  let expiresAt = 0
  socket.on('message', (raw, binary) => {
    if (closed) return
    if (binary || raw.byteLength > MAX_FRAME) { close(1008, 'invalid_frame'); return }
    let message
    try { message = JSON.parse(raw.toString()) } catch { close(1008, 'invalid_frame'); return }
    if (!ticket) {
      if (authenticating || message?.type !== 'authenticate' || Object.keys(message).some(k => !['type', 'ticket'].includes(k))) { close(1008, 'authentication_required'); return }
      authenticating = true
      try {
        const details = ticketDetails(message.ticket, now())
        ticket = message.ticket
        channel = details.channel
        expiresAt = Math.min(details.exp, now() + maxLifetimeMs)
        expiryTimer = setTimer(() => close(4401, 'ticket_expired'), Math.max(1, expiresAt - now()))
        clearTimer(authTimer)
        void poll(true)
      } catch { close(4401, 'invalid_ticket') }
      return
    }
    if (!baseline || message?.type !== 'ping' || Object.keys(message).length !== 1 || now() - lastPing < 1000) { close(1008, 'invalid_frame'); return }
    lastPing = now()
    send({ type: 'pong' })
  })
  socket.on('close', dispose)
  socket.on('error', () => close(1011, 'connection_failed'))
  return { close: () => close(1001, 'server_stopping') }
}

export function createRelayServer(config, { readState = createStateReader(config.apiOrigin) } = {}) {
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/health') res.end(JSON.stringify({ ok: true, protocol: PROTOCOL }))
    else { res.statusCode = 404; res.end('{"error":"not_found"}') }
  })
  const sessions = new Set()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false, handleProtocols: protocols => protocols.has(PROTOCOL) ? PROTOCOL : false })
  server.on('upgrade', (req, socket, head) => {
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(v => v.trim())
    if (!['/', '/channel'].includes(req.url) || !config.origins.has(req.headers.origin) || !protocols.includes(PROTOCOL) || sessions.size >= 8) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const session = attachRelay(ws, readState)
      sessions.add(session)
      ws.on('close', () => sessions.delete(session))
    })
  })
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  const shutdown = () => {
    for (const session of sessions) session.close()
    wss.close()
    return new Promise(resolve => server.close(resolve))
  }
  return { server, shutdown }
}

export function startRelay() {
  try {
    const { server, shutdown } = createRelayServer(loadConfig())
    server.on('error', () => { console.error('channel_relay_server_failed'); process.exitCode = 1 })
    server.listen(9000, '0.0.0.0')
    process.once('SIGTERM', () => void shutdown())
    process.once('SIGINT', () => void shutdown())
  } catch {
    // Never emit raw exceptions, configuration URLs, credentials or tickets.
    console.error('channel_relay_configuration_invalid')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startRelay()
