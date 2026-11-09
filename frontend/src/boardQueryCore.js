// 可注入请求实现，浏览器与 node:test 共用相同的缓存/并发规则。
export function createBoardQuery(request, { ttlMs = 5000, cooldownMs = 5000, now = Date.now } = {}) {
  const entries = new Map()
  return function loadBoard({ force = false, dorm = '' } = {}) {
    if (dorm && !/^[a-z][a-z0-9_-]{0,31}$/.test(dorm)) return Promise.reject(new Error('请选择有效的住宿楼'))
    if (!entries.has(dorm)) entries.set(dorm, { cached: null, cachedAt: 0, inflight: null, retryAt: 0, lastError: null })
    const entry = entries.get(dorm)
    if (entry.inflight) return entry.inflight
    if (!force && entry.cached && now() - entry.cachedAt < ttlMs) return Promise.resolve(entry.cached)
    if (!force && entry.lastError && now() < entry.retryAt) return Promise.reject(entry.lastError)
    entry.inflight = Promise.resolve().then(() => request('/api/machines' + (dorm ? '?dorm=' + dorm : ''), { auth: false })).then((data) => {
      if (!Array.isArray(data?.board?.floors)) throw new Error('看板数据格式异常，请稍后重试')
      if (dorm && data.board.dormBuilding !== dorm) throw new Error('楼栋数据不匹配，请刷新重试')
      entry.cached = { ...data, board: { ...data.board, slotMapping: data.mapping || {} } }
      entry.cachedAt = now()
      entry.lastError = null
      entry.retryAt = 0
      return entry.cached
    }).catch((error) => {
      entry.lastError = error
      entry.retryAt = now() + cooldownMs
      throw error
    }).finally(() => { entry.inflight = null })
    return entry.inflight
  }
}
