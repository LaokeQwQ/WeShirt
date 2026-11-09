import { DORM_BUILDINGS, normalizeDormBuilding, dormBuildingName, filterDormFloors } from './buildings.js'
import { withOperationLock } from './operations.js'

export class FavoriteError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
export const FAVORITE_REMINDER_INDEX = 'favorite-reminder-users'
const DAY = 86400000, MINUTE = 60000, OFFSET = 8 * 3600000
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (v, key) => Object.prototype.hasOwnProperty.call(v, key)
const preferencesKey = (uid) => `laundry-preferences:${uid}`
export { preferencesKey as laundryPreferencesKey }
export const defaultLaundryPreferences = () => ({ favorites: [], enabled: false, timeWindows: [] })

function minuteOf(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}
function validateWindows(value) {
  if (!Array.isArray(value) || value.length > 3) throw new FavoriteError('bad_param', '最多设置 3 个提醒时段')
  return value.map((window) => {
    if (!object(window) || Object.keys(window).some((key) => !['start', 'end', 'days'].includes(key)) || minuteOf(window.start) === null || minuteOf(window.end) === null || window.start === window.end || !Array.isArray(window.days) || !window.days.length || window.days.length > 7 || window.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new FavoriteError('bad_param', '时段须为 HH:mm，开始和结束不能相同，并选择有效星期')
    return { start: window.start, end: window.end, days: [...new Set(window.days)].sort((a, b) => a - b) }
  })
}

export function visibleLaundryPreferences(value) {
  let windows = []
  try { windows = validateWindows(value?.timeWindows || []) } catch { /* Invalid legacy records stay disabled. */ }
  return { favorites: Array.isArray(value?.favorites) ? [...new Set(value.favorites.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 100))].slice(0, 20) : [], enabled: value?.enabled === true && windows.length > 0, timeWindows: windows }
}

export function scopedFavoriteMachines(result, user, catalog = DORM_BUILDINGS) {
  const dorm = normalizeDormBuilding(user?.dormBuilding, catalog)
  if (!dorm) return []
  const board = result?.board || result || {}
  const mapping = result?.mapping || board.slotMapping || {}
  return filterDormFloors({ ...board, slotMapping: mapping }, dorm, catalog).flatMap((floor) => (floor.machines || []).map((machine) => {
    const slot = Object.entries(mapping).find(([, id]) => String(id) === String(machine.id))?.[0]
    const dryer = slot ? /(?:^|-)D\d+$/i.test(slot) : machine.kind === 'dryer' || /烘干|dry/i.test(machine.name || '')
    const position = slot?.split('-').at(-1)?.replace(/^D/i, '')
    const source = machine.displayName || machine.machineLabel || (position ? `${position}号${dryer ? '烘干机' : '洗衣机'}` : machine.name) || ''
    const clean = String(source).split(String(machine.id)).join('').replace(/[\u0000-\u001f]/g, '').trim()
    const label = !clean || /^[a-f0-9]{16,}$/i.test(clean) || /^\d{8,}$/.test(clean) ? (dryer ? '烘干机' : '洗衣机') : clean
    return { id: String(machine.id), name: String(label).slice(0, 100), floor: String(floor.name || floor.code || machine.floorCode || '').slice(0, 40), kind: dryer ? 'dryer' : 'washer', state: ['idle', 'occupied', 'abnormal', 'faulty', 'unknown'].includes(machine.state) ? machine.state : 'unknown', finishAt: typeof machine.finishAt === 'string' ? machine.finishAt : null, estimated: machine.estimated === true, unavailable: machine.suspectedUncollected === true || machine.health?.stale === true || machine.health?.suspectedFault === true }
  }))
}

