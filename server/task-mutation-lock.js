import { withOperationLock } from '../packages/core/operations.js'

// All task/occupancy read-modify-writes must share this partition key. Queue
// mutations already use queue:<partition>; always acquire task-state first.
export function withTaskMutation(store, buildingId, task, { queue = false } = {}) {
  const bid = buildingId || 'b1'
  return withOperationLock(store, 'task-state:' + bid, () => queue ? withOperationLock(store, 'queue:' + bid, task) : task())
}

export function registerTaskMutationLock(app, { store, env = {} }) {
  app.use('/api/tasks', async (c, next) => {
    if (c.req.method !== 'POST') return next()
    return withTaskMutation(store, env.BUILDING_ID, next, { queue: true })
  })
  app.use('/api/tasks/*', async (c, next) => {
    if (c.req.path === '/api/tasks' || !['POST', 'PATCH', 'DELETE'].includes(c.req.method)) return next()
    return withTaskMutation(store, env.BUILDING_ID, next)
  })
}
