import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, computed, watch, nextTick, reactive } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createMessageHold } from '../frontend/src/messageHold.js'
import { createChannelReadTracker, visibleChannelMessageIds } from '../frontend/src/channelReadTracker.js'

const sources = Object.fromEntries(await Promise.all([
  ['admin', '../frontend/src/components/AdminOperations.vue'],
  ['queue', '../frontend/src/components/QueuePanel.vue'],
  ['messages', '../frontend/src/views/Messages.vue'],
].map(async ([key, path]) => [key, await readFile(new URL(path, import.meta.url), 'utf8')])))

function evaluate(source, bindings, returned) {
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  return new Function(...Object.keys(bindings), script + '\nreturn ' + returned)(...Object.values(bindings))
}
const base = { ref, computed, watch, onMounted() {}, onUnmounted() {}, showToast() {}, showConfirmDialog: async () => {} }
// Transport has its own tests. Keep this view harness free of sockets, timers
// and background refreshes so request ordering remains under each test's control.
const messageBase = {
  ...base, nextTick, createMessageHold,createChannelReadTracker,visibleChannelMessageIds,
  document: { visibilityState: 'visible', querySelector: () => null, getElementById: () => null },
  createChannelTransport: ({ onState }) => ({
    start() { onState('polling') }, stop() { onState('stopped') }, visibilityChanged() {},
  }),
  prepareCommunityFile: async () => assert.fail('text-only fixture must not prepare media'),
  uploadCommunityMedia: async () => assert.fail('text-only fixture must not upload media'),
}
const loggedInUser = (id = 'a') => reactive({ user: { id }, get isLoggedIn() { return Boolean(this.user?.id) } })
const channelDirectory = (dorm) => ({ channels: [{ code: 'public', name: '公共频道' }, ...dorm.buildings], currentBuilding: 'guiyuan' })
const config = (endHour = 22) => ({ broadcast: { enabled: true, startHour: 8, endHour, hours: [] } })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('图片/视频预览阻止刷新后背后消息已读，关闭后完整等待450ms且旧组件不会清新预览', async () => {
  let now=0, sequence=0, serverId='first'
  const timers=new Map(), receipts=[]
  const document={visibilityState:'visible',hasFocus:()=>true,querySelector:selector=>({getBoundingClientRect:()=>selector.includes('composer')?{top:700}:{bottom:80}}),getElementById:()=>null}
  const setTimer=(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:now+delay});return id}
  const clearTimer=id=>timers.delete(id)
  const advance=async ms=>{now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now&&timers.delete(id))await timer.fn();await nextTick()}
  const dorm=reactive({code:'guiyuan',buildings:[]}),route=reactive({query:{channel:'public'}}),user=loggedInUser()
  const panel=evaluate(sources.messages,{...messageBase,document,
    createChannelReadTracker:options=>createChannelReadTracker({...options,setTimer,clearTimer}),
    useRoute:()=>route,useRouter:()=>({replace(){},push(){}}),useDormStore:()=>dorm,useUserStore:()=>user,
    loadBoard:async()=>({board:{floors:[]}}),api:async(path,opts)=>{
      if(path==='/api/messages/read'){receipts.push(opts.body);return {ok:true}}
      if(path==='/api/messages/channels')return channelDirectory(dorm)
      if(path==='/api/messages/notices')return {notices:[]}
      return {messages:[{id:serverId}],pagination:{}}
    },
  },'({reader,load,loadChannels,messageList,messages,setMediaPreview,mediaPreviews,draftVideoFullscreen,onFullscreenChange})')
  panel.messageList.value={querySelectorAll:()=>panel.messages.value.map(row=>({dataset:{messageId:row.id},getBoundingClientRect:()=>({top:120,bottom:240,width:200,height:120})}))}
  const image=Symbol('image'),video=Symbol('video')
  panel.setMediaPreview(true,image)
  await panel.loadChannels();await panel.load();await nextTick();await advance(1000)
  assert.equal(receipts.length,0,'GET message content behind an image is not a read receipt')
  panel.setMediaPreview(false,image);await nextTick();await advance(449)
  assert.equal(receipts.length,0)
  await advance(1);assert.deepEqual(receipts[0].messageIds,['first'])
  serverId='second';panel.setMediaPreview(true,image);panel.setMediaPreview(true,video)
  await panel.load();panel.setMediaPreview(false,image);await nextTick();await advance(1000)
  assert.equal(receipts.length,1,'closing one preview cannot unblock a second fullscreen media component')
  panel.setMediaPreview(false,video);await nextTick();await advance(449);assert.equal(receipts.length,1)
  await advance(1);assert.deepEqual(receipts[1].messageIds,['second'])
  serverId='third';document.fullscreenElement={};panel.onFullscreenChange();await panel.load();await advance(1000)
  assert.equal(receipts.length,2,'standard fullscreen also covers videos from the attachment draft')
  document.fullscreenElement=null;panel.onFullscreenChange();await nextTick();await advance(449);assert.equal(receipts.length,2)
  await advance(1);assert.deepEqual(receipts[2].messageIds,['third'])
  serverId='fourth';panel.draftVideoFullscreen.value=true;await panel.load();await advance(1000);assert.equal(receipts.length,3)
  panel.draftVideoFullscreen.value=false;await nextTick();await advance(449);assert.equal(receipts.length,3)
  await advance(1);assert.deepEqual(receipts[3].messageIds,['fourth'])
  panel.setMediaPreview(true,image);user.user={id:'b'};await nextTick();await panel.loadChannels();await panel.load()
  const nextImage=Symbol('image-next-account');panel.setMediaPreview(true,nextImage);panel.setMediaPreview(false,image)
  await nextTick();await advance(1000);assert.equal(receipts.length,4,'late teardown from the old account cannot clear the new overlay')
  panel.setMediaPreview(false,nextImage);await nextTick();await advance(449);assert.equal(receipts.length,4)
  await advance(1);assert.equal(receipts.length,5)
  panel.reader.dispose()
})

