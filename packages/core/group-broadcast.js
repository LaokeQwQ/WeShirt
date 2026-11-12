import { currentDormCatalog, normalizeDormBuilding } from './buildings.js'
import { hhmm } from './notice.js'

// A destination always has a building. Never turn a newly observed group into
// a campus-wide subscription, or fall back from a building to another group.
export async function resolveBroadcastTargets(store, env = {}) {
  const catalog = await currentDormCatalog(store, env.SITE_BUILDINGS)
  const [configured, legacy] = await Promise.all([
    store.get('operations:buildingGroups', {}), store.get('ding:groupConv', null),
  ])
  const groups = configured && typeof configured === 'object' ? configured : {}
  const targets = []
  for (const building of catalog.filter(b => b.enabled !== false)) {
    const explicit = Object.hasOwn(groups, building.code)
    const conversationId = explicit && typeof groups[building.code] === 'string' ? groups[building.code].trim() : ''
    if (conversationId) targets.push({ key: building.code, dormBuilding: building.code, name: building.name, conversationId, via: 'group' })
    if (explicit) continue // An explicitly empty setting disables this destination.
    const matches = catalog.filter(b => String(legacy?.title || '').includes(b.name))
    const legacyDorm = normalizeDormBuilding(legacy?.dormBuilding, catalog) || (matches.length === 1 ? matches[0].code : null)
    // The original custom webhook served the original physical Guiyuan room.
    // Other buildings require an explicit group binding in administration.
    if (building.code === 'guiyuan' && env.DINGTALK_WEBHOOK) {
      targets.push({ key: building.code, dormBuilding: building.code, name: building.name, via: 'webhook' })
    } else if (legacy?.conversationId && legacyDorm === building.code) {
      targets.push({ key: building.code, dormBuilding: building.code, name: building.name, conversationId: legacy.conversationId, via: 'group' })
    }
  }
  return targets
}

const escape = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 100).replace(/([\\`*_{}\[\]()#+.!<>|~-])/g, '\\$1')

export function buildHourlyGroupNotice(board, { name = '洗衣房', hourKey = '', now = Date.now() } = {}) {
  const title = `🧺 ${name} · 整点洗衣房播报`
  const clock = /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hourKey) ? `${hourKey.slice(-2)}:00` : hhmm(new Date(now).toISOString())
  const list = (board?.floors || []).flatMap(f => (f.machines || []).map(m => ({ ...m, floor: f.name || f.code || '' })))
  const idle = list.filter(m => m.state === 'idle')
  const occupied = list.filter(m => ['occupied', 'abnormal'].includes(m.state))
  const fault = list.filter(m => m.state === 'faulty')
  const lines = [`### ${escape(title)}`, '', `**🕒 ${clock} · 空闲 ${idle.length} 台 · 使用中 ${occupied.length} 台**`]
  const section = (heading, machines, running = false) => {
    lines.push('', `**${heading}**`, '')
    if (!machines.length) lines.push('- 暂无')
    for (const machine of machines.slice(0, 60)) {
      const label = `${escape(machine.displayName || machine.name || machine.id)}${machine.floor && !String(machine.name).includes(machine.floor) ? ` · ${escape(machine.floor)}` : ''}`
      const finishAt = Date.parse(machine.finishAt || '')
      const remaining = Number.isFinite(finishAt) ? finishAt > now ? ` · 约 ${Math.ceil((finishAt - now) / 60000)} 分钟` : ' · 即将完成，等待设备确认' : ' · 结束时间待更新'
      lines.push(`- ${label}${running ? remaining : machine.suspectedUncollected ? ' · 疑似未取衣' : ''}`)
    }
    if (machines.length > 60) lines.push(`- 其余 ${machines.length - 60} 台请在页面查看`)
  }
  section('✅ 空闲机器', idle)
  section('⏳ 使用中', occupied, true)
  if (fault.length) section('⚠️ 已确认故障', fault)
  lines.push('', '> 数据来自海乐生活；使用前请确认机器和衣物情况。')
  return { title, markdown: lines.join('\n'), text: lines.join('\n').replace(/^###?\s|\*\*/gm, '') }
}
