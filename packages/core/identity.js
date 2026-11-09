const ROLES = Object.freeze({ user: '', super: '总管', admin: '管理员', operator: '运维', volunteer: '志愿管理' })
const validCode = (code) => typeof code === 'string' && code !== 'public' && /^[a-z][a-z0-9_-]{0,31}$/.test(code)

export async function getUserIdentity(store, userId) {
  const ordinary = { role: 'user', label: '', buildings: [] }
  if (typeof userId !== 'string' || !userId) return ordinary
  const [user, rows] = await Promise.all([store.get('user:' + userId, null), store.get('meta:siteAdmins', [])])
  if (!user || user.disabled || user.blocked || !Array.isArray(rows)) return ordinary
  const entry = rows.find((row) => row?.userId === userId)
  if (!entry || !Object.prototype.hasOwnProperty.call(ROLES, entry.role) || entry.role === 'user') return ordinary
  const buildings = entry.role === 'volunteer' && Array.isArray(entry.buildings) ? [...new Set(entry.buildings.filter(validCode))].slice(0, 30) : []
  return { role: entry.role, label: ROLES[entry.role], buildings }
}

export function canModerate(identity) {
  return identity?.role === 'super' || identity?.role === 'admin'
}

export function canInspect(identity, buildingCode) {
  if (!validCode(buildingCode)) return false
  return canModerate(identity) || identity?.role === 'volunteer' && Array.isArray(identity.buildings) && identity.buildings.includes(buildingCode)
}
