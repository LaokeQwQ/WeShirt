import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateVapidKeys, createWebPush, validatePushSubscription } from '../packages/core/webpush.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
async function subscription(endpoint = 'https://push.example.com/messages/123') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { endpoint, expirationTime: null, keys: { p256dh: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } };
}

test('subscription validation rejects local/private endpoints and malformed or expired keys', async () => {
  const valid = await subscription();
  assert.equal((await validatePushSubscription(valid)).ok, true);
  for (const endpoint of ['http://push.example.com/x', 'https://user:pass@push.example.com/x', 'https://push.example.com:8443/x', 'https://push.example.com/x#fragment', 'https://localhost/x', 'https://localhost./x', 'https://127.0.0.1/x', 'https://0x7f000001/x', 'https://[::1]/x', 'https://10.1.2.3/x', 'https://svc.internal/x', 'https://192.168.1.1.nip.io/x', 'https://127.0.0.1.sslip.io/x']) {
    const result = await validatePushSubscription({ ...valid, endpoint });
    assert.equal(result.ok, false, endpoint);
    assert.equal(result.err, 'invalid_endpoint', endpoint);
  }
  for (const keys of [{ ...valid.keys, auth: 'short' }, { ...valid.keys, p256dh: b64(new Uint8Array(65).fill(4)) }, { ...valid.keys, p256dh: b64(new Uint8Array(65)) }]) assert.equal((await validatePushSubscription({ ...valid, keys })).err, 'invalid_subscription_keys');
  assert.equal((await validatePushSubscription({ ...valid, expirationTime: Date.now() - 1 })).err, 'subscription_expired');
  assert.equal((await validatePushSubscription({ ...valid, expirationTime: 'tomorrow' })).err, 'subscription_expired');
  assert.equal((await validatePushSubscription(null)).ok, false);
});

test('send validates before fetch and identifies only HTTP 404/410 as gone', async (t) => {
  const keys = await generateVapidKeys();
  const push = createWebPush({ VAPID_PRIVATE_JWK: JSON.stringify(keys.privateJwk), VAPID_PUBLIC_KEY: keys.publicKey });
  const sub = await subscription();
  let fetchCount = 0;
  let status = 201;
  const options = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, opts) => { fetchCount++; options.push(opts); return new Response(null, { status }); });
  assert.equal((await push.send({ ...sub, endpoint: 'http://127.0.0.1/' }, { body: 'x' })).ok, false);
  assert.equal((await push.send(sub, { body: 'a'.repeat(3801) })).err, 'payload_too_large');
  assert.equal(fetchCount, 0);
  const first = await push.send(sub, { body: '桂园 301 烘干结束，请取衣。', taskId: 't1' });
  assert.equal(first.ok, true);
  const authorization = options[0].headers.authorization;
  for (const next of [404, 410, 429, 500]) {
    status = next;
    const result = await push.send(sub, { body: '提醒' });
    assert.equal(result.ok, false);
    assert.equal(result.gone, next === 404 || next === 410);
    assert.equal(options.at(-1).redirect, 'error');
    assert.ok(options.at(-1).signal instanceof AbortSignal);
    assert.equal(options.at(-1).headers.authorization, authorization, 'same-origin VAPID JWT reused');
  }
});

test('send refuses mismatched VAPID public key and returns fetch failures without gone', async (t) => {
  const keys = await generateVapidKeys();
  const sub = await subscription();
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; throw new Error('redirect blocked'); });
  const broken = createWebPush({ VAPID_PRIVATE_JWK: JSON.stringify(keys.privateJwk), VAPID_PUBLIC_KEY: (await generateVapidKeys()).publicKey });
  assert.equal((await broken.send(sub, {})).err, 'vapid_key_incomplete');
  assert.equal(count, 0);
  const push = createWebPush({ VAPID_PRIVATE_JWK: JSON.stringify(keys.privateJwk) });
  const result = await push.send(sub, { body: '通知' });
  assert.equal(result.ok, false);
  assert.equal(result.err, 'redirect blocked');
  assert.equal(result.gone, undefined);
});
