// 昵称违规词（前端提示用；真正拦截在服务端 packages/core/nick.js）
// 两边词表要一致，改的时候记得同步。
const HARD = ['代开发票', '办证', '赌博', '博彩', '裸聊', '约炮', '包养', '援交', '贷款', '刷单', '套现', '洗钱', '传销']
const SOFT = ['傻逼', '傻b', '煞笔', '你妈', '他妈的', '操你', '贱人', '婊子', '去死', '杂种']
const META = ['管理员', '客服', '官方', '系统', '宿管', '楼长']

const ALL = [...HARD, ...SOFT, ...META]

export function findBannedWord(raw) {
  const flat = String(raw || '')
    .replace(/[\s\u3000]/g, '')
    .toLowerCase()
  if (!flat) return ''
  for (const w of ALL) {
    if (flat.includes(w.toLowerCase())) return w
  }
  return ''
}
