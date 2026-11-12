// Only administrator mappings define physical numbers; upstream names/IDs
// must not be guessed into a room slot.
export function machineSlot(mapping,machineId) {
  if(machineId==null)return ''
  return Object.entries(mapping||{}).find(([slot,id])=>/^(?:[1-7]|D[12])$/.test(slot)&&String(id)===String(machineId))?.[0]||''
}
