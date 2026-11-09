// WeShirt · 通知文案
//
// 为什么要单独一个模块：同一条提醒要在「钉钉卡片」「纯文本兜底」「网页提示」里
// 保持一致的说法，散落在各处改一处忘一处，用户就会收到风格不一的推送。
//
// 每个 builder 返回 { title, markdown, text }：
//   - markdown 给钉钉 sampleMarkdown（留白多、可读性好）
//   - text 是纯文本兜底：机器人不支持 markdown 时自动降级，保证一定送得到
//
// 文案原则：说清设备、时间和下一步；估时与现场状态分开，不把推测写成事实。

/** 北京时间 HH:mm（钉钉用户都在国内，不跟着运行时区漂） */
export function hhmm(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * 机号：从「桂园1楼7号机」「桂园1楼7号烘干机」里取 7，取不到返回 null
 */
export function machineNoOf(name) {
  const m = String(name || '').match(/(\d+)\s*号(?:烘干)?机/)
  return m ? Number(m[1]) : null
}

/** 烘干机：名字里带「烘干」 */
export function isDryerName(name) {
  return String(name || '').includes('烘干')
}

/**
 * 群里的一条「洗衣房动态」（钉钉 markdown）。
 *
 * 编号规则：优先用**后台机位编号**（mapping 的 key：1~7 / D1 / D2），
 * 而不是机器名里的号 —— 机器名随上游变，机位号是现场贴的、稳定的。
 *
 * @param {{started?:Array, idle?:Array, fault?:Array, at?:number, maxPerSection?:number, slotById?:Record<string,string>}} p
 * @returns {{title:string, text:string}|null}
 */
export function buildBoardDigest({
  started = [],
  idle = [],
  fault = [],
  at = Date.now(),
  maxPerSection = 8,
  slotById = {},
} = {}) {
  const uniq = (list) => {
    const seen = new Set()
    const out = []
    for (const e of list) {
      const m = e && e.machine
      if (!m || !m.id || seen.has(String(m.id))) continue
      seen.add(String(m.id))
      out.push(m)
    }
    return out
  }

  const s = uniq(started)
  const i = uniq(idle)
  const f = uniq(fault)
  if (!s.length && !i.length && !f.length) return null

  const clock = hhmm(new Date(at).toISOString())
  // 机位号 → 说人话：1~7 → 「3号洗衣机」，D1/D2 → 「1号烘干机」
  const slotLabel = (slot) => {
    const s = String(slot || '')
    if (!s) return ''
    return /^d/i.test(s) ? `${s.slice(1)}号烘干机` : `${s}号洗衣机`
  }
  const labelOf = (m) => {
    const slot = slotById[String(m.id)]
    return slot ? slotLabel(slot) : m.name
  }
  const claimWord = (m) => {
    const slot = slotById[String(m.id)]
    return slot || machineNoOf(m.name)
  }

  const lines = [`#### 洗衣房动态 · ${clock}`]

  // 一台一行，明细换行缩进 —— 一行塞三件事在手机上会挤成一坨
  const section = (title, machines, render) => {
    lines.push('', `**${title}**`)
    const shown = machines.slice(0, maxPerSection)
    for (const m of shown) {
      const [head, ...rest] = render(m)
      lines.push(`- ${head}`)
      for (const r of rest) if (r) lines.push(`  ${r}`)
    }
    if (machines.length > shown.length) lines.push(`- 另外还有 ${machines.length - shown.length} 台`)
  }

  if (s.length) {
    section('刚开洗', s, (m) => {
      const tail = []
      if (m.estimated && m.leftMin != null) tail.push(`约 ${m.leftMin} 分钟`)
      else if (m.finishAt) tail.push(`${hhmm(m.finishAt)} 结束`)
      const cw = claimWord(m)
      if (cw) tail.push(`回复「认领 ${cw}」`)
      return [labelOf(m), tail.join(' · ')]
    })
  }
  if (i.length) {
    section('空闲', i, (m) => [labelOf(m), '洗好了'])
  }
  if (f.length) {
    // 故障和未知放一起：对用户来说「不知道什么情况」和「坏了」可以一起处理
    section('故障 & 未知', f, (m) => [labelOf(m), m.state === 'unknown' ? '状态未知' : '故障'])
  }

  return { title: `洗衣房动态 · ${clock}`, text: lines.join('\n') }
}

function floorLabel(floorCode) {
  const s = singleLine(floorCode)
  if (!s) return ''
  return /^\d+$/.test(s) ? `${s} 楼` : s
}

/** 机器名 + 楼层，拼成一行副标题 */
function subtitle(machineName, floorCode) {
  const f = floorLabel(floorCode)
  return f ? `${machineName} · ${f}` : String(machineName || '')
}

function singleLine(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100)
}

