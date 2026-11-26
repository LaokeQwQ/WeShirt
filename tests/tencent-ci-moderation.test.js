import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createTencentCiModeration, parseTencentCiCallback, signModerationSignal, verifyModerationSignal } from '../packages/core/tencent-ci-moderation.js'

const env = {
  MODERATION_COS_BUCKET: 'moderation-test-1234567890', MODERATION_COS_REGION: 'ap-shanghai',
  MODERATION_COS_SECRET_ID: 'fixtureSecretId1234', MODERATION_COS_SECRET_KEY: 'fixtureSecretKey1234',
  MODERATION_COS_SESSION_TOKEN: 'fixture-token', MODERATION_IMAGE_BIZ_TYPE: 'avatar', MODERATION_TEXT_BIZ_TYPE: 'posts'
}
const now = 1780000000000
const host = 'moderation-test-1234567890.ci.ap-shanghai.myqcloud.com'
const id = 'message-fixture1'
const jobId = 'picture-job-id-001'
const objectKey = 'moderation/pending/text/text-object-00001.txt'
const imageKey = 'moderation/pending/image/image-object-00001.webp'
const reply = (fields, extra = '') => new Response(
  '<?xml version="1.0" encoding="UTF-8"?>\n<Response><JobsDetail>' + fields +
  '</JobsDetail>' + extra + '<RequestId>official_fixture_314</RequestId></Response>',
  { headers: { 'content-type': 'application/xml' } }
)
const identity = (object = '') => '<JobId>' + jobId + '</JobId><DataId>' + id + '</DataId>' +
  (object ? '<Object>' + object + '</Object>' : '')
const unavailable = { code: 'moderation_unavailable', status: 503 }

test('CI signs the request for the fixed bucket and reads only the top level verdict', async () => {
  const text = '测试 & 小组件'
  const provider = createTencentCiModeration(env, { now: () => now, fetcher: async (url, request) => {
    assert.equal(url, 'https://' + host + '/text/auditing')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers['x-cos-security-token'], 'fixture-token')
    const span = '1779999995;1780000060'
    const hash = createHash('sha1').update('post\n/text/auditing\n\nhost=' + host + '\n').digest('hex')
    const key = createHmac('sha1', env.MODERATION_COS_SECRET_KEY).update(span).digest('hex')
    const expected = createHmac('sha1', key).update('sha1\n' + span + '\n' + hash + '\n').digest('hex')
    assert.equal(request.headers.authorization, 'q-sign-algorithm=sha1&q-ak=fixtureSecretId1234&q-sign-time=' +
      span + '&q-key-time=' + span + '&q-header-list=host&q-url-param-list=&q-signature=' + expected)
    assert.equal(request.body, '<Request><Input><Content>' + Buffer.from(text).toString('base64') +
      '</Content><DataId>' + id + '</DataId></Input><Conf><BizType>posts</BizType></Conf></Request>')
    return reply(identity() + '<State>Success</State><Section><Code>999</Code><Result>1</Result></Section><Result>0</Result>')
  } })
  assert.deepEqual(await provider.checkText({ text, dataId: id }),
    { kind: 'text', jobId, decision: 'pass', requestId: 'official_fixture_314' })
})

test('inline image bytes get the correct verdict without unstated default pass', async () => {
  let response
  const provider = createTencentCiModeration(env, { fetcher: async (url, request) => {
    assert.ok(url.endsWith('/image/auditing'))
    assert.match(request.body, /<Content>AQID<\/Content>/)
    assert.match(request.body, /<BizType>avatar<\/BizType>/)
    return response
  } })
  const input = { mime: 'image/png', bytes: Uint8Array.of(1, 2, 3), dataId: id }
  for (const [result, decision] of [['0', 'pass'], ['1', 'block'], ['2', 'review']]) {
    response = reply(identity() + '<Result>' + result + '</Result>')
    assert.equal((await provider.checkImage(input)).decision, decision)
  }
  for (const fields of [
    '<Result/>', '<Result>00</Result>', '<Result>3</Result>', '<Result>1</Result><Result>0</Result>',
    '<Code>error</Code><Result>0</Result>', '<State>Failed</State><Result>0</Result>',
    '<Info><Result>0</Result></Info>', '<Result><Nested/>0</Result>'
  ]) {
    response = reply(identity() + fields)
    await assert.rejects(provider.checkImage(input), unavailable)
  }
  await assert.rejects(provider.checkImage({ ...input, mime: 'image/svg+xml' }), { status: 400 })
  await assert.rejects(provider.checkImage({ ...input, bytes: new Uint8Array(65537) }), { status: 400 })
})

