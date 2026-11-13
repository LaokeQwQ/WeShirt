import { reactive } from 'vue'

export const ASSISTANT_RESOURCES = ['status', 'history', 'skills', 'memory', 'preferences']
const TTL = { status: 15000, history: 15000, skills: 300000, memory: 60000, preferences: 60000 }
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))

// Memory only: no chat, memory or credentials are written to browser storage.
export function createAssistantResourceCache({ request, now = Date.now }) {
  const state = reactive(Object.fromEntries(ASSISTANT_RESOURCES.map(key => [key, { data: null, loading: false, error: '', updatedAt: 0 }])))
  let owner = '', credential = '', epoch = 0
  const pending = new Map(), revisions = new Map()
  function setSession(id = '', token = '') {
    if (owner === id && credential === token) return
    owner = id; credential = token; epoch++; pending.clear(); revisions.clear()
    for (const key of ASSISTANT_RESOURCES) Object.assign(state[key], { data: null, loading: false, error: '', updatedAt: 0 })
  }
  function publish(key, value) {
    if (!owner || !credential) return
    revisions.set(key, (revisions.get(key) || 0) + 1)
    Object.assign(state[key], { data: clone(value), error: '', updatedAt: now() })
  }
  function read(key, { force = false } = {}) {
    if (!ASSISTANT_RESOURCES.includes(key) || !owner || !credential) return Promise.resolve(null)
    if (pending.has(key)) return pending.get(key)
    const row = state[key]
    if (!force && row.data !== null && now() - row.updatedAt < TTL[key]) return Promise.resolve(clone(row.data))
    const version = epoch, revision = revisions.get(key) || 0
    row.loading = true; row.error = ''
    const job = Promise.resolve().then(() => version === epoch ? request(key) : null).then(value => {
      if (version !== epoch || (revisions.get(key) || 0) !== revision) return null
      Object.assign(row, { data: clone(value), updatedAt: now(), error: '' })
      return clone(value)
    }).catch(error => {
      if (version === epoch && (revisions.get(key) || 0) === revision) row.error = error?.message || '暂时无法读取，请重试'
      return null
    }).finally(() => {
      if (version === epoch && pending.get(key) === job) { row.loading = false; pending.delete(key) }
    })
    pending.set(key, job)
    return job
  }
  return { state, setSession, read, publish, prefetch: () => ASSISTANT_RESOURCES.forEach(key => { read(key) }) }
}
