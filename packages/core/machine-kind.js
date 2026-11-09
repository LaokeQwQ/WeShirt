// Upstream category metadata is more reliable than device aliases or old local bindings.
const CATEGORY_KINDS = Object.freeze({ '00': 'washer', '01': 'washer', '02': 'dryer' })

export function normalizeMachineCategory(value) {
  return typeof value === 'string' && Object.hasOwn(CATEGORY_KINDS, value) ? value : null
}

export function resolveMachineKind(machine, mapping = {}) {
  const category = normalizeMachineCategory(machine?.categoryCode)
  if (category) return CATEGORY_KINDS[category]
  const bindings = Object.entries(mapping || {}).filter(([, id]) => id != null && String(id) === String(machine?.id))
  if (bindings.some(([slot]) => /(?:^|-)D\d+$/i.test(slot))) return 'dryer'
  if (bindings.some(([slot]) => /(?:^|-)\d+$/.test(slot))) return 'washer'
  if (machine?.kind === 'dryer' || machine?.kind === 'washer') return machine.kind
  return /烘干|dryer/i.test(String(machine?.name || '')) ? 'dryer' : 'washer'
}
