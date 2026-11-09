import { json, apiErr } from '../packages/core/util.js'
import { readQueueNotices, markQueueNoticeRead } from '../packages/core/queue-reminders.js'

export function registerQueueNoticeRoutes(app, { store, authenticate, now = () => Date.now() }) {
  const userId = async (c) => {
    const user = await authenticate?.(c)
    return typeof user === 'string' ? user : user?.id || null
  }
  app.get('/api/queue/notices', async (c) => {
    const uid = await userId(c)
    if (!uid) return apiErr('unauthorized', '查看预约提醒需要先登录', 401)
    const notices = await readQueueNotices(store, uid)
    return json({ notices, unread: notices.filter((notice) => !notice.readAt && notice.active).length }, 200, { 'cache-control': 'no-store' })
  })
  app.post('/api/queue/notices/:id/read', async (c) => {
    const uid = await userId(c)
    if (!uid) return apiErr('unauthorized', '操作预约提醒需要先登录', 401)
    const id = c.req.param('id')
    if (!/^qn_[A-Za-z0-9_-]{1,80}$/.test(id)) return apiErr('bad_param', '提醒无效')
    const marked = await markQueueNoticeRead(store, uid, id, now())
    return marked ? json({ ok: true }, 200, { 'cache-control': 'no-store' }) : apiErr('not_found', '未找到这条预约提醒', 404)
  })
}
