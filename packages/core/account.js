// WeShirt · 账号身份迁移
//
// 为什么需要：匿名身份只靠 localStorage 里的 token 维持。换设备、清缓存、
// 从另一个入口（PWA 图标 / 预览域名 / 内置浏览器）打开，就会拿到一个全新的
// 匿名用户；而钉钉身份是稳定的，所以「用钉钉登录把旧账号找回来」是正解。
//
// 找回之后要把新匿名用户身上的活动并到旧账号上，否则用户会觉得「刚登记的就没了」。
// 这个模块只做数据搬运，不碰 token / HTTP。

/**
 * 把 fromId 名下的活动并到 toId。
 * 只搬「用户产生的活动」，不搬资料（昵称/头像以 toId 为准，那才是用户认得的身份）。
 *
 * @param {object} store
 * @param {string} fromId 要废弃的匿名用户
 * @param {string} toId   要保留的真实用户
 * @param {{buildingId?: string, nick?: string}} opts
 * @returns {Promise<{messages:number, tasks:number, queue:number, occupancy:number}>}
 */
export async function mergeUserActivity(store, fromId, toId, opts = {}) {
  const out = { messages: 0, tasks: 0, queue: 0, occupancy: 0 }
  if (!fromId || !toId || fromId === toId) return out
  const buildingId = opts.buildingId || 'b1'
  const nick = opts.nick || ''

  // 留言：改 owner，昵称也换成新身份，避免留言板上出现两个名字
  try {
    const list = await store.get(`messages:${buildingId}`, [])
    const arr = Array.isArray(list) ? list : []
    let touched = false
    for (const m of arr) {
      if (m && m.userId === fromId) {
        m.userId = toId
        if (nick) m.nick = nick
        touched = true
        out.messages++
      }
    }
    if (touched) await store.put(`messages:${buildingId}`, arr)
  } catch {
    /* 单步失败不影响其它步骤 */
  }

  // 洗衣任务：合并数组，按 id 去重（同一台机器的重复登记保留较早那条）
  try {
    const fromTasks = await store.get(`tasks:${fromId}`, [])
    const from = Array.isArray(fromTasks) ? fromTasks : []
    if (from.length) {
      const toTasks = await store.get(`tasks:${toId}`, [])
      const to = Array.isArray(toTasks) ? toTasks : []
      const seen = new Set(to.map((t) => t && t.id))
      for (const t of from) {
        if (!t || !t.id || seen.has(t.id)) continue
        seen.add(t.id)
        to.push(t)
        out.tasks++
      }
      await store.put(`tasks:${toId}`, to)
      await store.del(`tasks:${fromId}`)
    }
  } catch {
    /* 忽略 */
  }

  // 排队：改 userId（同一台机器只留一条，避免自己排两次）
  try {
    const list = await store.get(`queue:${buildingId}`, [])
    const arr = Array.isArray(list) ? list : []
    const mine = arr.filter((q) => q && q.userId === fromId)
    if (mine.length) {
      const kept = arr.filter((q) => q && q.userId !== fromId)
      const seenMachine = new Set(kept.map((q) => q && q.machineId))
      for (const q of mine) {
        if (seenMachine.has(q.machineId)) continue
        seenMachine.add(q.machineId)
        kept.push({ ...q, userId: toId, nick: nick || q.nick })
        out.queue++
      }
      await store.put(`queue:${buildingId}`, kept)
    }
  } catch {
    /* 忽略 */
  }

  // 占用登记：改 userId
  try {
    const occ = await store.get(`occupancy:${buildingId}`, {})
    if (occ && typeof occ === 'object') {
      let touched = false
      for (const k of Object.keys(occ)) {
        const e = occ[k]
        if (e && e.userId === fromId) {
          e.userId = toId
          if (nick) e.nick = nick
          touched = true
          out.occupancy++
        }
      }
      if (touched) await store.put(`occupancy:${buildingId}`, occ)
    }
  } catch {
    /* 忽略 */
  }

  return out
}

/**
 * 找一个「已存在的真实身份」用于找回：
 * 依次按 钉钉 userId → unionId → 手机号 匹配。
 * 手机号匹配要扫全表，用 limit 兜住（用户量小，几十到几百）。
 *
 * @returns {Promise<{user: object|null, via: string}>}
 */
export async function findExistingUser(store, { dingUserId, unionId, mobile, excludeId } = {}) {
  const scanUsers = async (match, limit = 1000) => {
    const entries = await store.list('user:').catch(() => [])
    const list = Array.isArray(entries) ? entries : []
    let scanned = 0
    for (const e of list) {
      if (++scanned > limit) break
      const u = e && e.value
      if (!u || !u.id || u.id === excludeId) continue
      if (match(u)) return u
    }
    return null
  }

  if (dingUserId) {
    const uid = await store.get(`userByDing:${dingUserId}`, null)
    if (uid && uid !== excludeId) {
      const u = await store.get(`user:${uid}`, null)
      if (u) return { user: u, via: 'ding' }
    }
    // 兜底：索引可能没写上（历史数据是分步写入的，中途失败就会缺）。
    // 少了这层，老用户登录会被当成新用户，看起来就是「数据全没了」。
    const u = await scanUsers((x) => x.dingUserId === dingUserId)
    if (u) return { user: u, via: 'ding_scan' }
  }

  if (unionId) {
    const uid = await store.get(`userByUnionId:${unionId}`, null)
    if (uid && uid !== excludeId) {
      const u = await store.get(`user:${uid}`, null)
      if (u) return { user: u, via: 'unionid' }
    }
    const u = await scanUsers((x) => x.dingUnionId === unionId)
    if (u) return { user: u, via: 'unionid_scan' }
  }

  if (mobile) {
    const u = await scanUsers((x) => Boolean(x.mobile) && x.mobile === mobile)
    if (u) return { user: u, via: 'mobile' }
  }

  return { user: null, via: '' }
}
