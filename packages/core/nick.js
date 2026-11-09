// 昵称合规：违规关键词过滤（服务端唯一事实源）
//
// 为什么放在服务端：前端校验只是提示，改个前端就绕过了。
// 昵称会出现在留言板、排队、大屏上，属于公开内容，必须由服务端兜住。
//
// 词表分三组：
//   hard  —— 违法/诈骗/色情招嫖类，出现即拒
//   soft  —— 辱骂/引战类，出现即拒（宿舍场景，宁可严一点）
//   meta  —— 冒充管理/系统的词，出现即拒（防止「管理员」「客服」冒充）
//
// 只做包含匹配（子串），不做正则，避免误伤。词条自己维护，别从外部拉。

const HARD = [
  '代开发票', '办证', '枪', '毒品', '冰毒', '大麻', '赌博', '博彩', '网赌',
  '裸聊', '约炮', '一夜情', '包养', '援交', '小姐', '上门服务',
  '贷款', '刷单', '兼职日结', '高利贷', '套现', '洗钱', '传销', '博彩',
]

const SOFT = [
  '傻逼', '傻b', '煞笔', '沙比', 'cnm', 'nmsl', '你妈', '他妈的', '操你',
  '贱人', '婊子', '滚你', '去死', '死全家', '杂种', '狗东西',
]

const META = ['管理员', '管理員', '客服', '官方', '系统', '老师', '宿管', '楼长']

export const NICK_BANNED = { HARD, SOFT, META }

/**
 * 检查昵称。
 * 返回 { ok: true } 或 { ok: false, reason, word }
 * reason: 'empty' | 'too_long' | 'banned' | 'invalid'
 */
export function checkNick(raw) {
  const nick = String(raw == null ? '' : raw).trim()
  if (!nick) return { ok: false, reason: 'empty' }
  if ([...nick].length > 16) return { ok: false, reason: 'too_long' }

  // 控制字符 / 纯符号都不行（纯符号没法在任何地方区分开）
  if (/[\u0000-\u001f\u007f]/.test(nick)) return { ok: false, reason: 'invalid' }
  if (!/[\p{L}\p{N}]/u.test(nick)) return { ok: false, reason: 'invalid' }

  // 全角转半角 + 去空格，防止「傻 逼」「傻　逼」绕过
  const flat = nick
    .replace(/[\s\u3000]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()

  for (const group of [HARD, SOFT, META]) {
    for (const w of group) {
      if (flat.includes(String(w).toLowerCase())) return { ok: false, reason: 'banned', word: w }
    }
  }
  return { ok: true }
}

/**
 * 把不合规的昵称修成可用的（用于钉钉同步下来的昵称）。
 * 命中违规词就退化成「同学 + 序号」，不阻断登录流程。
 */
export function sanitizeNick(raw, fallback) {
  const r = checkNick(raw)
  if (r.ok) return String(raw).trim()
  const fb = String(fallback || '同学').slice(0, 12)
  return fb
}
