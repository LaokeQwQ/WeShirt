// 出口池（账号 / 代理）通用选择逻辑
//
// 纯函数，不碰任何运行时 API —— EdgeOne 边缘函数和 Node 都能 import。
// 之所以单独拆出来：账号池和代理池的"轮询 + 失败冷却"是同一套规则，
// 抄两遍迟早会不一致（一个修了 bug 另一个没修）。

/**
 * 从池里挑一个可用的下标。
 *
 * 规则：
 * - 从 state.idx 开始往后找第一个不在冷却里的；
 * - 全在冷却时挑**最早解冻**的那个硬试，避免一次集体故障就彻底停摆；
 * - 永远返回合法下标（size 为 0 时返回 -1）。
 */
export function pickIndex(size, state, now = Date.now()) {
  const n = Number(size) || 0
  if (n <= 0) return -1
  const cool = (state && state.cool) || {}
  const start = ((Number(state && state.idx) || 0) % n + n) % n

  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if ((Number(cool[i]) || 0) <= now) return i
  }

  let best = start
  let bestAt = Number(cool[start]) || 0
  for (let i = 0; i < n; i++) {
    const at = Number(cool[i]) || 0
    if (at < bestAt) {
      best = i
      bestAt = at
    }
  }
  return best
}

/**
 * 根据本次结果推进状态。
 * - 成功：解除该下标冷却，下标前移（轮询）
 * - 失败：冷却该下标（只有 1 个时**不**冷却，否则自己把自己锁死），下标前移
 */
export function nextState(state, index, size, { ok, cooldownMs = 0, now = Date.now() } = {}) {
  const n = Number(size) || 0
  const cool = { ...((state && state.cool) || {}) }
  if (n > 0 && index >= 0) {
    if (ok) {
      delete cool[index]
    } else if (n > 1 && cooldownMs > 0) {
      cool[index] = now + cooldownMs
    }
  }
  return { idx: n > 0 ? (index + 1) % n : 0, cool }
}

/**
 * 解析代理池配置。
 *
 *   HAIER_PROXIES=["http://u:p@1.2.3.4:8080","http://5.6.7.8:3128"]
 *   HAIER_PROXIES=[{"url":"http://1.2.3.4:8080"}, ...]
 *
 * 只做解析和校验，不做任何连接 —— 当前 Edge 运行时无法指定代理出口，
 * 这个池要等抓取搬到 Node（见 docs/EGRESS.md 方案 3）之后才有意义。
 * 现在留着的价值：配置格式和选择规则先定死，接的时候不用改业务代码。
 */
export function parseProxyPool(env = {}) {
  if (!env.HAIER_PROXIES) return []
  let list = null
  try {
    list = JSON.parse(env.HAIER_PROXIES)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []

  const out = []
  const seen = new Set()
  for (const item of list) {
    const url = typeof item === 'string' ? item : item && item.url
    if (typeof url !== 'string') continue
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push({ url: trimmed })
  }
  return out
}

/** 日志/响应里展示代理时用：只留协议 + 主机，绝不带账号密码 */
export function maskProxy(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`
  } catch {
    return '(invalid)'
  }
}
