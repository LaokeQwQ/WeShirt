import { claimNotificationDelivery } from './notification-delivery.js'
import { mobileDigest } from './mobile-auth.js'

// One durable receipt per destination: a working provider must never consume a
// different provider's retry. Native outboxes own delivery once safely queued.
export async function deliverTaskNotificationChannels({ atomicStore, scope, previous = {}, channels, now = Date.now() }) {
  const state = { ...previous }
  let anyOk = false, attempted = 0
  for (const channel of channels) {
    if (state[channel.id]?.complete) { anyOk ||= state[channel.id].delivered === true; continue }
    if (!atomicStore && (state[channel.id]?.attempts >= 4 || state[channel.id]?.nextAt > now)) continue
    const eventId = `task:${scope}:${channel.id}`
    const key = 'mobile:limit:task-channel-delivery:' + await mobileDigest(eventId)
    let claim
    try {
      const receipt = atomicStore && await atomicStore.get(key)
      if (receipt?.value?.eventId === eventId && receipt.value.sentAt) {
        state[channel.id] = { complete:true, delivered:receipt.value.delivered !== false, at:new Date(receipt.value.sentAt).toISOString() }
        anyOk ||= state[channel.id].delivered
        continue
      }
      claim = await claimNotificationDelivery(atomicStore, key, eventId, now)
    } catch { state[channel.id] = { complete:false, error:'delivery_unavailable' }; continue }
    if (!claim) continue
    attempted++
    let result
    try { result = await channel.send() } catch { result = { ok:false } }
    const delivered = result?.ok === true || result?.queued === true
    const complete = delivered || result?.gone === true || result?.skipped === true
    const attempts = (Number(state[channel.id]?.attempts) || 0) + 1
    state[channel.id] = { complete, delivered, attempts, at:new Date(now).toISOString(), ...(complete ? {} : {error:'delivery_failed',nextAt:now+60000*2**Math.min(3,attempts-1)}) }
    anyOk ||= delivered
    // A failed receipt persistence never retries the external request in this
    // run. The task's channel snapshot also records the successful outcome.
    await claim.finish(complete).catch(() => {})
  }
  return { state, anyOk, attempted, complete:channels.length > 0 && channels.every(channel => state[channel.id]?.complete) }
}
