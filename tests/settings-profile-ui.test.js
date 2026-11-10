import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed, watch } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { randomNickExcept } from '../packages/core/profile.js'

const source = await readFile(new URL('../frontend/src/views/Settings.vue', import.meta.url), 'utf8')
const about = await readFile(new URL('../frontend/src/components/AboutDonation.vue', import.meta.url), 'utf8')
const original = { id: 'settings-user', nick: '已保存昵称', avatarUrl: 'data:image/png;base64,old', notifyOn: false, dormBuilding: 'guiyuan' }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function harness(overrides = {}) {
  const calls = [], mounted = [], notices = []
  const store = {
    user: { ...original },
    async setProfile(patch) { calls.push(['profile', patch]); Object.assign(this.user, patch); return this.user },
    async setAvatarUrl(value) { calls.push(['avatar', value]); this.user.avatarUrl = value; return this.user },
    async useDingtalkAvatar() { calls.push(['dingtalk']); this.user.avatarUrl = 'data:image/png;base64,dingtalk'; return { user: this.user } },
    async me() { return this.user },
    ...overrides,
  }
  class ImageStub { width = 256; height = 128; set src(_) { queueMicrotask(() => this.onload()) } }
  const bindings = {
    ref, computed, watch, onMounted: fn => mounted.push(fn), onUnmounted() {},
    useRouter: () => ({}), useRoute: () => ({ query: {} }), useUserStore: () => store, useDormStore: () => ({}),
    api: async () => ({}), NEED_LOGIN: 'NEED_LOGIN', navigator: { doNotTrack: '1' },
    telemetryEnabled: () => false, setTelemetryEnabled() {}, showToast: text => notices.push(text), showConfirmDialog: async () => {},
    findBannedWord: () => '', randomNickExcept, Image: ImageStub,
    URL: { createObjectURL: () => 'blob:local-test', revokeObjectURL() {} },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,upload' }) },
  }
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  const panel = new Function(...Object.keys(bindings), script + '\nreturn {nick,avatarUrl,profileSaving,avatarBusy,showAvatarActions,avatarActions,fileInput,rollNick,saveProfile,selectAvatarAction,onFilePicked,useDingAvatar,clearAvatar}')(...Object.values(bindings))
  return { panel, store, calls, notices, hydrate: mounted.at(-1) }
}

test('random nickname is an immediate local draft and explicit saving writes only the final nickname once', async () => {
  const saving = deferred()
  let writes = 0, patch
  const { panel, store, calls } = harness({ setProfile(value) { writes++; patch = value; return saving.promise } })
  panel.rollNick()
  assert.notEqual(panel.nick.value, original.nick)
  assert.equal(store.user.nick, original.nick)
  assert.equal(panel.avatarUrl.value, original.avatarUrl)
  assert.deepEqual(calls, [], 'preview makes no profile, random API, or avatar request')
  panel.nick.value = '手动定稿'
  const first = panel.saveProfile()
  await panel.saveProfile()
  assert.equal(writes, 1)
  assert.deepEqual(patch, { nick: '手动定稿' })
  panel.rollNick()
  assert.equal(panel.nick.value, '手动定稿', 'an in-flight save cannot be replaced by another random draft')
  saving.resolve({ ...original, nick: patch.nick })
  await first
  assert.equal(panel.profileSaving.value, false)
})

test('avatar menu dispatches custom upload, DingTalk and removal without saving or replacing nickname drafts', async () => {
  const { panel, calls } = harness()
  panel.nick.value = '未保存手动草稿'
  assert.deepEqual(panel.avatarActions.value.map(item => item.name), ['用钉钉头像', '自定义头像', '移除头像，使用昵称首字'])
  let picked = 0
  panel.fileInput.value = { click() { picked++ } }
  panel.showAvatarActions.value = true
  panel.selectAvatarAction({ action: 'upload' })
  assert.equal(picked, 1)
  assert.equal(panel.showAvatarActions.value, false)
  await panel.selectAvatarAction({ action: 'dingtalk' })
  assert.equal(panel.avatarUrl.value, 'data:image/png;base64,dingtalk')
  await panel.onFilePicked({ target: { files: [{ size: 42 }], value: 'selected' } })
  assert.equal(panel.avatarUrl.value, 'data:image/jpeg;base64,upload')
  await panel.selectAvatarAction({ action: 'clear' })
  assert.equal(panel.avatarUrl.value, '')
  assert.equal(panel.avatarActions.value.length, 2)
  assert.equal(panel.nick.value, '未保存手动草稿')
  assert.deepEqual(calls, [['dingtalk'], ['avatar', 'data:image/jpeg;base64,upload'], ['avatar', null]])
})

test('slow avatar or initial profile responses preserve newer manual and random nickname drafts', async () => {
  const avatar = deferred(), profile = deferred()
  const { panel, hydrate } = harness({ useDingtalkAvatar: () => avatar.promise, me: () => profile.promise })
  const refreshing = hydrate()
  const changing = panel.useDingAvatar()
  assert.equal(panel.avatarBusy.value, true)
  panel.rollNick()
  const randomDraft = panel.nick.value
  profile.resolve({ ...original, nick: '迟到旧昵称' })
  await refreshing
  assert.equal(panel.nick.value, randomDraft)
  panel.nick.value = '继续手动编辑'
  avatar.resolve({ user: { ...original, nick: '另一旧昵称', avatarUrl: 'data:image/png;base64,new' } })
  await changing
  assert.equal(panel.nick.value, '继续手动编辑')
  assert.equal(panel.avatarUrl.value, 'data:image/png;base64,new')
  assert.equal(panel.avatarBusy.value, false)
})

test('failed nickname save retains the edited draft and allows retry', async () => {
  const { panel, notices } = harness({ setProfile: async () => { throw new Error('保存失败，请重试') } })
  panel.nick.value = '保留我的草稿'
  await panel.saveProfile()
  assert.equal(panel.nick.value, '保留我的草稿')
  assert.equal(panel.avatarUrl.value, original.avatarUrl)
  assert.equal(panel.profileSaving.value, false)
  assert.equal(notices.at(-1), '保存失败，请重试')
})

test('settings separates privacy, provides accessible avatar actions and compiles both updated templates', () => {
  const groups = [...source.matchAll(/<van-cell-group\b([^>]*)>([\s\S]*?)<\/van-cell-group>/g)]
  assert.ok(groups.find(row => row[1].includes('title="隐私"'))?.[2].includes('title="匿名性能数据"'))
  assert.equal(groups.find(row => row[1].includes('title="通知"'))?.[2].includes('title="匿名性能数据"'), false)
  assert.match(source, /aria-label="更换头像"/)
  assert.match(source, /title="更换头像"[^>]*cancel-text="取消"/)
  assert.doesNotMatch(source, /class="profile-actions"|>换昵称<|>上传头像</)
  for (const [filename, content] of [['Settings.vue', source], ['AboutDonation.vue', about]]) {
    const { descriptor, errors } = parse(content, { filename })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: filename })
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: filename, compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  }
})

test('about retains the original purpose and requested costs, version prefix, GitHub icon and author credit', () => {
  assert.ok(about.includes('本程序的初衷只是为了方便作者自己洗衣服，若有帮到您，您的认可是对我最大的鼓励。如果可以的话，可以请我喝杯咖啡嘛。'))
  assert.match(about, /20 亿 Token 和数天用于开发调试，部署于腾讯云 CloudBase，这些都是不小的费用/)
  assert.ok(about.includes('WeShirt v{{ version }}'))
  assert.match(about, /class="github-icon"/)
  assert.ok(about.includes('Made with 💗 by Laoke'))
})
