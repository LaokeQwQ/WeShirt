// WeShirt · Node 服务器形态入口
// process.env → FileStore + createApp → @hono/node-server 启动 → 每 30s runSync（启动先跑一次）→ 优雅退出

import { lookup } from 'node:dns/promises'
import { serve } from '@hono/node-server'
import { createFileStore } from '../packages/core/store-node.js'
import { createApp, runSync } from './app.js'
import { warn, log } from '../packages/core/util.js'

const PORT = Number(process.env.PORT) || 8787
const DATA_DIR = process.env.DATA_DIR || './data'

async function main() {
  const store = await createFileStore(DATA_DIR)
  const env = {...process.env,ASSISTANT_RESOLVE_HOST:(hostname)=>lookup(hostname,{all:true})}
  const app = createApp({ store, env })

  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    log(`server listening on http://localhost:${info.port}  (data=${DATA_DIR})`)
  })

  // 启动先跑一次同步
  runSync(env, store)
    .then((r) => log('initial runSync:', JSON.stringify(pickSafe(r))))
    .catch((e) => warn('initial runSync failed:', e && e.message))

  // 每 30s 同步（前端轮询 30s，最长延迟约 1 分钟）
  const timer = setInterval(() => {
    runSync(env, store)
      .then((r) => log('runSync:', JSON.stringify(pickSafe(r))))
      .catch((e) => warn('runSync failed:', e && e.message))
  }, 30 * 1000)

  if (timer.unref) timer.unref()

  // 优雅退出
  let closing = false
  async function shutdown(signal) {
    if (closing) return
    closing = true
    log(`received ${signal}, shutting down...`)
    clearInterval(timer)
    try {
      if (store && typeof store.flushNow === 'function') store.flushNow()
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0))
    // 兜底
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

function pickSafe(r) {
  if (!r) return r
  const { error, ...rest } = r
  return error ? { ...rest, error } : rest
}

main().catch((e) => {
  console.error('[weshirt] fatal:', e)
  process.exit(1)
})
