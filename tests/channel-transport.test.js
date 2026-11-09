import test from 'node:test'
import assert from 'node:assert/strict'
import { createChannelTransport } from '../frontend/src/channelTransport.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
function fakeSockets() {
  const sockets = []
  class Socket {
    constructor(url, protocol) { this.url = url; this.protocol = protocol; this.readyState = 0; this.sent = []; sockets.push(this) }
    send(text) { this.sent.push(JSON.parse(text)) }
    close() { this.readyState = 3; this.onclose?.() }
    open() { this.readyState = 1; this.onopen?.() }
    message(data) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }) }
  }
  return { sockets, Socket }
}
const config = () => ({ enabled: true, url: 'wss://gateway.example.test', protocol: 'weshirt.channel.v1', ticket: 'ticket-not-in-url', expiresAt: Date.now() + 120000 })

test('channel transport authenticates in its first frame and refreshes only the current channel on ready/change', async () => {
  const { sockets, Socket } = fakeSockets(); let refreshes = 0
  const transport = createChannelTransport({ configure: async () => config(), refresh: () => refreshes++, WebSocketImpl: Socket, visible: () => true })
  try {
    transport.start('guiyuan'); await tick()
    const ws = sockets[0]; assert.equal(ws.protocol, 'weshirt.channel.v1'); assert.equal(ws.url.includes('ticket'), false)
    ws.open(); assert.deepEqual(ws.sent, [{ type: 'authenticate', ticket: 'ticket-not-in-url' }])
    ws.message({ type: 'ready', channel: 'guiyuan' }); ws.message({ type: 'channel.changed', channel: 'guiyuan', revision: 'changed' })
    assert.equal(refreshes, 2)
    ws.message({ type: 'channel.changed', channel: 'liuyuan' }); assert.equal(refreshes, 2); assert.equal(ws.readyState, 3)
  } finally { transport.stop() }
})

test('missing/unsafe gateway configuration never opens a socket or sends credentials', async () => {
  for (const url of ['https://gateway.example.test', 'wss://user:secret@gateway.example.test', 'wss://gateway.example.test/?ticket=secret']) {
    const { sockets, Socket } = fakeSockets()
    const transport = createChannelTransport({ configure: async () => ({ ...config(), url }), refresh() {}, WebSocketImpl: Socket, visible: () => true })
    transport.start('public'); await tick(); transport.stop(); assert.equal(sockets.length, 0)
  }
})

test('hidden pages close the connection and resume with current auth; stale configure responses cannot attach', async () => {
  const { sockets, Socket } = fakeSockets(); let visible = true, resolveOld
  const old = new Promise((resolve) => { resolveOld = resolve })
  const transport = createChannelTransport({ configure: (channel) => channel === 'public' ? old : Promise.resolve(config()), refresh() {}, WebSocketImpl: Socket, visible: () => visible })
  try {
    transport.start('public'); transport.start('guiyuan'); await tick(); resolveOld(config()); await tick()
    assert.equal(sockets.length, 1)
    sockets[0].open(); visible = false; transport.visibilityChanged(); assert.equal(sockets[0].readyState, 3)
    await tick(); assert.equal(sockets.length, 1)
    visible = true; transport.visibilityChanged(); await tick(); assert.equal(sockets.length, 2)
  } finally { transport.stop() }
})
