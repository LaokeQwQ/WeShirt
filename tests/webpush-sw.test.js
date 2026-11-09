import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker({ windows = [], fetcher = async () => new Response('asset', { headers: { 'content-type': 'text/javascript' } }) } = {}) {
  const listeners = {};
  const notifications = [];
  const opened = [];
  const buckets = new Map();
  const deleted = [];
  let fetchCount = 0;
  const caches = {
    async keys() { return [...buckets.keys()]; },
    async delete(name) { deleted.push(name); return buckets.delete(name); },
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const bucket = buckets.get(name);
      return {
        async match(req) { return bucket.get(req.url)?.clone(); },
        async put(req, res) { bucket.set(req.url, res.clone()); },
        async keys() { return [...bucket.keys()].map((url) => new Request(url)); },
        async delete(req) { return bucket.delete(req.url); }
      };
    }
  };
  const self = {
    location: { origin: 'https://laundry.example.com' },
    addEventListener(name, handler) { listeners[name] = handler; },
    skipWaiting: async () => {},
    registration: { async showNotification(title, options) { notifications.push({ title, ...options }); } },
    clients: { claim: async () => {}, matchAll: async () => windows, async openWindow(url) { opened.push(url); } }
  };
  vm.runInNewContext(source, { self, caches, URL, URLSearchParams, fetch: async (req) => { fetchCount++; return fetcher(req); } });
  async function dispatch(name, extra = {}) {
    const pending = [];
    let response;
    const event = { ...extra, waitUntil(promise) { pending.push(promise); }, respondWith(promise) { response = promise; } };
    listeners[name](event);
    const result = response ? await response : undefined;
    await Promise.all(pending);
    return result;
  }
  return {
    dispatch, notifications, opened, buckets, deleted,
    get fetchCount() { return fetchCount; },
    push(payload) { return dispatch('push', { data: { json: () => payload } }); },
    fetch(path, options) { return dispatch('fetch', { request: new Request(new URL(path, self.location.origin), options) }); },
    click(url) { return dispatch('notificationclick', { notification: { close() {}, data: { url } } }); }
  };
}

test('SW reads legacy text and deduplicates each task with a stable tag', async () => {
  const sw = worker();
  await sw.push({ type: 'early', taskId: 'task_1', text: '桂园 301 烘干机约 5 分钟后结束。', url: '/#/task?task=task_1' });
  await sw.push({ type: 'done', taskId: 'task_1', body: '烘干结束，请取衣。', tag: 'arbitrary' });
  await sw.push({ taskId: 'task_2', text: '洗衣结束。' });
  assert.equal(sw.notifications[0].body, '桂园 301 烘干机约 5 分钟后结束。');
  assert.equal(sw.notifications[0].data.url, '/#/task?task=task_1');
  assert.equal(sw.notifications[0].tag, sw.notifications[1].tag);
  assert.notEqual(sw.notifications[1].tag, sw.notifications[2].tag);
  assert.equal(sw.notifications[1].renotify, false);
});

test('SW bounds notification text and rejects external or malformed destinations', async () => {
  const sw = worker();
  for (const url of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', '/api/users', '/?token=secret#/task', '/#/settings']) {
    await sw.push({ title: '\n' + '衣'.repeat(90), text: 'a'.repeat(1400), url });
    const notice = sw.notifications.at(-1);
    assert.equal(notice.data.url, '/#/task');
    assert.equal(notice.title.length, 80);
    assert.equal(notice.body.length, 1200);
  }
  await sw.push({ type: 'social', threadId: 'thread_3', text: '你收到一条私信。', url: '/#/social?thread=thread_3&token=secret' });
  assert.equal(sw.notifications.at(-1).data.url, '/#/social?thread=thread_3');
  assert.equal(sw.notifications.at(-1).tag, 'weshirt-social-thread_3');
  await sw.push(null);
  assert.match(sw.notifications.at(-1).body, /等衣提醒/);
  await sw.push({ url: 123 });
  assert.equal(sw.notifications.at(-1).data.url, '/#/task');
});

test('notification click navigates only same-origin windows and preserves thread routing', async () => {
  const seen = [];
  const sw = worker({ windows: [
    { url: 'https://evil.example', focus: async () => seen.push('foreign') },
    { url: 'https://laundry.example.com/#/', navigate: async (url) => seen.push(url), focus: async () => seen.push('focused') }
  ] });
  await sw.click('/#/social?thread=abc_2');
  assert.deepEqual(seen, ['/#/social?thread=abc_2', 'focused']);
  assert.equal(sw.opened.length, 0);
  const fresh = worker();
  await fresh.click('https://evil.example');
  assert.deepEqual(fresh.opened, ['/#/task']);
});

test('SW caches hashed same-origin assets and icons for offline use, never identity or HTML', async () => {
  let online = true;
  const sw = worker({ fetcher: async () => { if (!online) throw new Error('offline'); return new Response('static', { headers: { 'content-type': 'text/javascript' } }); } });
  assert.equal(await (await sw.fetch('/assets/index-abc12345.js')).text(), 'static');
  await sw.fetch('/icon-192.png');
  online = false;
  assert.equal(await (await sw.fetch('/assets/index-abc12345.js')).text(), 'static');
  assert.equal(await (await sw.fetch('/icon-192.png')).text(), 'static');
  assert.equal(sw.fetchCount, 2);
  for (const path of ['/', '/index.html', '/api/me', '/assets/plain.js', '/assets/index-abc12345.js?token=secret', 'https://cdn.example.com/assets/index-abc12345.js']) assert.equal(await sw.fetch(path), undefined);
  assert.equal(await sw.fetch('/assets/private-abc12345.js', { headers: { authorization: 'Bearer secret' } }), undefined);
  const html = worker({ fetcher: async () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }) });
  await html.fetch('/assets/missing-abc12345.js');
  assert.equal(html.buckets.get('weshirt-static-v3').size, 0);
  const privateAsset = worker({ fetcher: async () => new Response('private', { headers: { 'cache-control': 'private, max-age=0' } }) });
  await privateAsset.fetch('/assets/private-abc12345.js');
  assert.equal(privateAsset.buckets.get('weshirt-static-v3').size, 0);
});

test('SW caps resources at 60 and removes only previous app cache versions', async () => {
  const sw = worker();
  for (let i = 0; i < 64; i++) await sw.fetch('/assets/item' + i + '-abc12345.js');
  const cache = sw.buckets.get('weshirt-static-v3');
  assert.equal(cache.size, 60);
  assert.equal(cache.has('https://laundry.example.com/assets/item0-abc12345.js'), false);
  sw.buckets.set('weshirt-static-v2', new Map());
  sw.buckets.set('other-app', new Map());
  await sw.dispatch('activate');
  assert.deepEqual(sw.deleted, ['weshirt-static-v2']);
  assert.equal(sw.buckets.has('weshirt-static-v3'), true);
  assert.equal(sw.buckets.has('other-app'), true);
});
