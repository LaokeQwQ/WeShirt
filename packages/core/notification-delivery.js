const MINUTE = 60000

// The durable CAS bridge serializes external sends across independent edge
// runtimes. An unavailable bridge never falls back to an unguarded send.
export async function claimNotificationDelivery(atomicStore, key, eventId, now, { cooldownMs = 0, stateHash } = {}) {
  if (!atomicStore) return { finish: async () => {} }
  const row = await atomicStore.get(key)
  const value = row?.value || {}
  if (value.sentAt && value.eventId === eventId || now - (value.sentAt || value.previousSentAt || 0) < cooldownMs
    || stateHash && (value.stateHash || value.previousStateHash) === stateHash
    || value.leaseUntil > now || value.retryAfter > now || value.eventId === eventId && value.attempts >= 4) return null
  const token = crypto.randomUUID()
  const next = { eventId, token, attempts: value.eventId === eventId ? (value.attempts || 0) + 1 : 1, leaseUntil: now + 2 * MINUTE,
    ...(value.sentAt || value.previousSentAt ? {previousSentAt:value.sentAt || value.previousSentAt} : {}),
    ...(value.stateHash || value.previousStateHash ? {previousStateHash:value.stateHash || value.previousStateHash} : {}) }
  const expiresAt = now + 14 * 86400000
  if (!await atomicStore.compareAndSet(key, row?.version ?? null, next, { expiresAt })) return null
  return { finish: async ok => {
    const claimed = await atomicStore.get(key)
    if (claimed?.value?.token === token) await atomicStore.compareAndSet(key, claimed.version,
      { ...next, leaseUntil: 0, retryAfter: ok ? 0 : now + MINUTE * 2 ** (next.attempts - 1), ...(ok ? { sentAt: now, ...(stateHash ? { stateHash } : {}) } : {}) }, { expiresAt })
  } }
}
