// WeShirt · EdgeOne Edge Functions 默认路由（双形态之一）
// 放在 api/ 下：catch-all 只吃 /api/*，不能放在 functions/ 根目录——
// 根目录的 [[default]].js 路由规则是 ^/(.*)$，会把 / 和 /assets/* 全部吃掉，
// 静态站点（dist/index.html）永远轮不到，线上首页直接 545/404。
//
// 存储绑定说明（踩过的坑）：
//   EdgeOne 的 KV 命名空间是「绑定到项目的全局变量」，**不在 context.env 上**。
//   绑定时的变量名由控制台决定（我们文档里写的是 LAUNDRY_KV），但实际叫什么
//   取决于创建绑定的人。所以这里不写死单个名字，而是按优先级逐个探测，
//   最后退化到扫 globalThis（找同时具备 get/put/delete/list 的对象）。
//   探测不到时退回内存实现：功能语义不变，但数据不跨请求持久化。

import { createApp } from '../../server/app.js'
import { createEdgeKVStore, createMemoryStore } from '../../packages/core/store.js'

let _app = null
let _store = null
let _storeInfo = { kind: 'memory', name: null }

// 判断某个候选值像不像一个 KV 命名空间
function looksLikeKv(v) {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.get === 'function' &&
    typeof v.put === 'function' &&
    (typeof v.delete === 'function' || typeof v.remove === 'function')
  )
}

// 显式候选名（我们自己约定的 + 平台文档常见写法）
const KV_NAMES = ['LAUNDRY_KV', 'WS_KV', 'WESHIRT_KV', 'KV', 'MAKERS_KV', 'EDGEONE_KV']

function resolveKv(env) {
  // 1) env 上的显式绑定
  for (const name of KV_NAMES) {
    if (looksLikeKv(env && env[name])) return { kv: env[name], name: 'env.' + name }
  }
  // 2) 全局变量（平台标准形态：绑定名直接是全局标识符）
  for (const name of KV_NAMES) {
    try {
      if (looksLikeKv(globalThis[name])) return { kv: globalThis[name], name: 'globalThis.' + name }
    } catch {
      /* ignore */
    }
  }
  // 3) 兜底扫描：绑定名未知时也能找到
  //    排除 caches（它也有 get/put/delete，但不是 KV）
  try {
    for (const key of Object.keys(globalThis)) {
      if (key === 'caches') continue
      const v = globalThis[key]
      if (looksLikeKv(v) && !v.match && !v.addAll) {
        return { kv: v, name: 'globalThis.' + key }
      }
    }
  } catch {
    /* ignore */
  }
  return { kv: null, name: null }
}

function pickStore(env) {
  const { kv, name } = resolveKv(env)
  if (kv) {
    _storeInfo = { kind: 'kv', name }
    return createEdgeKVStore(kv)
  }
  _storeInfo = { kind: 'memory', name: null }
  return createMemoryStore()
}

export async function onRequest(context) {
  const env = { ...(context.env || {}), ...(typeof process !== 'undefined' ? process.env : {}) }
  if (!_store) _store = pickStore(env)
  if (!_app) {
    // 把存储探测结果挂到 env 上，供 /api/debug/storage 自检
    env.__STORE_INFO__ = _storeInfo
    _app = createApp({ store: _store, env })
  }
  // Preserve Pages' task lifetime through Hono. Without this bridge a stale
  // board waits for the fallback timeout and background sync can be discarded.
  const executionCtx = typeof context.waitUntil === 'function'
    ? { waitUntil: task => context.waitUntil(task) }
    : undefined
  return _app.fetch(context.request, undefined, executionCtx)
}