test('invalid cloud responses are rejected without exposing provider content', async () => {
  const text = { text: 'fixture', dataId: id }
  const replies = [
    () => new Response('private-provider-error', { status: 503 }),
    () => new Response('<!DOCTYPE Response SYSTEM "https://fixture.invalid"><Response></Response>'),
    () => new Response('x'.repeat(131073)),
    () => reply(identity() + '<State>Success</State><Result>0</Result>', '<JobsDetail/>'),
    () => reply(identity() + '<Result>0</Result>'),
    () => { throw new Error('private-provider-error') }
  ]
  assert.equal(createTencentCiModeration({}), null)
  assert.equal(createTencentCiModeration({ ...env, MODERATION_COS_REGION: 'http://fixture.invalid' }), null)
  for (const fetcher of replies) {
    const provider = createTencentCiModeration(env, { fetcher })
    await assert.rejects(provider.checkText(text), error => error.code === unavailable.code && error.message === unavailable.code)
  }
})

test('async text and images are private-object jobs with exact correlation on trusted readback', async () => {
  for (const [kind, key, extra] of [
    ['text', objectKey, '<CallbackVersion>Detail</CallbackVersion><CallbackType>1</CallbackType>'],
    ['image', imageKey, '<Async>1</Async>']
  ]) {
    let returned = identity(key) + '<State>Auditing</State>'
    const row = { kind, jobId, dataId: id, objectKey: key }
    const provider = createTencentCiModeration(env, { fetcher: async (url, request) => {
      if (request.method === 'POST') {
        assert.equal(url, 'https://' + host + '/' + kind + '/auditing')
        assert.ok(request.body.includes('<Object>' + key + '</Object>'))
        assert.ok(request.body.includes('<Callback>https://review.example.test/ci?a=b&amp;job=c</Callback>'))
        assert.ok(request.body.includes(extra))
        return reply(identity(key) + '<State>Submitted</State>')
      }
      assert.equal(url, 'https://' + host + '/' + kind + '/auditing/' + jobId)
      return reply(returned)
    } })
    const submitted = await provider.submit({ ...row, callbackUrl: 'https://review.example.test/ci?a=b&job=c' })
    assert.deepEqual(submitted, { kind, jobId, decision: 'pending', requestId: 'official_fixture_314' })
    assert.equal((await provider.getResult(row)).decision, 'pending')
    returned = identity(key) + '<State>Success</State><Result>0</Result>'
    assert.equal((await provider.getResult(row)).decision, 'pass')
    returned = returned.replace(key, 'moderation/pending/' + kind + '/different-other-0001.txt')
    await assert.rejects(provider.getResult(row), unavailable)
    await assert.rejects(provider.getResult({ ...row, jobId: '../something' }), { status: 400 })
    await assert.rejects(provider.submit({ ...row, objectKey: 'public/avatar.png' }), { status: 400 })
    await assert.rejects(provider.submit({ ...row, callbackUrl: 'http://review.example.test' }), { status: 400 })
  }
})

test('async staging uploads exact bytes to the isolated COS host with private non-overwriting ACL', async () => {
  const bytes = new TextEncoder().encode('待审核文字')
  const provider = createTencentCiModeration(env, { fetcher: async (url, request) => {
    assert.equal(url, 'https://moderation-test-1234567890.cos.ap-shanghai.myqcloud.com/' + objectKey)
    assert.equal(request.method, 'PUT')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers['x-cos-forbid-overwrite'], 'true')
    assert.equal(request.headers['x-cos-acl'], 'private')
    assert.match(request.headers.authorization, /q-header-list=content-type;host;x-cos-acl;x-cos-forbid-overwrite&/)
    assert.deepEqual(request.body, bytes)
    return new Response('', { status: 200 })
  } })
  await provider.stage({ kind: 'text', objectKey, mime: 'text/plain; charset=utf-8', bytes })
  await assert.rejects(provider.stage({ kind: 'text', objectKey: imageKey, mime: 'text/plain; charset=utf-8', bytes }), { status: 400 })
})

test('an unsigned Tencent event only queues readback and private signals verify against raw bytes', async () => {
  const event = JSON.stringify({ EventName: 'ReviewText',
    JobsDetail: { JobId: jobId, DataId: id, Object: objectKey, Result: 0, State: 'Success' } })
  const parsed = parseTencentCiCallback(event)
  assert.deepEqual(parsed, { kind: 'text', dataId: id, jobId, objectKey })
  assert.equal(parseTencentCiCallback(event.replace('ReviewText', 'ReviewImage')), null)
  assert.equal(parseTencentCiCallback(JSON.stringify({ code: 0, data: {} })), null)
  assert.equal(parseTencentCiCallback(event.replace(objectKey, 'public/avatar.webp')), null)
  const secret = 'fixturebridgecredentials-32-characters'
  const body = JSON.stringify(parsed)
  const headers = new Headers(await signModerationSignal(secret, body, now))
  assert.equal(await verifyModerationSignal(secret, body, headers, now), true)
  assert.equal(await verifyModerationSignal(secret, body + ' ', headers, now), false)
  assert.equal(await verifyModerationSignal(secret, body, headers, now + 121000), false)
  assert.equal(await verifyModerationSignal(secret + 'other', body, headers, now), false)
  assert.equal(await verifyModerationSignal(secret, body, new Headers(), now), false)
})
