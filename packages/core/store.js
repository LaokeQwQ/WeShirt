// WeShirt · 统一 KV 存储抽象（Edge 安全：本文件不得引入任何 node: 专属 API）
// 三种实现共享同一接口（全部 async）：
//   await store.get(key, fallback = null)   // 值为任意 JSON
//   await store.put(key, value)             // 覆盖写
//   await store.del(key)
//   await store.list(prefix)                // → [{ key, value }]
//
// 实现分布：
//   MemoryStore —— 本文件（测试/降级）
//   EdgeKVStore —— 本文件（EdgeOne KV binding，edge 形态用它）
//   FileStore   —— ./store-node.js（要 node:fs，必须单独拆出：
//                  只要本文件里出现 node:fs 导入，EdgeOne 的函数打包器就会解析失败，
//                  结果整个 functions/ 部署不出来、线上 /api 全 404）

function isObj(v) {
  return v !== null && typeof v === 'object'
}

export function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// ───────────────────────── MemoryStore ─────────────────────────
export function createMemoryStore() {
  const map = new Map()
  return {
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
}

// FileStore 已移到 ./store-node.js（需要 node:fs，不能混进这个 Edge 安全文件）

// ───────────────────────── EdgeKVStore ─────────────────────────
// 适配 EdgeOne KV binding：kv.get(key) / kv.put(key, value) / kv.delete(key)
// kv.list({prefix}) 可选；缺失时退化为内存缓存快照（满足 list 语义）。
export function createEdgeKVStore(kv) {
  const cache = new Map()

  async function memGet(key, fallback = null) {
    if (cache.has(key)) return cache.get(key)
    try {
      const v = await kv.get(key)
      if (v === null || v === undefined) return fallback
      const parsed = typeof v === 'string' ? safeParse(v) : v
      cache.set(key, parsed)
      return parsed
    } catch {
      return fallback
    }
  }

  return {
    get: memGet,
    async put(key, value) {
      cache.set(key, value)
      const toStore = isObj(value) ? JSON.stringify(value) : value
      try {
        await kv.put(key, toStore)
      } catch {
        /* 静默：运行时绑定可能暂不可用 */
      }
      return value
    },
    async del(key) {
      cache.delete(key)
      try {
        await kv.delete(key)
      } catch {
        /* ignore */
      }
      return true
    },
    async list(prefix = '') {
      let keys = []
      if (kv.list) {
        try {
          const res = await kv.list({ prefix })
          keys = (res.keys || []).map((k) => (typeof k === 'string' ? k : k.key))
        } catch {
          keys = [...cache.keys()]
        }
      } else {
        keys = [...cache.keys()]
      }
      const out = []
      for (const k of keys) {
        if (!k.startsWith(prefix)) continue
        const v = await memGet(k)
        out.push({ key: k, value: v })
      }
      return out
    },
  }
}
