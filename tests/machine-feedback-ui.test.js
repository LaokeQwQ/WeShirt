import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed, watch, reactive, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const sources = Object.fromEntries(await Promise.all(['MachineFeedback', 'MachineFeedbackAdmin', 'MachineCard'].map(async name => [name, await readFile(new URL(`../frontend/src/components/${name}.vue`, import.meta.url), 'utf8')])))
function evaluate(name, overrides = {}, returned) {
  const script = sources[name].match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  const bindings = { ref, computed, watch, onMounted() {}, onUnmounted() {}, defineProps: () => reactive({ machineId: 'machine-one', name: '1号洗衣机' }), useDormStore: () => ({ buildings: [] }), getToken: () => 'fixture-user', getAdminSession: () => null, api: async () => ({}), showConfirmDialog: async () => {}, ...overrides }
  return new Function(...Object.keys(bindings), script + '\nreturn ' + returned)(...Object.values(bindings))
}

test('机器反馈、处理和2D入口使用真实Vue脚本模板编译', () => {
  for (const [name, source] of Object.entries(sources)) {
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: name })
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: name + '.vue', id: name, compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  }
})

test('用户反馈须确认，切换机器或账号后不发送旧目标，重复反馈显示处理中', async () => {
  let token = 'first', confirm, calls = []
  const props = reactive({ machineId: 'one', name: '1号洗衣机' })
  const panel = evaluate('MachineFeedback', {
    defineProps: () => props, getToken: () => token,
    showConfirmDialog: () => new Promise(resolve => { confirm = resolve }),
    api: async (path, options) => { calls.push({ path, options }); return { duplicate: true } },
  }, '({ detail, submit, receipt, saving })')
  panel.detail.value = '现场名称与页面不符'
  let pending = panel.submit()
  token = 'second'; confirm(); await pending
  assert.equal(calls.length, 0)
  pending = panel.submit()
  props.machineId = 'two'; await nextTick(); confirm(); await pending
  assert.equal(calls.length, 0)
  panel.detail.value = '2号机器位置不对'
  pending = panel.submit(); confirm(); await pending
  assert.equal(calls[0].path, '/api/machines/two/feedback')
  assert.deepEqual(calls[0].options.body, { type: 'name', detail: '2号机器位置不对' })
  assert.match(panel.receipt.value, /处理中/)
  assert.equal(panel.detail.value, '')
  assert.equal(panel.saving.value, false)
})

test('后台反馈分页读取实际返回结构，关闭须说明，确认后提交完整处理结果', async () => {
  const writes = [], row = { id: 'mf_one', machineId: 'one', displayName: '1号洗衣机', status: 'open', resolution: '', canHandle: true }
  const panel = evaluate('MachineFeedbackAdmin', {
    api: async (path, options) => {
      if (options?.method === 'PATCH') { writes.push({ path, options }); return { feedback: { id: row.id, status: 'resolved' } } }
      return { feedback: [row], pagination: { total: 25, hasMore: true } }
    },
  }, '({ load, rows, total, hasMore, drafts, save, error })')
  await panel.load()
  assert.equal(panel.rows.value[0].canHandle, true)
  assert.equal(panel.total.value, 25)
  assert.equal(panel.hasMore.value, true)
  panel.drafts.value.mf_one.status = 'resolved'
  await panel.save(row)
  assert.equal(writes.length, 0)
  assert.match(panel.error.value, /处理说明/)
  panel.drafts.value.mf_one.resolution = '已核对现场并修改名称'
  await panel.save(row)
  assert.equal(writes[0].path, '/api/admin/machine-feedback/mf_one')
  assert.equal(writes[0].options.auth, 'optional')
  assert.deepEqual(writes[0].options.body, { status: 'resolved', resolution: '已核对现场并修改名称' })
})
