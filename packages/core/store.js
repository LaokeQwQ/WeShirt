// In-memory storage used by tests. The Node file store and CloudBase site store implement the same interface.

export function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// ───────────────────────── MemoryStore ─────────────────────────
const memoryStores = new WeakSet()
export const isMemoryStore = store => memoryStores.has(store)
export function createMemoryStore() {
  const map = new Map()
  const store = {
    async get(key, fallback = null) {
      return map.has(key) ? map.get(key) : fallback
    },
    async put(key, value) {
      map.set(key, value)
      return value
    },
    async del(key) {
      return map.delete(key)
    },
    async list(prefix = '') {
      const out = []
      for (const [k, v] of map) if (k.startsWith(prefix)) out.push({ key: k, value: v })
      return out
    },
  }
  memoryStores.add(store)
  return store
}
