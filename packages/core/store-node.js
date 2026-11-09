// WeShirt · FileStore（Node 形态专用，需要 node:fs）
// 单独拆出来的原因：packages/core/store.js 会被 EdgeOne 的 edge 函数打包器一起打包，
// 只要那份文件里出现 node:fs 导入，打包就失败（"Could not resolve node:fs"），
// 结果 functions/ 部署不出来、线上 /api 全线 404。所以 Node 专属能力必须隔离在本文件。
//
// 接口与 store.js 一致（全部 async）：get/put/del/list + flushNow()

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { safeParse } from './store.js'

// dir/kv.json 落盘，内存 Map + 200ms 防抖写盘，启动时读盘。
export function createFileStore(dir = './data') {
  // 保持 async 工厂签名（调用方 await createFileStore(...) 不变）
  return (async () => {
    const file = `${dir}/kv.json`
    const map = new Map()

    // 启动读盘
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        const obj = safeParse(raw || '{}')
        if (obj && typeof obj === 'object') {
          for (const k of Object.keys(obj)) map.set(k, obj[k])
        }
      }
    } catch (e) {
      console.warn('[weshirt] FileStore 读盘失败:', e && e.message)
    }

    let timer = null
    let dirty = false

    function flush() {
      timer = null
      if (!dirty) return
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const obj = {}
        for (const [k, v] of map) obj[k] = v
        writeFileSync(file, JSON.stringify(obj))
        dirty = false
      } catch (e) {
        console.warn('[weshirt] FileStore 落盘失败:', e && e.message)
      }
    }

    function scheduleFlush() {
      dirty = true
      if (timer) return
      timer = setTimeout(flush, 200) // 200ms debounce
    }

    return {
      async get(key, fallback = null) {
        return map.has(key) ? map.get(key) : fallback
      },
      async put(key, value) {
        map.set(key, value)
        scheduleFlush()
        return value
      },
      async del(key) {
        const had = map.delete(key)
        if (had) scheduleFlush()
        return had
      },
      async list(prefix = '') {
        const out = []
        for (const [k, v] of map) if (k.startsWith(prefix)) out.push({ key: k, value: v })
        return out
      },
      // 立即落盘（优雅退出前调用）
      flushNow() {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        flush()
      },
    }
  })()
}
