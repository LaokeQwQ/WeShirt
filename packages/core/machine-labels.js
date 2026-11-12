const label = (value) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim()).slice(0, 120).join('') : ''

/** Binding names describe the physical machine; upstream names remain searchable. */
export function machineLabels(machine, mapping = {}) {
  const id = String(machine?.id ?? '')
  const slots = Object.entries(mapping).filter(([, value]) => value != null && String(value) === id).map(([slot]) => String(slot))
  const slot = slots.length === 1 && /^(?:D[12]|[1-7])$/i.test(slots[0]) ? slots[0].toUpperCase() : ''
  const originalName = label(machine?.originalName) || label(machine?.name) || id
  const remarkName = label(machine?.remarkName) || label(machine?.remark)
  const displayName = slot ? `${slot.replace(/^D/, '')}号${slot.startsWith('D') ? '烘干机' : '洗衣机'}` : remarkName || originalName
  return { slot: slot || null, displayName, originalName, remarkName }
}
