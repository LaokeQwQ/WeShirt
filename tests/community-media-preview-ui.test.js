import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const source = await readFile(new URL('../frontend/src/components/CommunityMedia.vue', import.meta.url), 'utf8')
function fixture({ fail = false } = {}) {
  const events = [], previews = [], mounted = [], unmounted = [], listeners = new Map(), revoked = []
  const document = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  const bindings = {
    ref, defineProps: () => ({ media: { kind: 'image' } }), defineEmits: () => (...args) => events.push(args),
    onMounted: fn => mounted.push(fn), onUnmounted: fn => unmounted.push(fn), document,
    showImagePreview: options => { if (fail) throw Error('preview unavailable'); const item = { options, closed: 0, close() { this.closed++ } }; previews.push(item); return item },
    fetchCommunityMedia: async () => assert.fail('previewing loaded media must not fetch it again'),
    URL: { revokeObjectURL: url => revoked.push(url) },
  }
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  const panel = new Function(...Object.keys(bindings), script + '\nreturn {url,video,preview,setVideoFullscreen,error}')( ...Object.values(bindings))
  mounted.forEach(fn => fn())
  panel.url.value = 'blob:private-test'
  return { panel, events, previews, document, listeners, revoked, unmount: () => unmounted.forEach(fn => fn()) }
}

test('media preview component and native fullscreen bindings compile', () => {
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'media-preview' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'CommunityMedia.vue', id: 'media-preview', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
})

test('image preview reports occlusion until fully closed and cleans up its owned overlay on unmount', () => {
  const f = fixture()
  f.panel.preview(); f.panel.preview()
  assert.equal(f.previews.length, 1)
  assert.equal(f.events[0][0], 'preview-visibility')
  assert.equal(f.events[0][1], true)
  f.previews[0].options.onClosed()
  assert.equal(f.events[1][1], false)
  assert.equal(f.events[0][2], f.events[1][2], 'open and close carry the same component identity')
  f.panel.preview(); f.unmount()
  assert.equal(f.previews[1].closed, 1, 'a body-mounted Vant overlay cannot outlive its message component')
  assert.equal(f.events.at(-1)[1], false)
  const count = f.events.length
  f.previews[1].options.onClosed(); f.panel.preview()
  assert.equal(f.events.length, count, 'late close callbacks and disposed clicks cannot resurrect visibility')
  assert.deepEqual(f.revoked, ['blob:private-test'])
  assert.equal(f.listeners.size, 0)
})

test('standard, prefixed and iOS native video fullscreen report visibility with independent media identities', () => {
  const f = fixture(), other = fixture()
  f.panel.video.value = {}
  const video = f.panel.video.value
  f.document.fullscreenElement = video; f.listeners.get('fullscreenchange')()
  assert.equal(f.events.at(-1)[1], true)
  f.document.fullscreenElement = null; f.listeners.get('fullscreenchange')()
  assert.equal(f.events.at(-1)[1], false)
  f.document.webkitFullscreenElement = video; f.listeners.get('webkitfullscreenchange')()
  assert.equal(f.events.at(-1)[1], true)
  f.document.webkitFullscreenElement = null; f.listeners.get('webkitfullscreenchange')()
  f.panel.setVideoFullscreen(true)
  assert.equal(f.events.at(-1)[1], true, 'webkitbeginfullscreen does not require a document fullscreen element')
  other.panel.setVideoFullscreen(true)
  assert.notEqual(f.events.at(-1)[2], other.events.at(-1)[2])
  f.unmount()
  assert.equal(f.events.at(-1)[1], false)
  f.panel.setVideoFullscreen(true)
  assert.equal(f.events.at(-1)[1], false)
  other.panel.setVideoFullscreen(false); other.unmount()
})

test('failed image preview releases occlusion instead of permanently blocking read receipts', () => {
  const f = fixture({ fail: true })
  f.panel.preview()
  assert.deepEqual(f.events.map(event => event[1]), [true, false])
  assert.equal(f.panel.error.value, 'preview unavailable')
  f.unmount()
})
