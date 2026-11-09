// tests/webpush.test.js
// 不真实发网：仅验证密钥、加密往返、404→gone。纯 Web Crypto。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateVapidKeys, createWebPush, __encryptPayload } from '../packages/core/webpush.js';

const TD = new TextEncoder();
const TU = new TextDecoder();

// ---- 复制 webpush.js 内的工具，供解密验证 ----
function b64urlEncode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function encode(str) { return TD.encode(str); }
async function hkdf(salt, ikm, info, lengthBytes) {
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, ikmKey, lengthBytes * 8);
  return new Uint8Array(bits);
}

function publicPointFromKey(jwk) {
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  const p = new Uint8Array(65);
  p[0] = 0x04; p.set(x, 1); p.set(y, 33);
  return p;
}

// RFC 8291 解密（模拟订阅方 UA）
async function decryptPayload(subscription, result, privateKey) {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  const asPublicKey = await crypto.subtle.importKey(
    'raw', result.asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: asPublicKey }, privateKey, 256
  ));
  const info1 = concat(encode('WebPush: info' + String.fromCharCode(0)), uaPublic, result.asPublic);
  const ikm2 = await hkdf(authSecret, ecdhSecret, info1, 32);
  const cek = await hkdf(result.salt, ikm2, encode('Content-Encoding: aes128gcm' + String.fromCharCode(0)), 16);
  const nonce = await hkdf(result.salt, ikm2, encode('Content-Encoding: nonce' + String.fromCharCode(0)), 12);
  const headerLen = 16 + 4 + 1 + 65;
  const ciphertext = result.body.subarray(headerLen);
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, ciphertext
  ));
  return plain; // 末尾为 0x02
}

test('generateVapidKeys 返回长度正确', async () => {
  const { publicKey, privateKey, privateJwk } = await generateVapidKeys();
  assert.ok(publicKey, 'publicKey 存在');
  assert.ok(privateKey, 'privateKey 存在');
  assert.ok(privateJwk && privateJwk.d, 'privateJwk 含 d');
  const decoded = b64urlDecode(publicKey);
  assert.equal(decoded.length, 65, 'publicKey 解码为 65 字节');
  assert.equal(decoded[0], 0x04, '首字节为 0x04（未压缩点）');
});

test('完整加密往返：RFC 8291 解密一致', async () => {
  // 模拟订阅方（UA）生成 ECDH 密钥对
  const ua = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const uaJwk = await crypto.subtle.exportKey('jwk', ua.publicKey);
  const uaPublic = publicPointFromKey(uaJwk);
  const auth = crypto.getRandomValues(new Uint8Array(16));

  const subscription = {
    endpoint: 'https://push.example.com/abc',
    keys: {
      p256dh: b64urlEncode(uaPublic),
      auth: b64urlEncode(auth),
    },
  };

  const payloadObj = { title: '取衣提醒', machine: 'A12', leftMin: 0 };
  const payloadBytes = TD.encode(JSON.stringify(payloadObj));
  const result = await __encryptPayload(subscription, payloadBytes);

  // 解密
  const plain = await decryptPayload(subscription, result, ua.privateKey);
  assert.ok(plain.length >= 1, '明文非空');
  assert.equal(plain[plain.length - 1], 0x02, '末尾为 0x02 结束符');
  const recovered = plain.subarray(0, plain.length - 1);
  assert.deepEqual(Array.from(recovered), Array.from(payloadBytes), 'payload 一致');

  // 头部字段校验
  assert.deepEqual(Array.from(result.body.subarray(0, 16)), Array.from(result.salt), 'salt 正确');
  const rs = new DataView(result.body.buffer).getUint32(result.body.byteOffset + 16, false);
  assert.equal(rs, 4096, 'rs=4096');
  assert.equal(result.body[20], 65, 'idlen=65');
  assert.deepEqual(Array.from(result.body.subarray(21, 86)), Array.from(result.asPublic), 'as_public 正确');
});

test('send 对 404 返回 gone（mock fetch）', async () => {
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 404 });
  };
  try {
    // 生成合法 UA 订阅密钥，确保加密不抛错、fetch 被真实调用
    const ua = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    );
    const uaJwk = await crypto.subtle.exportKey('jwk', ua.publicKey);
    const uaPublic = publicPointFromKey(uaJwk);

    const env = { VAPID_PRIVATE_JWK: JSON.stringify((await generateVapidKeys()).privateJwk) };
    const push = createWebPush(env);
    const sub = {
      endpoint: 'https://push.example.com/x',
      keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    };
    const out = await push.send(sub, { hello: 'world' });
    assert.equal(called, true, 'fetch 被调用');
    assert.equal(out.ok, false, 'ok=false');
    assert.equal(out.status, 404);
    assert.equal(out.gone, true, 'gone=true');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('无完整 VAPID 密钥时 send 返回 vapid_key_incomplete', async () => {
  const push = createWebPush({ VAPID_PRIVATE_KEY: 'x', VAPID_PUBLIC_KEY: 'y' });
  const sub = {
    endpoint: 'https://push.example.com/x',
    keys: { p256dh: b64urlEncode(new Uint8Array(65).fill(4)), auth: b64urlEncode(new Uint8Array(16)) },
  };
  const out = await push.send(sub, { hi: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.err, 'vapid_key_incomplete');
});