test('三个运营页面的 Vue 脚本与模板均可编译', () => {
  for (const [name, source] of Object.entries(sources)) {
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [], name)
    const script = compileScript(descriptor, { id: name })
    const result = compileTemplate({ source: descriptor.template.content, filename: name + '.vue', id: name, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(result.errors, [], name)
  }
})

test('运营刷新保留脏草稿并提示配置冲突，非法小时阻止保存，失败不丢草稿', async () => {
  let server = config()
  let writes = 0
  let fail = false
  const panel = evaluate(sources.admin, { ...base, api: async (path, opts) => {
    if (opts?.method === 'PATCH') { writes++; if (fail) throw new Error('save failed'); server = opts.body }
    return { config: structuredClone(server), alerts: [] }
  } }, '({ load, save, draft, hoursText, savedConfig, dirty, conflict, validationError, error })')
  await panel.load()
  assert.equal(panel.dirty.value, false)
  panel.draft.value.endHour = 20
  server = config(21)
  await panel.load()
  assert.equal(panel.draft.value.endHour, 20)
  assert.equal(panel.conflict.value, true)
  panel.hoursText.value = '8,24'
  await panel.save()
  assert.equal(writes, 0)
  assert.match(panel.validationError.value, /0~23/)
  panel.hoursText.value = '8,12,22'
  fail = true
  await panel.save()
  assert.equal(panel.draft.value.endHour, 20)
  assert.equal(panel.dirty.value, true)
  assert.equal(panel.error.value, 'save failed')
})

test('运营保存期间新编辑不会被保存响应覆盖，通知已读/解决结果及时展示', async () => {
  const pending = deferred()
  let saving = false
  const panel = evaluate(sources.admin, { ...base, api: async (path, opts) => {
    if (path.includes('/alerts/')) return { alert: { id: 'x', readAt: 'now', resolvedAt: 'now' } }
    if (opts?.method === 'PATCH') { saving = true; return pending.promise }
    return { config: config(), alerts: [{ id: 'x', readAt: null, resolvedAt: null }] }
  } }, '({ load, save, draft, dirty, alerts, updateAlert })')
  await panel.load()
  panel.draft.value.endHour = 20
  const task = panel.save()
  assert.equal(saving, true)
  panel.draft.value.endHour = 19
  pending.resolve({ config: config(20) })
  await task
  assert.equal(panel.draft.value.endHour, 19)
  assert.equal(panel.dirty.value, true)
  await panel.updateAlert(panel.alerts.value[0], { resolved: true })
  assert.equal(panel.alerts.value[0].resolvedAt, 'now')
})

test('排队组件切换账号/设备时忽略旧响应，烘干时长默认60且支持180', async () => {
  const pending = []
  const props = reactive({ machine: { id: 'dry', name: '烘干机', kind: 'dryer', state: 'occupied' }, machineId: '', dorm: 'liuyuan' })
  const user = reactive({ user: { id: 'a' } })
  const panel = evaluate(sources.queue, { ...base, defineProps: () => props, defineEmits: () => () => {}, useUserStore: () => user,
    api: () => { const task = deferred(); pending.push(task); return task.promise } }, '({ load, queue, durationMin, durations })')
  assert.equal(panel.durationMin.value, 60)
  assert.equal(panel.durations.value.at(-1), 180)
  user.user = { id: 'b' }
  await nextTick()
  pending[1].resolve({ queue: [{ id: 'new', mine: true }] })
  await Promise.resolve(); await Promise.resolve()
  pending[0].resolve({ queue: [{ id: 'old', mine: true }] })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(panel.queue.value[0].id, 'new')
  props.machine = { id: 'wash', kind: 'washer' }
  await nextTick()
  assert.equal(panel.durationMin.value, 30)
  assert.deepEqual(panel.durations.value, [30, 42, 50, 70])
  pending[2].resolve({ queue: [] })
})

test('留言切换频道后旧列表不能覆盖当前，失败发送保留草稿，文本安全插值', async () => {
  const pending = []
  const dorm = reactive({ code: 'guiyuan', name: '桂园', buildings: [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }] })
  const route = reactive({ query: { channel: 'guiyuan' } })
  const user = loggedInUser()
  const panel = evaluate(sources.messages, { ...messageBase, useRoute: () => route, useRouter: () => ({ replace() {}, push() {} }), useDormStore: () => dorm, useUserStore: () => user,
    loadBoard: async () => ({ board: { floors: [] } }),
    api: (path, opts) => {
      if (opts?.method === 'POST') return Promise.reject(new Error('offline'))
      if (path === '/api/messages/channels') return Promise.resolve(channelDirectory(dorm))
      const task = deferred(); pending.push({ ...task, path }); return task.promise
    } }, '({ load, loadChannels, messages, text, send, sendError })')
  await panel.loadChannels()
  assert.match(pending[0].path, /channel=guiyuan/)
  route.query = { channel: 'liuyuan' }
  await nextTick()
  assert.match(pending.at(-1).path, /channel=liuyuan/)
  pending.at(-1).resolve({ messages: [{ id: 'new' }], pagination: {} })
  await Promise.resolve(); await Promise.resolve()
  pending[0].resolve({ messages: [{ id: 'old' }], pagination: {} })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(panel.messages.value[0].id, 'new')
  panel.text.value = '<script>draft</script>'
  await panel.send()
  assert.equal(panel.text.value, '<script>draft</script>')
  assert.match(panel.sendError.value, /草稿已保留/)
  assert.equal(dorm.code, 'guiyuan', '浏览频道不能修改住宿绑定')
  pending.at(-1).resolve({ messages: [{ id: 'new' }], pagination: {} })
  assert.equal(sources.messages.includes('v-html'), false)
  assert.match(sources.messages, /\{\{ message\.text \}\}/)
})

