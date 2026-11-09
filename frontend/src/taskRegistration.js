// Reminder presets describe the user's choice; they never determine remote machine state.
export const WASHER_PROGRAMS = Object.freeze([
  { minutes: 6, label: '桶自洁 6分钟' },
  { minutes: 30, label: '标准洗 30分钟' },
  { minutes: 42, label: '加强洗 42分钟' },
  { minutes: 50, label: '加强40°C 50分钟' },
  { minutes: 70, label: '加强60°C 70分钟' },
].map(Object.freeze))

export function machineRemainingMinutes(machine, now = Date.now(), { allowEstimated = false } = {}) {
  if (!machine || !['occupied', 'abnormal'].includes(machine.state) || (!allowEstimated && machine.estimated)) return 0
  const end = Date.parse(machine.finishAt || '')
  if (Number.isFinite(end)) return Math.max(0, Math.ceil((end - now) / 60000))
  const left = Number(machine.leftMin)
  return Number.isFinite(left) && left > 0 ? Math.ceil(left) : 0
}

export function machineActionName(machine) {
  if (machine?.displayName) return String(machine.displayName)
  if (machine?.no != null) return `${machine.no}号${machine.kind === 'dryer' ? '烘干机' : '洗衣机'}`
  return String(machine?.name || (machine?.kind === 'dryer' ? '烘干机' : '洗衣机'))
}

export function registrationSnapshot(machine, form) {
  return {
    machine: {
      id: String(machine?.id || machine?.machineId || ''),
      name: machineActionName(machine),
      kind: machine?.kind === 'dryer' ? 'dryer' : 'washer',
      state: machine?.state || 'unknown',
      finishAt: machine?.finishAt || null,
      ...(Number.isFinite(Date.parse(machine?.finishAt || '')) ? {} : { leftMin: machine?.leftMin ?? null }),
      estimated: machine?.estimated === true,
    },
    form: {
      mode: form.mode === 'machine' ? 'machine' : 'duration',
      minutes: Number(form.minutes),
      program: machine?.kind !== 'dryer' && form.mode !== 'machine' && form.program === 'self_clean' && Number(form.minutes) === 6 ? 'self_clean' : null,
      programLabel: form.mode !== 'machine' && typeof form.programLabel === 'string' ? form.programLabel : '',
      note: String(form.note || '').trim(),
      useDisinfectant: machine?.kind !== 'dryer' && form.useDisinfectant === true,
      selfCleaned: machine?.kind !== 'dryer' && form.selfCleaned === true,
    },
  }
}

export function registrationDescription(snapshot) {
  const { machine, form } = snapshot
  const remaining = machineRemainingMinutes(machine)
  const timing = form.mode === 'machine'
    ? `按机器计时 · 约 ${remaining} 分钟（程序未提供）`
    : `自己选${machine.kind === 'dryer' ? '时长' : '程序'} · ${machine.kind === 'dryer' ? form.minutes + ' 分钟' : form.program === 'self_clean' ? '桶自洁 6分钟' : form.programLabel || form.minutes + ' 分钟（自定义）'}`
  const flags = machine.kind === 'dryer' ? '' : `\n公开标记：${form.useDisinfectant ? '使用消毒液' : '未使用消毒液'}；${form.selfCleaned ? '已完成自清洁' : '未记录自清洁'}`
  return {
    title: machine.kind === 'dryer' ? '确认登记烘干' : '确认登记洗衣',
    message: `${machine.name}\n提醒方式：${timing}\n公开备注：${form.note || '无'}${flags}\n\n登记仅用于计时和提醒，请以机器现场状态为准。`,
  }
}

export function registrationBody(snapshot) {
  const { machine, form } = snapshot
  if (!machine.id) throw new Error('请先选择机器')
  if (form.mode === 'machine' && !machineRemainingMinutes(machine)) throw new Error('机器剩余时间已变化，请重新确认或自己选程序')
  if (form.mode !== 'machine') {
    const valid = machine.kind === 'dryer'
      ? Number.isInteger(form.minutes) && form.minutes >= 10 && form.minutes <= 180
      : Number.isInteger(form.minutes) && form.minutes >= 1 && form.minutes <= 180
    if (!valid) throw new Error(machine.kind === 'dryer' ? '烘干时长请填10–180分钟' : '洗衣时长请填1–180分钟')
  }
  return {
    machineId: machine.id,
    ...(form.mode === 'machine' ? { mode: 'machine' } : { minutes: form.minutes }),
    ...(form.mode !== 'machine' && form.program === 'self_clean' ? { program: 'self_clean' } : {}),
    note: form.note,
    useDisinfectant: form.useDisinfectant,
    selfCleaned: form.selfCleaned,
  }
}

// One confirmation and one write per action; a changed target or draft must be confirmed again.
export function createUserActionConfirmation(confirm) {
  let pending = false
  return async function run({ read, describe, execute, onChanged = () => {} }) {
    if (pending) return { status: 'busy' }
    pending = true
    try {
      const snapshot = JSON.parse(JSON.stringify(read()))
      const fingerprint = JSON.stringify(snapshot)
      try {
        await confirm({ ...describe(snapshot), className: 'user-action-confirm', messageAlign: 'left', allowHtml: false, confirmButtonText: '确认提交', cancelButtonText: '再检查一下' })
      } catch (error) {
        if (error === 'cancel' || error === 'close' || error?.action === 'cancel' || error?.action === 'close') return { status: 'cancelled' }
        throw error
      }
      if (JSON.stringify(read()) !== fingerprint) { onChanged(); return { status: 'changed' } }
      return { status: 'submitted', value: await execute(snapshot) }
    } finally { pending = false }
  }
}