function machineKind({ kind, slot, machineLabel, machineName } = {}) {
  if (kind === 'dryer' || kind === 'washer') return kind
  return /^d\d+$/i.test(String(slot || '')) || isDryerName(machineLabel) || isDryerName(machineName) ? 'dryer' : 'washer'
}

/** 后台标签/机位优先；旧调用仍可只传 machineName。 */
export function buildMachineLabel({ machineLabel, slot, kind, machineName } = {}) {
  if (singleLine(machineLabel)) return singleLine(machineLabel)
  const code = singleLine(slot)
  if (/^d\d+$/i.test(code)) return `${Number(code.slice(1))}号烘干机`
  if (/^\d+$/.test(code)) return `${Number(code)}号${kind === 'dryer' ? '烘干机' : '洗衣机'}`
  return singleLine(machineName) || (kind === 'dryer' ? '烘干机' : '洗衣机')
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
}

function noticeCard(title, sub, lines) {
  const body = lines.filter(Boolean)
  return {
    title,
    markdown: tidy([`### ${title}`, `**${escapeMarkdown(sub)}**`, ...body]),
    text: [`【等衣】${title.replace(/^[^\p{L}\p{N}]+/u, '')}`, sub, ...body.map((line) => line.replace(/\*\*/g, ''))].join('\n'),
  }
}

// ── 提前提醒：到了这个点，人差不多该往洗衣房走了 ──
// 都是日常说法，不用「温馨提醒」「请及时」这类公文体。
const BEFORE_LINES = [
  (m) => `预计还有 ${m} 分钟，可以准备取衣了。`,
  (m) => `预计剩余 ${m} 分钟，方便时准备去取衣。`,
  (m) => `距预计结束还有 ${m} 分钟，记得留意取衣时间。`,
  (m) => `还有约 ${m} 分钟，取衣前请确认现场状态。`,
  (m) => `预计 ${m} 分钟后结束，提前安排一下取衣。`,
]

// ── 洗完了 ──
const DONE_LINES = [
  () => '方便时去取一下衣服。',
  () => '记得取衣，给下一位留出机器。',
  () => '有空去取衣吧。',
  () => '取衣前再确认一下机器状态。',
  () => '别忘了取走衣服和随身物品。',
]

const STUCK_LINES = [
  (m) => `上游持续显示剩余 ${m} 分钟。`,
  (m) => `上游剩余时间停在 ${m} 分钟。`,
]

const URGE_LINES = [
  () => '有人点了取衣提醒，方便的话请到现场确认并取衣。',
  () => '收到一条取衣提醒，请确认衣物是否已取走。',
  () => '有人在等待使用这台机器，方便时确认一下衣物。',
]

/** 按 variant 取一条；不传就随机。测试里传固定值保证可断言。 */
function pick(list, variant) {
  if (typeof variant === 'number' && Number.isFinite(variant)) {
    return list[Math.abs(Math.floor(variant)) % list.length]
  }
  return list[Math.floor(Math.random() * list.length)]
}

