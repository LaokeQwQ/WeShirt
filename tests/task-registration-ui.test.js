import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed, watch, reactive, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as policy from '../frontend/src/taskRegistration.js'

const { WASHER_PROGRAMS, machineRemainingMinutes, registrationSnapshot, registrationDescription, registrationBody, createUserActionConfirmation } = policy
const after = (min) => new Date(Date.now() + min * 60000).toISOString()
const washer = (extra = {}) => ({ id: 'washer', name: '1号洗衣机', kind: 'washer', state: 'occupied', finishAt: after(6), ...extra })
const form = (extra = {}) => ({ mode: 'duration', minutes: 6, note: '公开备注 <b>原文</b>', useDisinfectant: false, selfCleaned: false, ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('6分钟真实余时跟随机器计时，不自动识别成桶自洁或设置已清洁标记', () => {
  const machine = washer()
  const snapshot = registrationSnapshot(machine, form({ mode: 'machine', program: 'self_clean' }))
  const body = registrationBody(snapshot)
  assert.equal(machineRemainingMinutes(machine), 6)
  assert.equal(body.mode, 'machine')
  assert.equal(body.minutes, undefined)
  assert.equal(body.program, undefined)
  assert.equal(body.selfCleaned, false)
  assert.match(registrationDescription(snapshot).message, /按机器计时.*约 6 分钟（程序未提供）/)
  assert.equal(machine.state, 'occupied')
})

test('桶自洁是显式程序选择；手填6或其他分钟不猜程序，washer1–180与dryer10–180边界独立', () => {
  assert.equal(WASHER_PROGRAMS[0].minutes, 6)
  const explicit = registrationSnapshot(washer(), form({ program: 'self_clean' }))
  assert.equal(registrationBody(explicit).program, 'self_clean')
  assert.match(registrationDescription(explicit).message, /桶自洁 6分钟/)
  const custom = registrationSnapshot(washer(), form())
  assert.equal(registrationBody(custom).program, undefined)
  assert.match(registrationDescription(custom).message, /6 分钟（自定义）/)
  for (const minutes of [1, 6, 7, 179, 180]) assert.equal(registrationBody(registrationSnapshot(washer(), form({ minutes }))).minutes, minutes)
  for (const minutes of [0, 181, 6.5, NaN]) assert.throws(() => registrationBody(registrationSnapshot(washer(), form({ minutes }))), /1–180/)
  for (const minutes of [10, 60, 180]) assert.equal(registrationBody(registrationSnapshot(washer({ kind: 'dryer' }), form({ minutes }))).minutes, minutes)
  assert.throws(() => registrationBody(registrationSnapshot(washer({ kind: 'dryer' }), form({ minutes: 6 }))), /10–180/)
})

test('估算、用户登记投影、空闲和过时余时不能被当成可信机器提醒；归零不改变远端状态', () => {
  const now = Date.now()
  for (const machine of [washer({ estimated: true }), washer({ estimated: true, registrationPending: true }), washer({ state: 'idle' }), washer({ finishAt: after(-1), leftMin: 30 })]) assert.equal(machineRemainingMinutes(machine, now), 0)
  const running = washer({ finishAt: after(-1) })
  assert.equal(machineRemainingMinutes(running, now), 0)
  assert.equal(running.state, 'occupied')
  assert.equal(machineRemainingMinutes(washer({ finishAt: new Date(now + 1000).toISOString() }), now), 1)
  const noFinish = washer({ finishAt: null, leftMin: 6 })
  assert.equal(registrationBody(registrationSnapshot(noFinish, form({ mode: 'machine' }))).mode, 'machine')
})

test('确认摘要列出机器/方式/公开原文和标记，使用纯文本弹窗', async () => {
  let options
  const snapshot = registrationSnapshot(washer(), form({ program: 'self_clean', useDisinfectant: true }))
  const run = createUserActionConfirmation(async value => { options = value })
  const result = await run({ read: () => snapshot, describe: registrationDescription, execute: () => 'saved' })
  assert.equal(result.status, 'submitted')
  assert.equal(options.allowHtml, false)
  assert.equal(options.className, 'user-action-confirm')
  assert.match(options.message, /1号洗衣机/)
  assert.match(options.message, /公开备注：公开备注 <b>原文<\/b>/)
  assert.match(options.message, /使用消毒液；未记录自清洁/)
})

test('同一动作并发只出现一次确认和一次写入，取消不执行、不清草稿且可以重试', async () => {
  const confirmation = deferred()
  let confirms = 0, writes = 0
  const draft = form()
  const run = createUserActionConfirmation(() => { confirms++; return confirmation.promise })
  const options = { read: () => draft, describe: () => ({ title: '确认' }), execute: async () => { writes++ } }
  const first = run(options)
  assert.equal((await run(options)).status, 'busy')
  confirmation.reject('cancel')
  assert.equal((await first).status, 'cancelled')
  assert.equal(confirms, 1)
  assert.equal(writes, 0)
  assert.equal(draft.note, form().note)
  const retry = createUserActionConfirmation(async () => {})
  assert.equal((await retry(options)).status, 'submitted')
  assert.equal(writes, 1)
})

test('确认期间改变机位、模式、备注、标记或账号均阻止旧写入并保留新草稿', async () => {
  for (const mutate of [d => { d.machineId = 'other' }, d => { d.mode = 'machine' }, d => { d.note = '新备注' }, d => { d.selfCleaned = true }, d => { d.userId = 'other' }]) {
    const confirmation = deferred()
    const draft = { machineId: 'washer', mode: 'duration', note: '原备注', selfCleaned: false, userId: 'u' }
    let writes = 0, changed = 0
    const run = createUserActionConfirmation(() => confirmation.promise)
    const pending = run({ read: () => draft, describe: () => ({}), execute: () => { writes++ }, onChanged: () => { changed++ } })
    mutate(draft)
    confirmation.resolve()
    assert.equal((await pending).status, 'changed')
    assert.equal(writes, 0)
    assert.equal(changed, 1)
  }
})

const sources = Object.fromEntries(await Promise.all(['Task', 'Room3D', 'Inspection'].map(async name => [name, await readFile(new URL('../frontend/src/views/' + name + '.vue', import.meta.url), 'utf8')])) )
sources.MachineCard = await readFile(new URL('../frontend/src/components/MachineCard.vue', import.meta.url), 'utf8')
function evaluate(source, bindings, returned) {
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  return new Function(...Object.keys(bindings), script + '\nreturn ' + returned)(...Object.values(bindings))
}

test('登记、3D、巡检与机器卡片修改后Vue脚本和模板均可编译', () => {
  for (const [filename, source] of Object.entries(sources)) {
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [], filename)
    const compiled = compileScript(descriptor, { id: filename })
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: filename + '.vue', id: filename, compilerOptions: { bindingMetadata: compiled.bindings } }).errors, [], filename)
  }
})

