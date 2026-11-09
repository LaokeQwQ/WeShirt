// packages/core/webpush.js
// Agent Push — Web Push 加密推送 (RFC 8291 / RFC 8292)
// 纯 Web Crypto (crypto.subtle)，绝不依赖 node:crypto 专属 API。

import { safeErrorCategory } from './util.js';

const TD = new TextEncoder();
const TU = new TextDecoder();

// ---------- base64url 工具 ----------

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

// ---------- 字节工具 ----------

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function encode(str) {
  return TD.encode(str);
}

function publicPointFromJwk(jwk) {
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  const p = new Uint8Array(65);
  p[0] = 0x04;
  p.set(x, 1);
  p.set(y, 33);
  return p;
}

// ---------- HKDF (Web Crypto) ----------

async function hkdf(salt, ikm, info, lengthBytes) {
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    ikmKey,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

// ---------- VAPID 密钥对生成 ----------

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const point = publicPointFromJwk(jwk);
  return {
    publicKey: b64urlEncode(point),
    privateKey: jwk.d,
    privateJwk: jwk,
  };
}

// ---------- VAPID 解析 ----------

function resolveVapid(env) {
  env = env || {};
  if (env.VAPID_PRIVATE_JWK) {
    try {
      const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
      if (jwk && jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.d && jwk.x && jwk.y) {
        if ([jwk.x, jwk.y, jwk.d].some((part) => !/^[A-Za-z0-9_-]{43}$/.test(part) || b64urlDecode(part).length !== 32)) return { incomplete: true };
        const publicKeyB64url = b64urlEncode(publicPointFromJwk(jwk));
        if (env.VAPID_PUBLIC_KEY && String(env.VAPID_PUBLIC_KEY).replace(/=+$/, '') !== publicKeyB64url) return { incomplete: true };
        return { privateJwk: jwk, publicKeyB64url, incomplete: false };
      }
    } catch (_) { /* fall through */ }
  }
  // 仅有 d（无 x/y）无法构造可导入的 JWK，标记为不完整
  if (env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY) {
    return { incomplete: true };
  }
  return { incomplete: true };
}

/** 校验订阅的可用公网 HTTPS 地址与真实 P-256 公钥。 */
export async function validatePushSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) return { ok: false, err: 'invalid_subscription' };
  let url;
  try { url = new URL(subscription.endpoint); } catch { return { ok: false, err: 'invalid_endpoint' }; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || !host.includes('.') || /^(?:\d+\.){3}\d+$/.test(host) || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || /(?:^|\.)(?:localtest\.me|lvh\.me|nip\.io|sslip\.io)$/.test(host)) return { ok: false, err: 'invalid_endpoint' };
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  try {
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{87}=?$/.test(p256dh) || !/^[A-Za-z0-9_-]{22}(?:==)?$/.test(auth)) return { ok: false, err: 'invalid_subscription_keys' };
    const point = b64urlDecode(p256dh);
    if (point.length !== 65 || point[0] !== 4 || b64urlDecode(auth).length !== 16) return { ok: false, err: 'invalid_subscription_keys' };
    await crypto.subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch { return { ok: false, err: 'invalid_subscription_keys' }; }
  if (subscription.expirationTime != null && (!Number.isFinite(subscription.expirationTime) || subscription.expirationTime <= Date.now())) return { ok: false, err: 'subscription_expired' };
  return { ok: true, subscription: { endpoint: url.href, keys: { p256dh, auth }, ...(subscription.expirationTime == null ? {} : { expirationTime: subscription.expirationTime }) } };
}

// ---------- RFC 8291 加密 ----------