test('频道草稿按频道和账号隔离，公共频道发言不携带机器字段', async () => {
  const dorm = reactive({ code: 'guiyuan', buildings: [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }] })
  const route = reactive({ query: { channel: 'guiyuan' } })
  const user = loggedInUser()
  const sent = []
  const panel = evaluate(sources.messages, { ...messageBase, useRoute: () => route, useRouter: () => ({ replace() {}, push() {} }), useDormStore: () => dorm, useUserStore: () => user,
    loadBoard: async () => ({ board: { floors: [] } }),
    api: async (path, opts) => {
      if (opts?.method === 'POST') { sent.push(opts.body); return { ok: true } }
      if (path === '/api/messages/channels') return channelDirectory(dorm)
      return { messages: [], pagination: {} }
    } }, '({ text, reply, send, machineId })')
  panel.text.value = '桂园草稿'
  route.query = { channel: 'liuyuan' }
  await nextTick()
  assert.equal(panel.text.value, '')
  panel.text.value = '柳园草稿'
  route.query = { channel: 'guiyuan' }
  await nextTick()
  assert.equal(panel.text.value, '桂园草稿')
  user.user = { id: 'b' }
  await nextTick()
  assert.equal(panel.text.value, '', '另一个账号不能看到上一账号草稿')
  route.query = { channel: 'public', machine: 'do-not-forward' }
  await nextTick()
  panel.text.value = '公共交流'
  panel.reply.value = { id: 'public-reply', machineId: 'also-do-not-forward' }
  await panel.send()
  assert.equal(sent.at(-1).channel, 'public')
  assert.equal(sent.at(-1).machineId, undefined)
  assert.equal(sent.at(-1).replyTo, 'public-reply')
  assert.equal(panel.text.value, '')
})