function taskPanel({ confirm, api } = {}) {
  const user = reactive({ user: { id: 'u' }, ensureAuth: async () => {} })
  return evaluate(sources.Task, { ...policy, ref, computed, watch, onMounted() {}, onUnmounted() {}, useRoute: () => ({ query: {} }), useRouter: () => ({ push() {}, replace() {} }), useUserStore: () => user, useDormStore: () => ({ code: 'example', buildings: [] }), filterDormFloors: board => board?.floors || [], showToast() {}, showConfirmDialog: confirm || (async () => {}), api: api || (async () => ({ tasks: [] })), NEED_LOGIN: 'login', loadBoard: async () => ({ board: { floors: [] } }) }, '({ board, selected, mode, minutes, note, selfCleaned, selectProgram, submit, submitting, stateTextOf })')
}

test('真实Task提交先确认：取消保留备注/标记且不调用API；明确桶自洁只写一次6分钟', async () => {
  let calls = 0
  const cancel = taskPanel({ confirm: async () => { throw 'cancel' }, api: async () => { calls++; return { tasks: [] } } })
  cancel.board.value = { floors: [{ machines: [washer({ state: 'idle', finishAt: null })] }] }
  cancel.selected.value = 'washer'
  await nextTick()
  cancel.selectProgram(WASHER_PROGRAMS[0]); cancel.note.value = '保留备注'; cancel.selfCleaned.value = true
  await cancel.submit()
  assert.equal(calls, 0)
  assert.equal(cancel.note.value, '保留备注')
  assert.equal(cancel.selfCleaned.value, true)
  assert.equal(cancel.submitting.value, false)

  const confirmation = deferred()
  const bodies = []
  let confirms = 0
  const panel = taskPanel({ confirm: () => { confirms++; return confirmation.promise }, api: async (path, opts) => { if (opts?.method === 'POST') bodies.push(opts.body); return { tasks: [] } } })
  panel.board.value = { floors: [{ machines: [washer({ state: 'idle', finishAt: null })] }] }
  panel.selected.value = 'washer'
  await nextTick()
  panel.selectProgram(WASHER_PROGRAMS[0]); panel.note.value = '这次桶自洁'
  const pending = panel.submit()
  await Promise.resolve()
  await panel.submit()
  assert.equal(confirms, 1)
  assert.equal(bodies.length, 0)
  confirmation.resolve()
  await pending
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].minutes, 6)
  assert.equal(bodies[0].program, 'self_clean')
  assert.equal(bodies[0].selfCleaned, false)
})

