import { withOperationLock } from './operations.js'
import { getUserPermissions } from './permissions.js'
import { DORM_BUILDINGS } from './buildings.js'
const INDEX = 'community:notice-users'
const key = (uid) => 'community-notices:' + uid
const iso = (now) => new Date(now).toISOString()
const capacityError = () => Object.assign(new Error('提醒队列暂满，请稍后发送'), { code: 'notice_capacity', status: 429 })
const pending = (entry) => !entry.dm?.sentAt && !entry.dm?.suppressed && (entry.dm?.attempts || 0) < 4
async function limitedEach(items, visit) { let next = 0; await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; await visit(items[index]) } })) }
export async function ensureCommunityNoticeCapacity(store, targets) {
  if (!targets.length) return
  return withOperationLock(store, INDEX, async () => {
    const ids = new Set(await store.get(INDEX, [])); for (const uid of targets) ids.add(uid)
    if (ids.size > 1000) throw capacityError()
    await limitedEach(targets, async (uid) => { if (((await store.get(key(uid), [])) || []).filter(pending).length >= 30) throw capacityError() })
    // 预留索引容量，后续并发入队不能挤掉已接受的接收人；空预留下轮清除。
    await store.put(INDEX, [...ids])
  })
}

export async function enqueueCommunityNotice(store, uid, notice, now = Date.now()) {
  return enqueueCommunityNotices(store, [uid], notice, now)
}
export async function enqueueCommunityNotices(store, targets, notice, now = Date.now()) {
  if (!targets.length) return
  await withOperationLock(store, INDEX, async () => {
    const ids = new Set(await store.get(INDEX, [])); for (const uid of targets) ids.add(uid)
    if (ids.size > 1000) throw capacityError()
    await limitedEach(targets, async (uid) => withOperationLock(store, key(uid), async () => {
      const list = (await store.get(key(uid), [])) || []
      if (list.some((entry) => entry.messageId === notice.messageId)) return
      if (list.filter(pending).length >= 30) throw capacityError()
      // 只淘汰已投递/已终止的记录，未完成 outbox 永不被较新的提醒挤掉。
      const next = [...list]; while (next.length >= 30) { const index = next.findIndex((entry) => !pending(entry)); if (index < 0) throw capacityError(); next.splice(index, 1) }
      next.push({ ...notice, id: 'cm_' + crypto.randomUUID(), at: iso(now), readAt: null, dm: { attempts: 0, nextAt: 0 } })
      await store.put(key(uid), next)
    }))
    await store.put(INDEX, [...ids])
  })
}

export async function readCommunityNotices(store, uid) {
  return ((await store.get(key(uid), [])) || []).slice(-30).reverse()
}
export async function markCommunityNoticesRead(store, uid, accepts, now = Date.now()) {
  return withOperationLock(store, key(uid), async () => {
    const list = (await store.get(key(uid), [])) || []; let count = 0
    for (const entry of list) if (accepts(entry)) { entry.readAt ||= iso(now); count++ }
    await store.put(key(uid), list.slice(-30)); return count
  })
}

// 与排队 outbox 一致：先持久化、每阶段去重、限次退避，回调只负责现有通知通道。
export async function processCommunityNotices({ store, env = {}, notify, now = Date.now(), budgetMs = 8000 }) {
  if (typeof notify !== 'function') return { sent: 0, failed: 0 }
  return withOperationLock(store, 'community:notice-run', async () => {
    const deadline = Date.now() + Math.max(100, Math.min(15000, Number(budgetMs) || 8000))
    const ids = [...new Set(await store.get(INDEX, []))].slice(0, 32), visited = []
    let sent = 0, failed = 0, attempts = 0, checked = 0
    for (const uid of ids) {
      if (attempts >= 12 || checked >= 64 || Date.now() >= deadline) break
      visited.push(uid)
      const list = await readCommunityNotices(store, uid)
      if (!list.some(pending)) continue
      const initialUser = await store.get('user:' + uid, null)
      if (!initialUser || initialUser.disabled || initialUser.blocked || initialUser.notifyOn === false) {
        checked++
        await withOperationLock(store, key(uid), async () => { const current = await store.get(key(uid), []); let changed = false; for (const target of current) if (pending(target)) { target.dm = { ...target.dm, suppressed: true }; changed = true }; if (changed) await store.put(key(uid), current) })
        continue
      }
      for (const entry of list) {
        if (attempts >= 12 || checked >= 64 || Date.now() >= deadline) break
        if (entry.dm?.sentAt || entry.dm?.suppressed || entry.dm?.attempts >= 4 || entry.dm?.nextAt > now) continue
        checked++
        // 每次开始一条投递前重验，上一条回调期间撤权/切楼/停用也立即生效。
        const [user, site, messages] = await Promise.all([store.get('user:' + uid, null), store.get('meta:site', {}), store.get('messages:' + (env.BUILDING_ID || 'b1'), [])])
        const buildings = Array.isArray(site?.buildings) ? site.buildings : DORM_BUILDINGS
        const access = user ? await getUserPermissions(store, user, buildings) : null
        const canView = entry.channel === 'public' || buildings.some((building) => building.code === entry.channel && building.enabled !== false)
        const allowed = canView && access?.permissions.messages.view
          && (access.permissions.messages.viewBuildings === null || access.permissions.messages.viewBuildings.includes(entry.channel))
          && (['super', 'admin'].includes(access.identity.role) || entry.channel === 'public' || entry.channel === user?.dormBuilding)
        if (!user || user.disabled || user.blocked || user.notifyOn === false || !allowed
          || !Array.isArray(messages) || !messages.some((message) => message.id === entry.messageId && !message.deleted && message.channel === entry.channel)
          || now - Date.parse(entry.at) > 86400000) {
          await withOperationLock(store, key(uid), async () => { const current = await store.get(key(uid), []); const target = current.find((item) => item.id === entry.id); if (target) { target.dm = { ...target.dm, suppressed: true }; await store.put(key(uid), current) } })
          continue
        }
        attempts++
        let timer, result
        try { result = await Promise.race([Promise.resolve(notify(uid, { type: 'mention', title: entry.title, text: entry.text, url: entry.url, tag: 'mention-' + entry.id, noticeId: entry.id, channel: entry.channel })), new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false }), Math.max(1, deadline - Date.now())) })]) } catch { result = { ok: false } } finally { clearTimeout(timer) }
        await withOperationLock(store, key(uid), async () => {
          const current = await store.get(key(uid), []), target = current.find((item) => item.id === entry.id)
          if (!target) return
          const n = (target.dm?.attempts || 0) + 1
          target.dm = { attempts: n, nextAt: now + Math.min(30 * 60000, 60000 * 2 ** (n - 1)), ...(result?.ok ? { sentAt: iso(now) } : {}) }
          await store.put(key(uid), current)
        })
        if (result?.ok) sent++; else failed++
      }
    }
    await withOperationLock(store, INDEX, async () => {
      const current = new Set(await store.get(INDEX, []))
      const pending = []
      for (const uid of visited) { const list = await readCommunityNotices(store, uid); current.delete(uid); if (list.some((item) => !item.dm?.sentAt && !item.dm?.suppressed && (item.dm?.attempts || 0) < 4)) pending.push(uid) }
      await store.put(INDEX, [...current, ...pending])
    })
    return { sent, failed }
  })
}
