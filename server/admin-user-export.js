/** Spreadsheet cells must remain text, even when a nickname starts with a formula. */
export function csvCell(value) {
  let text = String(value ?? '').replace(/\u0000/g, '')
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}

export function adminUsersCsv(users) {
  const rows = [['账号 ID', '昵称', '住宿楼', '手机号（脱敏）', '钉钉昵称', '已绑定钉钉', '接收提醒', '创建时间']]
  for (const user of users) rows.push([user.id, user.nick, user.dormBuildingName, user.mobile,
    user.dingNick, user.dingBound ? '是' : '否', user.notifyOn ? '是' : '否', user.createdAt])
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}