test('留言分页去重并防止重复加载，切换频道后迟到的旧页不能追加到新频道', async () => {
  const pending = []
  const dorm = reactive({ code: 'guiyuan', buildings: [{ code: 'guiyuan', name: '桂园' }, { code: 'liuyuan', name: '柳园' }] })
  const route = reactive({ query: { channel: 'guiyuan' } })
  const user = loggedInUser()
  const panel = evaluate(sources.messages, { ...messageBase, useRoute: () => route, useRouter: () => ({ replace() {}, push() {} }), useDormStore: () => dorm, useUserStore: () => user,
    loadBoard: async () => ({ board: { floors: [] } }),
    api: (path) => {
      if (path === '/api/messages/channels') return Promise.resolve(channelDirectory(dorm))
      const task = deferred(); pending.push({ ...task, path }); return task.promise
    } }, '({ load, loadChannels, messages, page, hasMore })')
  await panel.loadChannels()
  pending[0].resolve({ messages: [{ id: 'first' }, { id: 'second' }], pagination: { hasMore: true } })
  await nextTick(); await nextTick()
  const secondPage = panel.load(true)
  await panel.load(true)
  assert.equal(pending.length, 2, '同一页在加载中不能重复请求')
  assert.match(pending[1].path, /page=2/)
  pending[1].resolve({ messages: [{ id: 'second' }, { id: 'third' }], pagination: { hasMore: true } })
  await secondPage
  assert.deepEqual(panel.messages.value.map((message) => message.id), ['first', 'second', 'third'])
  assert.equal(panel.page.value, 2)
  const oldPage = panel.load(true)
  route.query = { channel: 'liuyuan' }
  await nextTick()
  assert.match(pending.at(-1).path, /channel=liuyuan&page=1/)
  pending.at(-1).resolve({ messages: [{ id: 'new-channel' }], pagination: { hasMore: false } })
  await nextTick(); await nextTick()
  pending[2].resolve({ messages: [{ id: 'old-page-three' }], pagination: { hasMore: true } })
  await oldPage
  assert.deepEqual(panel.messages.value.map((message) => message.id), ['new-channel'])
  assert.equal(panel.page.value, 1)
  assert.equal(panel.hasMore.value, false)
})

test('目录头像摘要不依赖机器接口，旧账号目录响应不能覆盖新账号且失败保留最新摘要', async () => {
  const pending=[],dorm=reactive({code:'guiyuan',buildings:[{code:'guiyuan',name:'桂园'}]}),route=reactive({query:{}}),user=loggedInUser()
  const panel=evaluate(sources.messages,{...messageBase,useRoute:()=>route,useRouter:()=>({push(){},replace(){}}),useDormStore:()=>dorm,useUserStore:()=>user,loadBoard:()=>assert.fail('directory must not query machines'),api:path=>{
    if(path!=='/api/messages/channels')return Promise.resolve({notices:[]})
    const job=deferred();pending.push(job);return job.promise
  }},'({loadChannels,channelRows,channelPreview,channelsError})')
  const old=panel.loadChannels();user.user={id:'new'};await nextTick()
  assert.equal(pending.length,2,'同一账号的并发频道目录请求合并，切换账号才另发请求')
  pending.at(-1).resolve({channels:[{code:'public',name:'公共频道',unreadCount:4,avatarData:'data:image/png;base64,fixture',summary:{nick:'李**同学',text:'你好',kind:'text'}}]});await nextTick();await nextTick()
  pending.slice(0,-1).forEach(job=>job.resolve({channels:[{code:'public',name:'旧目录',unreadCount:99}]}));await old
  assert.equal(panel.channelRows.value[0].name,'公共频道')
  assert.equal(panel.channelRows.value[0].unreadCount,4)
  assert.equal(panel.channelPreview(panel.channelRows.value[0]),'李**同学: 你好')
  assert.equal(panel.channelPreview({summary:{nick:'王**同学',kind:'video',text:'private caption'}}),'王**同学: [视频]')
  const failed=panel.loadChannels();pending.at(-1).reject(Error('offline'));await failed
  assert.equal(panel.channelRows.value[0].unreadCount,4)
  assert.match(panel.channelsError.value,/保留当前目录/)
})
