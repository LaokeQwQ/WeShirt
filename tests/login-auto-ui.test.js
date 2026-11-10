import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref, reactive, watch, nextTick } from 'vue'
import { safeLoginTarget, canAutoDingLogin } from '../frontend/src/loginFlow.js'

const main = await readFile(new URL('../frontend/src/main.js', import.meta.url), 'utf8')
const login = await readFile(new URL('../frontend/src/views/Login.vue', import.meta.url), 'utf8')
const api = await readFile(new URL('../frontend/src/api.js', import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const storage = (initial = {}) => { const values = new Map(Object.entries(initial)); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) } }

function panel({ ready = true, loggedIn = false, query = {}, local = {}, session = {}, start = async () => {}, unavailableStorage = false } = {}) {
  const mounted = [], unmounted = [], calls = []
  const localStorage = storage(local), sessionStorage = storage(session)
  if (unavailableStorage) for (const key of ['getItem', 'setItem', 'removeItem']) { localStorage[key] = sessionStorage[key] = () => { throw new Error('storage disabled') } }
  const user = reactive({ ready, isLoggedIn: loggedIn }), route = reactive({ query, fullPath: '/login' })
  const router = { replace: value => calls.push(value) }
  const bindings = { ref, watch, onMounted: fn => mounted.push(fn), onUnmounted: fn => unmounted.push(fn), useRouter: () => router, useRoute: () => route, useUserStore: () => user, safeLoginTarget, canAutoDingLogin, localStorage, sessionStorage, navigator: { userAgent: 'DingTalk Android' }, startDingLogin: async options => { calls.push('start'); return start(options) }, claimCode: async () => { throw new Error('not in this fixture') } }
  const script = login.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '')
  const result = new Function(...Object.keys(bindings), script + '\nreturn {login,skip,tryAutomaticLogin,loading,err}')(...Object.values(bindings))
  return { ...result, mounted: mounted[0], unmount: () => unmounted.forEach(fn => fn()), user, route, calls, localStorage, sessionStorage }
}

test('automatic login waits for initial navigation and preserves protected-page return targets', async () => {
  const ready = deferred(), replaced = []
  const router = { isReady: () => ready.promise, currentRoute: { value: { path: '/', fullPath: '/' } }, replace: value => replaced.push(value) }
  const script = main.match(/const maybeOpenDingLogin = async \(\) => \{[\s\S]*?\n  }\n/)[0]
  const bindings = { router, userStore: { ready: true, isLoggedIn: false }, navigator: { userAgent: 'DingTalk Android' }, sessionStorage: storage(), localStorage: storage(), safeLoginTarget, canAutoDingLogin }
  const run = new Function(...Object.keys(bindings), script + '\nreturn maybeOpenDingLogin')(...Object.values(bindings))
  const pending = run()
  assert.deepEqual(replaced, [])
  router.currentRoute.value = { path: '/login', fullPath: '/login?to=%2Fsettings' }
  ready.resolve(); await pending
  assert.deepEqual(replaced, [], 'the existing protected-page login redirect remains authoritative')
  router.currentRoute.value = { path: '/list', fullPath: '/list?floor=2' }
  await run()
  assert.deepEqual(replaced, [{ path: '/login', query: { to: '/list?floor=2' } }])
  router.isReady = async () => { throw new Error('initial navigation aborted') }
  await assert.doesNotReject(run())
  assert.equal(replaced.length, 1)
})

test('automatic login waits for device restoration and makes one attempt per session, including failure', async () => {
  const failure = deferred(), fixture = panel({ ready: false, start: () => failure.promise })
  await fixture.mounted()
  assert.deepEqual(fixture.calls, [])
  fixture.user.ready = true; await nextTick()
  assert.equal(fixture.calls.filter(x => x === 'start').length, 1)
  failure.reject(new Error('local failure')); await nextTick(); await nextTick()
  assert.equal(fixture.loading.value, false)
  fixture.tryAutomaticLogin()
  assert.equal(fixture.calls.filter(x => x === 'start').length, 1)
  const restored = panel({ ready: false })
  restored.user.isLoggedIn = true; restored.user.ready = true
  await nextTick(); await restored.mounted()
  assert.equal(restored.calls.includes('start'), false)
})

test('logout/guest/error/storage denial suppress auto login, while an explicit login clears opt-out', async () => {
  for (const options of [{ local: { ws_ding_auto_disabled: '1' } }, { session: { ws_ding_guest: '1' } }, { query: { e: 'token' } }, { unavailableStorage: true }]) {
    const fixture = panel(options)
    await fixture.mounted()
    fixture.tryAutomaticLogin()
    assert.equal(fixture.calls.includes('start'), false)
  }
  const fixture = panel({ local: { ws_ding_auto_disabled: '1' }, session: { ws_ding_guest: '1' } })
  await fixture.login()
  assert.equal(fixture.localStorage.getItem('ws_ding_auto_disabled'), null)
  assert.equal(fixture.sessionStorage.getItem('ws_ding_guest'), null)
  assert.equal(fixture.sessionStorage.getItem('ws_ding_auto_attempt'), '1')
})

test('leaving, changing the login route, or choosing guest invalidates a pending OAuth navigation', async () => {
  for (const leave of [f => f.unmount(), f => f.skip(), async f => { f.route.fullPath = '/login?e=token'; await nextTick() }]) {
    const response = deferred(); let navigated = 0
    const fixture = panel({ start: async ({ canRedirect }) => { await response.promise; if (canRedirect()) navigated++ } })
    const pending = fixture.login()
    await leave(fixture)
    response.resolve(); await pending
    assert.equal(navigated, 0)
  }
})

test('startDingLogin itself checks the late navigation guard before assigning location', async () => {
  const request = deferred(), window = { location: { href: 'https://local.example/#/list' } }
  const script = api.match(/export async function startDingLogin[\s\S]*?\n}\n/)[0].replace('export ', '')
  const run = new Function('getDeviceSecret', 'fetch', 'BASE', 'apiError', 'window', script + '\nreturn startDingLogin')(() => 'a'.repeat(32), () => request.promise, '', (message) => new Error(message), window)
  let current = true
  const pending = run({ canRedirect: () => current })
  current = false; request.resolve(Response.json({ url: 'https://oauth.example/authorize' }))
  assert.equal(await pending, false)
  assert.equal(window.location.href, 'https://local.example/#/list')
})
