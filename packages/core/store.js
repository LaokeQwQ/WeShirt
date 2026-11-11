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
// 适配 EdgeOne KV binding；底层仍是跨节点最终一致，不能把本地缓存当授权来源。
const EDGE_CACHE_TTL_MS = 5000
const EDGE_CACHE_ENTRIES = 128
const EDGE_CACHE_BYTES = 2 * 1024 * 1024
const EDGE_CACHE_ENTRY_BYTES = 256 * 1024
const freshKey = (key) => key === 'subs' || /^(?:meta:|user:|userBy|access:|mobile:|auth:|session:|token:|takeCode:|oauthstate:|oauthcallbacks:|claim:|usedclaim:|bind:|bindcode:|moderation:|social:|community:|assistant:|request:|mapping:|machines:|messages:)/.test(key)
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function storedValue(key, raw) {
  const value = typeof raw === 'string' ? safeParse(raw) : raw
  // 损坏的权限记录不能退化成“没有个人限制”。身份索引仍兼容旧的普通字符串。
  if (key === 'meta:siteAdmins' && !Array.isArray(value) ||
      key.startsWith('access:user:') && (!record(value) || !record(value.permissions)) ||
      key.startsWith('user:') && !record(value)) throw new Error('Invalid stored authorization record')
  return value
}

export function createEdgeKVStore(kv) {
  const cache = new Map()
  let cacheBytes = 0
  let revision = 0

  function forget(key) {
    const previous = cache.get(key)
    if (previous) cacheBytes -= previous.bytes
    cache.delete(key)
  }
  function prune(now) {
    for (const [key, entry] of cache) if (now < entry.at || now - entry.at >= EDGE_CACHE_TTL_MS) forget(key)
  }
  function remember(key, raw) {
    forget(key)
    if (freshKey(key)) return
    const at = Date.now()
    prune(at)
    // Store text, not callers' mutable objects; each read produces an independent value.
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (typeof text !== 'string') return
    const bytes = (key.length + text.length) * 2
    if (bytes > EDGE_CACHE_ENTRY_BYTES) return
    while (cache.size >= EDGE_CACHE_ENTRIES || cacheBytes + bytes > EDGE_CACHE_BYTES) forget(cache.keys().next().value)
    cache.set(key, { text, bytes, at })
    cacheBytes += bytes
  }
  async function read(key, useCache = true) {
    prune(Date.now())
    const cached = useCache && !freshKey(key) && cache.get(key)
    if (cached) {
      cache.delete(key); cache.set(key, cached)
      return { found: true, value: storedValue(key, cached.text) }
    }
    const before = revision
    // Only absence uses the fallback. Provider failures must propagate, never authorize.
    const raw = await kv.get(key)
    if (raw === null || raw === undefined) { forget(key); return { found: false } }
    const value = storedValue(key, raw)
    if (before === revision) remember(key, raw)
    return { found: true, value }
  }

  return {
    async get(key, fallback = null) {
      const result = await read(key)
      return result.found ? result.value : fallback
    },
    async put(key, value) {
      // The native binding accepts text/bytes, not numbers or booleans.
      const text = JSON.stringify(value)
      if (typeof text !== 'string') throw new Error('KV value must be JSON')
      storedValue(key, text)
      revision++; forget(key)
      try {
        await kv.put(key, text)
      } finally { revision++; forget(key) }
      // An earlier commit may acknowledge after a later write. Re-read instead
      // of letting its late completion restore the earlier value in the cache.
      return value
    },
    async del(key) {
      revision++; forget(key)
      try {
        const remove = typeof kv.delete === 'function' ? kv.delete : kv.remove
        if (typeof remove !== 'function') throw new Error('KV deletion unavailable')
        await remove.call(kv, key)
      } finally { revision++; forget(key) }
      return true
    },
    async list(prefix = '') {
      if (typeof kv.list !== 'function') throw new Error('KV listing unavailable')
      const keys = new Set(), cursors = new Set()
      let cursor
      do {
        const page = await kv.list({ prefix, limit: 256, ...(cursor === undefined ? {} : { cursor }) })
        if (!record(page) || page instanceof Error || page.error || page.errors || page.Error) throw new Error('Invalid KV listing')
        // Empty terminal pages may omit keys. Only an explicit completion flag
        // or terminal cursor proves absence; an ambiguous/error response cannot.
        const terminalCursor = Object.hasOwn(page, 'cursor') && (page.cursor === null || page.cursor === '')
        const complete = page.complete === true || page.complete !== false &&
          (terminalCursor || page.cursor === undefined && Array.isArray(page.keys))
        const emptyTerminal = page.keys === undefined && complete && (page.complete === true || terminalCursor)
        if (!Array.isArray(page.keys) && !emptyTerminal) throw new Error('Invalid KV listing')
        for (const entry of page.keys || []) {
          const key = typeof entry === 'string' ? entry : entry?.key ?? entry?.name
          if (typeof key !== 'string') throw new Error('Invalid KV listing key')
          if (key.startsWith(prefix)) keys.add(key)
        }
        if (complete) break
        cursor = page.cursor
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('Invalid KV listing cursor')
        cursors.add(cursor)
      } while (true)
      const out = []
      for (const key of keys) {
        // A listing can race deletion; never revive an entry from the value cache.
        const result = await read(key, false)
        if (result.found) out.push({ key, value: result.value })
      }
      return out
    },
  }
}