test('Task到期仅声称登记计时到点；公共卡片优先展示登记来源且occupied零分钟不说空闲', () => {
  const panel = taskPanel()
  assert.match(panel.stateTextOf({ endAt: after(-2), takeState: 'pending' }), /登记计时结束.*请确认机器和衣物/)
  const props = reactive({ machine: washer({ finishAt: after(-1), leftMin: 0 }), favorite: false })
  const card = evaluate(sources.MachineCard, { computed, ref, watch, defineProps: () => props, defineEmits: () => () => {}, useRouter: () => ({ push() {} }), useDormStore: () => ({ code: 'example' }), api: async () => ({}) }, '({ status, detail })')
  assert.equal(card.status.value.text, '运行中')
  assert.match(card.detail.value, /即将完成/)
  assert.doesNotMatch(card.detail.value, /0\s*分钟/)
  props.machine = washer({ state: 'occupied', estimated: true, registrationPending: true, availabilityLabel: '用户已登记，等待设备状态更新' })
  assert.equal(card.status.value.text, '用户已登记，等待设备状态更新')
  assert.doesNotMatch(card.detail.value, /可前往现场使用|运行中/)
})

test('真实Task选中可信6分钟运行机默认跟随余时，POST不标成标准洗或桶自洁', async () => {
  const bodies = []
  const panel = taskPanel({ api: async (path, opts) => { if (opts?.method === 'POST') bodies.push(opts.body); return { tasks: [] } } })
  panel.board.value = { floors: [{ machines: [washer()] }] }
  panel.selected.value = 'washer'
  await nextTick()
  assert.equal(panel.mode.value, 'machine')
  await panel.submit()
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].mode, 'machine')
  assert.equal(bodies[0].minutes, undefined)
  assert.equal(bodies[0].program, undefined)
})

test('整轮异常巡检取消二次确认时不会上报，异常机器、照片和备注都保留', async () => {
  let calls = 0
  const panel = evaluate(sources.Inspection, { createUserActionConfirmation, ref, computed, watch, onMounted() {}, onUnmounted() {}, useDormStore: () => ({ code: 'example' }), showToast() {}, showImagePreview() {}, showConfirmDialog: async () => { throw 'cancel' }, api: async () => { calls++; return {} } }, '({ data, building, selections, toggleMachine, note, photoData, saving, submit })')
  panel.data.value = { buildings: [{ code: 'example', name: '示例楼' }], machines: [washer({ dormBuilding: 'example' })] }
  panel.building.value = 'example'
  await nextTick()
  panel.toggleMachine('washer', true)
  panel.selections.value.washer.reasons.push('offline', 'power_off')
  panel.selections.value.washer.note = '机器插头松动'
  panel.note.value = '现场有积水'; panel.photoData.value = 'data:image/jpeg;base64,fixture'
  await panel.submit()
  assert.equal(calls, 0)
  assert.deepEqual(panel.selections.value.washer.reasons, ['offline', 'power_off'])
  assert.equal(panel.selections.value.washer.note, '机器插头松动')
  assert.equal(panel.note.value, '现场有积水')
  assert.equal(panel.photoData.value, 'data:image/jpeg;base64,fixture')
  assert.equal(panel.saving.value, false)
})

test('整轮巡检无图无备注正常提交仅发送空异常集合；勾机器未选原因则不允许提交', async () => {
  const bodies = [], summaries = []
  const listing = { buildings: [{ code: 'example', name: '示例楼' }], machines: [washer({ dormBuilding: 'example' })], inspections: [] }
  const panel = evaluate(sources.Inspection, { createUserActionConfirmation, ref, computed, watch, onMounted() {}, onUnmounted() {}, useDormStore: () => ({ code: 'example' }), showToast() {}, showImagePreview() {}, showConfirmDialog: async (summary) => { summaries.push(summary) }, api: async (_path, options) => { if (!options) return listing; bodies.push(options.body); return { inspection: { notification: { status: 'not_required' } } } } }, '({ data, building, selections, toggleMachine, submit })')
  panel.data.value = listing; panel.building.value = 'example'
  await nextTick()
  panel.toggleMachine('washer', true)
  await panel.submit()
  assert.equal(summaries.length, 0)
  assert.equal(bodies.length, 0)
  panel.toggleMachine('washer', false)
  await panel.submit()
  assert.equal(summaries.length, 1)
  assert.match(summaries[0].message, /记录本轮全部正常/)
  assert.match(summaries[0].message, /未上传（选填）/)
  assert.deepEqual(bodies, [{ dormBuilding: 'example', issues: [], note: '' }])
})
