'use strict'

const https = require('node:https')
const { randomUUID } = require('node:crypto')

const TIMEOUT_MS = 30000

function targetFromEnv(env) {
  const key = String(env.WESHIRT_SYNC_KEY || '').trim()
  if (!key) return { error: 'missing_sync_key' }
  let target
  try { target = new URL(String(env.WESHIRT_SYNC_URL || '').trim()) }
  catch { return { error: 'invalid_sync_url' } }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/api/cron/sync') return { error: 'invalid_sync_url' }
  return { target, key }
}

// 仅触发服务端共用同步流程；不读取上游、不复制抓取规则，也不回传响应正文。
function ping(target, key, request = https.request) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ k: key })
    let finished = false
    let timer = null
    let req
    let trace = 'trigger_' + randomUUID().replace(/-/g, '').slice(0, 24)
    const finish = (value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(value.ok ? value : { ...value, status: value.status || 0, eventId: trace })
    }
    try {
      req = request({ protocol: target.protocol, hostname: target.hostname, port: target.port || 443, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'accept': 'application/json' } }, (res) => {
        const status = Number(res.statusCode) || 0
        const suppliedTrace = res.headers?.['x-event-id']
        if (typeof suppliedTrace === 'string' && /^evt_[a-f0-9]{24}$/.test(suppliedTrace)) trace = suppliedTrace
        // 响应可能包含部署诊断信息。直接消费并丢弃，不放进日志或返回值。
        res.resume()
        res.on('error', () => finish({ ok: false, reason: 'response_error', status }))
        res.on('end', () => finish(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, reason: 'http_error', status }))
      })
      req.on('error', () => finish({ ok: false, reason: 'network_error' }))
      // 完整请求的总时限；socket活动不能无限延长函数运行。
      timer = setTimeout(() => { finish({ ok: false, reason: 'timeout' }); req.destroy() }, TIMEOUT_MS)
      req.write(payload)
      req.end()
    } catch { finish({ ok: false, reason: 'request_error' }); req?.destroy() }
  })
}

exports.main = async () => {
  const config = targetFromEnv(process.env)
  const result = config.error
    ? { ok: false, reason: config.error, status: 0, eventId: 'trigger_' + randomUUID().replace(/-/g, '').slice(0, 24) }
    : await ping(config.target, config.key)
  // 仅留下固定分类、状态码和关联标识，可与服务端事件对照。
  if (!result.ok) console.warn(JSON.stringify({ eventId: result.eventId, status: result.status, reason: result.reason }))
  return result
}

// 纯本地测试入口，不连接真实服务、不输出环境配置。
exports._test = { targetFromEnv, ping, TIMEOUT_MS }