export function validateLaundryPreferences(current, patch, machines) {
  if (!object(patch) || Object.keys(patch).some((key) => !['favorites', 'enabled', 'timeWindows'].includes(key))) throw new FavoriteError('bad_param', '偏好字段无效')
  const next = { ...visibleLaundryPreferences(current), ...patch }
  if (typeof next.enabled !== 'boolean') throw new FavoriteError('bad_param', '提醒开关无效')
  if (!Array.isArray(next.favorites) || next.favorites.length > 20 || next.favorites.some((id) => typeof id !== 'string' || !id || id.length > 100 || /[\u0000-\u001f]/.test(id))) throw new FavoriteError('bad_param', '最多收藏 20 台机器')
  next.favorites = [...new Set(next.favorites)]
  const allowed = new Set(machines.map((machine) => machine.id))
  if (next.favorites.some((id) => !allowed.has(id))) throw new FavoriteError('machine_not_allowed', '收藏机器须属于当前住宿楼，且仍在看板中')
  next.timeWindows = validateWindows(next.timeWindows)
  if (next.enabled && (!next.favorites.length || !next.timeWindows.length)) throw new FavoriteError('bad_param', '开启提醒前，请收藏机器并设置提醒时段')
  return next
}

// A cross-midnight occurrence is keyed by its starting local date and weekday.
export function favoriteReminderWindows(windows, now = Date.now()) {
  const local = new Date(now + OFFSET)
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  const currentMinute = local.getUTCHours() * 60 + local.getUTCMinutes()
  const active = []
  for (const window of windows || []) {
    const start = minuteOf(window.start), end = minuteOf(window.end)
    if (start === null || end === null || start === end || !Array.isArray(window.days)) continue
    const previousDay = start > end && currentMinute < end
    if (!(start < end ? currentMinute >= start && currentMinute < end : currentMinute >= start || currentMinute < end)) continue
    const date = localMidnight - (previousDay ? DAY : 0)
    const weekday = new Date(date).getUTCDay() || 7
    if (!window.days.includes(weekday)) continue
    const startAt = date - OFFSET + start * MINUTE
    const endAt = date - OFFSET + (end + (start > end ? 1440 : 0)) * MINUTE
    const day = new Date(date).toISOString().slice(0, 10)
    active.push({ key: `${day}|${window.start}-${window.end}`, day, startAt, endAt })
  }
  return active.sort((a, b) => a.startAt - b.startAt || a.key.localeCompare(b.key))
}

function registeredInWindow(tasks, startAt, now) {
  return (Array.isArray(tasks) ? tasks : []).some((task) => {
    const start = Date.parse(task?.startAt)
    return Number.isFinite(start) && start >= startAt && start <= now && !task.cancelled && !task.cancelledAt && !task.canceledAt && !['cancelled', 'canceled'].includes(task.status)
  })
}
function reminderLabel(machine) {
  // Some upstream names equal device IDs. Do not use that fallback in notifications.
  const raw = String(machine.name || '').trim().split(machine.id).join('').trim()
  const label = !raw || raw === machine.id || /^[a-f0-9]{16,}$/i.test(raw) || /^\d{8,}$/.test(raw) ? (machine.kind === 'dryer' ? '烘干机' : '洗衣机') : raw.replace(/[\u0000-\u001f]/g, '').slice(0, 60)
  return `${machine.floor ? machine.floor + ' ' : ''}${label}`
}

export async function syncFavoriteReminderIndex(store, userId, enabled) {
  await withOperationLock(store, 'favorite-reminder-index', async () => {
    const old = await store.get(FAVORITE_REMINDER_INDEX, [])
    const ids = new Set((Array.isArray(old) ? old : []).filter((id) => typeof id === 'string'))
    if (enabled) ids.add(userId); else ids.delete(userId)
    await store.put(FAVORITE_REMINDER_INDEX, [...ids])
  })
}

