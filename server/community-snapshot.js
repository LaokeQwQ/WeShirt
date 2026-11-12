const snapshots = new WeakMap()

/** Request-only promise cache: never shares identities or permissions between
 * requests, and is deliberately bypassed when a mutation revalidates access. */
export function communitySnapshot(c, store) {
  let snapshot = snapshots.get(c)
  if (!snapshot) {
    const reads = new Map(), references = new Map()
    const cachedStore = { get(key, fallback = null) {
      if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => store.get(key, fallback)))
      return reads.get(key)
    } }
    snapshot = { store: cachedStore, references }
    snapshots.set(c, snapshot)
  }
  return snapshot
}
