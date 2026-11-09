// WeShirt · 上报留档的照片生命周期管理
//
// 为什么单独一个模块：凭证照片是最大的 KV 占用来源（每张约 50~150KB），
// 而 KV 没有 TTL。之前只能靠管理员手动点「清理」，实际上没人点。
// 现在两处都用这套逻辑：
//   1. 新建留档时顺手清一小批（懒清理，成本恒定）
//   2. 管理端手动全量清理
//
// 只删照片（urgephoto:*），审计记录（urgeaudit:*）永久保留——
// 那是纠纷追溯的依据，删掉就失去意义了。

const PHOTO_KINDS = ['occ', 'around']

/**
 * 清理过期照片。
 * @param {object} store
 * @param {{days?: number, max?: number}} opts
 *   days 保留天数（默认 30）；max 单次最多清多少条审计（默认 5，用于懒清理限流）
 * @returns {{scanned:number, expired:number, removed:number, skipped:number}}
 */
export async function pruneAuditPhotos(store, { days = 30, max = 0 } = {}) {
  const out = { scanned: 0, expired: 0, removed: 0, skipped: 0 }
  if (!store) return out

  const entries = await store.list('urgeaudit:').catch(() => null)
  const list = Array.isArray(entries) ? entries : []
  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000

  for (const e of list) {
    const v = e && e.value
    if (!v || !v.auditId) continue
    out.scanned++

    const at = new Date(v.at).getTime()
    // 时间解析不出来就当作「不删」，宁可留着也别误删证据
    if (Number.isNaN(at) || at >= cutoff) continue
    out.expired++

    if (max > 0 && out.removed >= max) {
      out.skipped++
      continue
    }

    for (const kind of PHOTO_KINDS) {
      const key = `urgephoto:${v.auditId}:${kind}`
      const exists = await store.get(key, null).catch(() => null)
      if (exists) {
        await store.del(key).catch(() => {})
        out.removed++
      }
    }
    // 标记已清理，避免下次重复扫描同一批 key（audit 记录本身保留）
    if (!v.photosPrunedAt) {
      await store
        .put(e.key, { ...v, photosPrunedAt: new Date().toISOString() })
        .catch(() => {})
    }
  }

  return out
}

/** 取某条留档的照片（不存在返回 null，供接口用） */
export async function getAuditPhoto(store, auditId, kind) {
  if (!PHOTO_KINDS.includes(kind)) return null
  return store.get(`urgephoto:${auditId}:${kind}`, null).catch(() => null)
}

export { PHOTO_KINDS }