/** markdown 里多余的连续空行压掉，但保留段落之间的空行 */
function tidy(lines) {
  return lines
    .filter((x) => x !== '' && x != null)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * 取衣提醒（提前 / 到点）。
 * confirmed=false 用于定时到期，true 用于上游确认空闲；默认兼容旧调用。
 * @param {{machineName?:string, machineLabel?:string, slot?:string, kind?:string,
 *          floorCode?:string, leftMin?:number|null, endAt?:string, estimated?:boolean,
 *          confirmed?:boolean, leadMin?:number, variant?:number}} p
 */
export function buildTakeNotice({ machineName, machineLabel, slot, kind, floorCode, leftMin, endAt, estimated = false, confirmed = true, variant } = {}) {
  const resolvedKind = machineKind({ kind, slot, machineLabel, machineName })
  const dryer = resolvedKind === 'dryer'
  const name = buildMachineLabel({ machineName, machineLabel, slot, kind: resolvedKind })
  const sub = subtitle(name, floorCode)
  const at = hhmm(endAt)
  const action = '取完在「我的洗衣」里点「我已取衣」。'

  const left = Number(leftMin)
  if (leftMin != null && Number.isFinite(left) && left > 0) {
    return noticeCard(dryer ? '⏳ 快烘好了' : '⏳ 快洗好了', sub, [
      pick(BEFORE_LINES, variant)(Math.max(1, Math.ceil(left))),
      at ? `预计 ${at} 结束${estimated ? '（估时）' : ''}` : '',
      action,
    ])
  }

  const title = confirmed ? (dryer ? '✅ 烘好了' : '✅ 洗好了') : (dryer ? '⏰ 烘干计时结束' : '⏰ 洗衣计时结束')
  return noticeCard(title, sub, [
    confirmed ? pick(DONE_LINES, variant)(at) : '登记的计时已到，请先确认现场是否完成。',
    at ? `${confirmed ? '结束时间' : '预计结束'} ${at}${estimated ? '（估时）' : ''}` : '',
    action,
  ])
}

/** 只报告观测事实，不把上游延迟断言成设备跳闸。 */
export function buildStuckNotice({ machineName, machineLabel, slot, kind, floorCode, leftMin, stuckMin, variant } = {}) {
  const resolvedKind = machineKind({ kind, slot, machineLabel, machineName })
  const sub = subtitle(buildMachineLabel({ machineName, machineLabel, slot, kind: resolvedKind }), floorCode)
  const minutes = Number(stuckMin)
  const left = Number(leftMin)
  return noticeCard('⚠️ 剩余时间未更新', sub, [
    leftMin != null && Number.isFinite(left) && left >= 0 ? pick(STUCK_LINES, variant)(Math.ceil(left)) : '',
    Number.isFinite(minutes) && minutes > 0 ? `已 ${Math.ceil(minutes)} 分钟未变化。` : '连续多次查询未见变化。',
    '可能是数据延迟，也可能是设备暂停，请到现场确认；如有异常请联系宿管。',
  ])
}

/** 催促取衣（别人点了「提醒取衣」） */
export function buildUrgeNotice({ machineName, machineLabel, slot, kind, floorCode, count, variant } = {}) {
  const resolvedKind = machineKind({ kind, slot, machineLabel, machineName })
  const sub = subtitle(buildMachineLabel({ machineName, machineLabel, slot, kind: resolvedKind }), floorCode)
  const value = Number(count)
  const n = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
  const line = pick(URGE_LINES, variant)()
  return noticeCard('🔔 有人在等你取衣', sub, [line, n > 1 ? `第 **${n}** 次取衣提醒。` : '', '已取走的话，在「我的洗衣」里点「我已取衣」，避免再次提醒。'])
}

/** 首次登录欢迎（纯文本就够，不需要卡片） */
export function buildWelcomeText({ nick } = {}) {
  return [
    '✅ 已用钉钉登录「等衣」',
    nick ? `${singleLine(nick)}，你好。` : '',
    '选择住宿楼后，在「我的洗衣」登记洗衣或烘干，开启提醒后可在这里接收消息。',
    '取完记得点「我已取衣」。提醒和住宿楼都能在设置里修改。',
    '可用指令：查 / 帮助',
  ]
    .filter(Boolean)
    .join('\n')
}

// 导出模板池，方便测试覆盖每一条文案
export const NOTICE_TEMPLATES = { BEFORE_LINES, DONE_LINES, STUCK_LINES, URGE_LINES }
