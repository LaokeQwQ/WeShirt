// 可选的浏览器直连客户端。业务页面使用自家看板，保持机位绑定、估时和故障修正一致。
import { normalizeMachines, DEFAULT_STATE_MAP } from '../../packages/core/haier.js'
import { buildBoard, computeLeftMin } from '../../packages/core/machines.js'

const META_TTL_MS = 5 * 60000
const PAGE_SIZE = 100
const MAX_PAGES = 20
const CONCURRENCY = 4

/** 与服务端共享状态码和时间解析，避免两条查询链路得出相反状态。 */
export function rawToMachines(raws, stateMap = DEFAULT_STATE_MAP) {
  const nowISO = new Date().toISOString()
  return normalizeMachines((Array.isArray(raws) ? raws : []).filter((raw) => raw && (raw.deviceId ?? raw.id) != null)
    .map((raw) => ({ ...raw, id: String(raw.deviceId ?? raw.id), floorCode: String(raw.floorCode ?? '') })), stateMap)
    .filter((m) => m.id)
    .map((m) => {
      const left = computeLeftMin(m.finishAt, nowISO)
      return { ...m, leftMin: left == null ? null : Math.max(0, left) }
    })
}

export function createDirectBoardClient({
  getInfo = async () => {
    const { api } = await import('./api.js')
    return api('/api/upstream-info', { auth: false, timeout: 5000 })
  },
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let infoCache = null
  let infoInflight = null
  let metadata = null
  let inflight = null
  let cooldownUntil = 0
  let failures = 0

  async function upstreamInfo() {
    if (infoCache && now() < infoCache.expiresAt) return infoCache.value
    if (!infoInflight) {
      infoInflight = Promise.resolve().then(getInfo).then((value) => {
        if (!value?.base || !value?.positionId) throw new Error('上游信息缺失')
        infoCache = { value, expiresAt: now() + META_TTL_MS }
        return value
      }).finally(() => { infoInflight = null })
    }
    return infoInflight
  }

  async function perform(timeoutMs) {
    const info = await upstreamInfo()
    const base = String(info.base).replace(/\/+$/, '')
    const pid = /^\d+$/.test(String(info.positionId)) ? Number(info.positionId) : String(info.positionId)
    const metadataKey = `${base}|${pid}`
    // 一次完整查询共用总预算；超时或任一分组失败时取消其余请求。
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, Math.max(1, timeoutMs))
    const getJson = async (url, init = {}) => {
      const r = await fetchImpl(url, { ...init, signal: ctrl.signal })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      if (!j || j.code !== 0) throw new Error('上游返回异常')
      return j.data
    }

    try {
      let combos
      if (metadata?.key === metadataKey && now() < metadata.expiresAt) combos = metadata.combos
      else {
        const [floors, cats] = await Promise.all([
          getJson(`${base}/position/floorCodeList?positionId=${encodeURIComponent(pid)}`),
          getJson(`${base}/position/positionDevice?id=${encodeURIComponent(pid)}`),
        ])
        if (!Array.isArray(floors) || !Array.isArray(cats)) throw new Error('上游元数据异常')
        const floorList = [...new Set(floors.map(String))]
        const catList = [...new Set(cats.filter((c) => Number(c?.total) > 0).map((c) => String(c.categoryCode)))]
        combos = floorList.flatMap((floorCode) => catList.map((categoryCode) => [floorCode, categoryCode]))
        metadata = { key: metadataKey, combos, expiresAt: now() + META_TTL_MS }
      }

      const groups = new Array(combos.length)
      let cursor = 0
      let failure = null
      const pullCombo = async ([floorCode, categoryCode]) => {
        const raws = []
        for (let page = 1; page <= MAX_PAGES; page++) {
          const data = await getJson(`${base}/position/deviceDetailPage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ positionId: pid, floorCode, categoryCode, page, pageSize: PAGE_SIZE }),
          })
          if (!Array.isArray(data?.items)) throw new Error('上游设备分页异常')
          raws.push(...data.items.map((raw) => ({ ...raw, categoryCode, floorCode: raw.floorCode ?? floorCode })))
          const total = Number(data.total) || 0
          if (!data.items.length && total > raws.length) throw new Error('上游设备分页不完整')
          if ((total > 0 && raws.length >= total) || (total <= 0 && data.items.length < PAGE_SIZE)) return raws
        }
        throw new Error('上游设备超过分页限制')
      }
      const settled = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, combos.length) }, async () => {
        while (cursor < combos.length && !ctrl.signal.aborted) {
          const index = cursor++
          try { groups[index] = await pullCombo(combos[index]) }
          catch (e) { failure ||= e; ctrl.abort(); throw e }
        }
      }))
      const failed = settled.find((s) => s.status === 'rejected')
      if (failed) throw failure || failed.reason
      const seen = new Set()
      const machines = rawToMachines(groups.flat(), info.stateMap).filter((m) => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
      if (!machines.length) throw new Error('没读到机器')
      return {
        board: buildBoard(machines, { buildingId: info.buildingId || 'b1', buildingName: info.buildingName || '' }),
        source: 'haier-direct',
      }
    } catch (e) {
      if (timedOut) throw new Error('上游超时')
      throw e
    } finally {
      clearTimeout(timer)
      ctrl.abort()
    }
  }

  function fetchBoardDirect(timeoutMs = 5000) {
    if (inflight) return inflight
    if (now() < cooldownUntil) return Promise.reject(new Error('上游暂不可用，请使用缓存看板'))
    inflight = perform(timeoutMs).then((value) => {
      failures = 0
      cooldownUntil = 0
      return value
    }).catch((e) => {
      failures += 1
      cooldownUntil = now() + Math.min(120000, failures * 30000)
      throw e
    }).finally(() => { inflight = null })
    return inflight
  }

  return { upstreamInfo, fetchBoardDirect }
}

const client = createDirectBoardClient()
export const upstreamInfo = client.upstreamInfo
export const fetchBoardDirect = client.fetchBoardDirect
