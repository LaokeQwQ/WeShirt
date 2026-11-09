// WeShirt · 用户资料默认值（Edge / Node 双形态共用）
// 只依赖 Web 标准 API，禁止引入 node: 模块。
//
// 昵称与头像是「随机生成」的：新用户第一次进来就有一个能用的名字和头像，
// 不需要填任何表单。Settings 里可以再点「换一个」重掷。

// 昵称：形容词 + 名词，读起来像个人，不像编号
const NICK_ADJ = [
  '晚风',
  '青柠',
  '小满',
  '南枝',
  '星河',
  '白茶',
  '木棉',
  '清欢',
  '半夏',
  '听雨',
  '山茶',
  '云朵',
  '橘子',
  '薄荷',
  '海盐',
  '棉花',
  '初雪',
  '远山',
  '小舟',
  '麦田',
]

const NICK_NOUN = ['同学', '同学', '同学', '君', '仔', '酱', '子', '侠']

// 头像：只存 key（av1..av12），图形由前端 Avatar.vue 用 SVG 画出来。
// 不存 emoji、也不存图片 URL —— 前者观感差，后者要外部请求。
export const AVATAR_KEYS = [
  'av1',
  'av2',
  'av3',
  'av4',
  'av5',
  'av6',
  'av7',
  'av8',
  'av9',
  'av10',
  'av11',
  'av12',
]

export const DEFAULT_AVATAR = 'av1'

// 随机整数 [0, n)
function randInt(n) {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  return arr[0] % n
}

function pick(list) {
  return list[randInt(list.length)]
}

// 生成一个随机昵称：如「晚风同学」「青柠仔」
export function randomNick() {
  return pick(NICK_ADJ) + pick(NICK_NOUN)
}

// 再掷一次，尽量和当前不同
export function randomNickExcept(current) {
  for (let i = 0; i < 8; i++) {
    const n = randomNick()
    if (n !== current) return n
  }
  return randomNick() + String(randInt(90) + 10)
}

export function randomAvatar() {
  return pick(AVATAR_KEYS)
}

// 旧版本存的是 emoji（🧺 之类），统一迁移到 avatar key
export function normalizeAvatar(v) {
  if (typeof v !== 'string' || !v) return DEFAULT_AVATAR
  if (AVATAR_KEYS.includes(v)) return v
  // 老数据是 emoji / 任意短字符串：按字符码稳定映射到某个 key，
  // 保证同一个用户每次看到的头像不变
  let h = 0
  for (const ch of v) h = (h * 31 + ch.codePointAt(0)) % 100000
  return AVATAR_KEYS[h % AVATAR_KEYS.length]
}

// 昵称规整：去空白、限长（按码点计，避免把 emoji 截断成半个）
export function normalizeNick(v, fallback) {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return fallback || randomNick()
  const chars = [...s]
  return chars.slice(0, 16).join('')
}

// 自定义头像（用户上传 / 钉钉头像）：
// 存成 `avatarUrl`，可以是 data:image/... 的 base64，也可以是 https 外链。
// 为什么不用 Blob：Makers Blob 只能在 Cloud Functions 里用，而本项目的 /api 是
// Edge Function（云函数形态会踩 CLI 的 stdin_default bug，全站 502）。
// 头像压到 128px、几 KB，放 KV 完全够用。
export const AVATAR_URL_MAX = 60000 // data URL 最大字符数（约 45KB 图片）

export function normalizeAvatarUrl(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (s.startsWith('data:image/')) {
    // 只接受常见位图格式，防止塞 svg（可带脚本）
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) return null
    if (s.length > AVATAR_URL_MAX) return null
    return s
  }
  if (/^https:\/\//i.test(s) && s.length <= 500) return s
  return null
}

// 新建一个用户对象（幂等：只描述默认字段）
export function buildUser(userId, extra = {}) {
  return {
    id: userId,
    nick: randomNick(),
    avatar: randomAvatar(),
    avatarUrl: null, // 自定义头像（data URL 或 https 外链），为空则用 avatar key 的 SVG
    createdAt: new Date().toISOString(),
    takeCode: null,
    dingUserId: null,
    karma: 0,
    ...extra,
  }
}