async function encryptPayload(subscription, payloadBytes) {
  // 1) ephemeral ECDH P-256
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const asJwk = await crypto.subtle.exportKey('jwk', eph.publicKey);
  const asX = b64urlDecode(asJwk.x);
  const asY = b64urlDecode(asJwk.y);
  const asPublic = new Uint8Array(65);
  asPublic[0] = 0x04;
  asPublic.set(asX, 1);
  asPublic.set(asY, 33);

  // 2) ua_public（65 字节未压缩点）
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // 3) deriveBits ECDH -> 32B ecdhSecret
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, eph.privateKey, 256
  ));

  // 4) auth_secret（16B）
  const authSecret = b64urlDecode(subscription.keys.auth);

  // 5) HKDF 第一轮
  const info1 = concat(encode('WebPush: info' + String.fromCharCode(0)), uaPublic, asPublic);
  const ikm2 = await hkdf(authSecret, ecdhSecret, info1, 32);

  // 6) 随机 salt + 第二轮 HKDF
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm2, encode('Content-Encoding: aes128gcm' + String.fromCharCode(0)), 16);
  const nonce = await hkdf(salt, ikm2, encode('Content-Encoding: nonce' + String.fromCharCode(0)), 12);

  // 7) 明文 = payload + 0x02（RFC 8291 最小填充结束符）
  const plaintext = concat(payloadBytes, new Uint8Array([0x02]));

  // 8) AES-128-GCM
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, plaintext
  ));

  // 9) 组装 body
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const idlen = new Uint8Array([65]);
  const body = concat(salt, rs, idlen, asPublic, ciphertext);

  return { body, salt, asPublic, cek, nonce };
}

/**
 * @internal
 * 供测试使用的加密原语，返回 { body, salt, asPublic, cek, nonce }。
 */
export async function __encryptPayload(subscription, payloadBytes) {
  return encryptPayload(subscription, payloadBytes);
}

// ---------- VAPID JWT (RFC 8292) ----------

async function buildVapidJwt(vapid, endpoint, subject) {
  const key = await crypto.subtle.importKey(
    'jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  };
  const h = b64urlEncode(TD.encode(JSON.stringify(header)));
  const p = b64urlEncode(TD.encode(JSON.stringify(payload)));
  const signingInput = h + '.' + p;
  // Web Crypto ECDSA 输出为 raw r||s 64 字节，正好是 JWS 格式
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, TD.encode(signingInput)
  ));
  return signingInput + '.' + b64urlEncode(sig);
}

// ---------- 工厂 ----------

export function createWebPush(env) {
  const vapid = resolveVapid(env);
  const subject = (env && env.VAPID_SUBJECT) || 'mailto:dev@weshirt.local';
  const jwtCache = new Map();

  async function send(subscription, payloadObj) {
    if (vapid.incomplete) return { ok: false, err: 'vapid_key_incomplete' };
    const checked = await validatePushSubscription(subscription);
    if (!checked.ok) return checked;
    subscription = checked.subscription;
    try {
      const payloadBytes = TD.encode(JSON.stringify(payloadObj));
      if (payloadBytes.length > 3800) return { ok: false, err: 'payload_too_large' };
      const { body } = await encryptPayload(subscription, payloadBytes);
      const origin = new URL(subscription.endpoint).origin;
      let cached = jwtCache.get(origin);
      if (!cached || Date.now() >= cached.until) {
        cached = { jwt: await buildVapidJwt(vapid, subscription.endpoint, subject), until: Date.now() + 10 * 3600000 };
        if (jwtCache.size >= 16) jwtCache.delete(jwtCache.keys().next().value);
        jwtCache.set(origin, cached);
      }
      const jwt = cached.jwt;
      const headers = {
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'ttl': '86400',
        'authorization': 'vapid t=' + jwt + ', k=' + vapid.publicKeyB64url,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let res;
      try { res = await fetch(subscription.endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' }); }
      finally { clearTimeout(timer); }
      const status = res.status;
      if (status >= 200 && status < 300) return { ok: true, status };
      return { ok: false, status, gone: status === 404 || status === 410 };
    } catch (e) {
      return { ok: false, err: safeErrorCategory(e) };
    }
  }

  return { send };
}