export async function processFavoriteReminders({ store, board, env = {}, now = Date.now(), notify }) {
  const bid = env.BUILDING_ID || board?.buildingId || 'b1'
  return withOperationLock(store, `favorite-reminders:${bid}`, async () => {
    const actualBoard = board?.board || board || {}
    const snapshot = Date.parse(actualBoard.updatedAt)
    if (!Number.isFinite(snapshot) || now - snapshot > 7 * MINUTE || snapshot > now + 30000) return { scanned: 0, sent: 0, skipped: 'stale' }
    const [index, mappingEntry, site] = await Promise.all([store.get(FAVORITE_REMINDER_INDEX, []), store.get(`mapping:${bid}`, {}), store.get('meta:site', {})])
    const catalog = Array.isArray(site?.buildings) && site.buildings.length ? site.buildings : DORM_BUILDINGS
    const mapping = board?.mapping || actualBoard.slotMapping || mappingEntry?.mapping || {}
    let scanned = 0, sent = 0
    for (const userId of [...new Set(Array.isArray(index) ? index : [])]) {
      if (typeof userId !== 'string') continue
      scanned++
      try {
        await withOperationLock(store, `favorite-user:${userId}`, async () => {
          const [user, raw] = await Promise.all([store.get(`user:${userId}`, null), store.get(preferencesKey(userId), null)])
          const preferences = visibleLaundryPreferences(raw)
          if (!user || !preferences.enabled) { await syncFavoriteReminderIndex(store, userId, false); return }
          if (user.notifyOn !== true) return
          const active = favoriteReminderWindows(preferences.timeWindows, now)
          if (!active.length || !normalizeDormBuilding(user.dormBuilding, catalog)) return
          const machines = scopedFavoriteMachines({ board: actualBoard, mapping }, user, catalog)
          const idle = machines.filter((machine) => preferences.favorites.includes(machine.id) && machine.state === 'idle' && !machine.unavailable)
          const stateKey = `favorite-reminders:${userId}`
          const previous = await store.get(stateKey, {})
          const state = { ...previous, windows: { ...(previous?.windows || {}) } }
          for (const [key, record] of Object.entries(state.windows)) if (!record || record.endAt < now - 2 * DAY) delete state.windows[key]
          const tasks = await store.get(`tasks:${userId}`, [])
          if (active.some((window) => registeredInWindow(tasks, window.startAt, now))) {
            for (const window of active) state.windows[window.key] = { ...(state.windows[window.key] || {}), endAt: window.endAt, stopped: true }
            await store.put(stateKey, state)
            return
          }
          if (!idle.length) return
          const eligible = active.filter((window) => { const record = state.windows[window.key] || {}; return !record.stopped && (Number(record.count) || 0) < 3 })
          if (!eligible.length || Number(state.retryAfter || 0) > now || (Number.isFinite(state.lastSuccessAt) && now - state.lastSuccessAt < 30 * MINUTE) || typeof notify !== 'function') return
          // Mark attempt before I/O. Failure may retry after five minutes without spending success quota.
          state.retryAfter = now + 5 * MINUTE
          await store.put(stateKey, state)
          const building = dormBuildingName(user.dormBuilding, catalog) || '你的住宿楼'
          let url = '/#/list'
          try { const origin = new URL(env.PUBLIC_ORIGIN || env.SITE_URL || ''); if (['https:', 'http:'].includes(origin.protocol) && !origin.username && !origin.password) url = origin.origin + '/#/list' } catch { /* relative entry is still usable in-app */ }
          let result
          try { result = await notify(userId, { title: '收藏机器空闲提醒', text: `${building}有你收藏的空闲机器：${idle.slice(0, 5).map(reminderLabel).join('、')}${idle.length > 5 ? `等 ${idle.length} 台` : ''}。\n前往看板查看并登记；状态以页面最新显示为准。`, url }) } catch { return }
          if (!result?.ok) return
          state.lastSuccessAt = now
          state.retryAfter = 0
          for (const window of eligible) { const record = state.windows[window.key] || {}; state.windows[window.key] = { ...record, count: (Number(record.count) || 0) + 1, endAt: window.endAt } }
          await store.put(stateKey, state)
          sent++
        })
      } catch { /* One damaged preference must not interrupt the other subscribed users. */ }
    }
    return { scanned, sent }
  })
}
