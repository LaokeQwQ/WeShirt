// 上游偶发错误的重试行为（node:test）
// 背景：线上出现过上游短时间对全部请求返回 405（WAF 抖动），
// 没有重试时一次抖动就让看板陈旧一个多小时。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHaierClient, diagnoseHaier } from '../packages/core/haier.js'

const real = globalThis.fetch

/** 用一个可控的 fetch 桩替换全局，记录每次调用的 URL 与尝试次数 */
function withFetch(handler, fn) {
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    return handler(url, init, calls)
  }
  return Promise.resolve(fn(() => calls)).finally(() => {
    globalThis.fetch = real
  })
}

const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

const ENV = {
  HAIER_MODE: 'real',
  HAIER_URL: 'https://up.example.com',
  HAIER_POSITION_ID: '90001',
  HAIER_HEADERS: '{}',
  HAIER_TIMEOUT_MS: '3000',
}

test('405 会被重试，最终成功', async () => {
  await withFetch(
    (url, init, n) => {
      // 前两次 405，第三次成功
      if (n <= 2) return jsonRes({}, 405)
      if (String(url).includes('floorCodeList')) return jsonRes({ code: 0, data: ['1'] })
      if (String(url).includes('positionDevice'))
        return jsonRes({ code: 0, data: [{ categoryCode: '00', total: 1 }] })
      return jsonRes({ code: 0, data: { total: 0, items: [] } })
    },
    async (count) => {
      const c = createHaierClient(ENV)
      const list = await c.fetchStatus()
      assert.ok(Array.isArray(list))
      assert.ok(count() > 2, '应发生重试')
    }
  )
})

test('404 不重试（不是偶发错误）', async () => {
  await withFetch(
    () => jsonRes({}, 404),
    async (count) => {
      const c = createHaierClient(ENV)
      await assert.rejects(() => c.fetchStatus(), /HAIER HTTP 404/)
      // 两个元数据请求各试 1 次 = 2 次；不应有第 3 次
      assert.equal(count(), 2, `期望 2 次实际 ${count()}`)
    }
  )
})

test('重试耗尽后报错带尝试次数与端点', async () => {
  await withFetch(
    () => jsonRes({}, 500),
    async () => {
      const c = createHaierClient(ENV)
      await assert.rejects(
        () => c.fetchStatus(),
        (e) => {
          assert.match(e.message, /HAIER HTTP 500/)
          assert.match(e.message, /\(tried 3x\)/)
          // 必须能看出是哪个端点
          assert.match(e.message, /position\/(floorCodeList|positionDevice)/)
          return true
        }
      )
    }
  )
})

test('业务 code != 0 不重试', async () => {
  await withFetch(
    () => jsonRes({ code: 202, message: '请求方法错误' }),
    async (count) => {
      const c = createHaierClient(ENV)
      await assert.rejects(() => c.fetchStatus(), /HAIER code 202/)
      assert.equal(count(), 2, '两个元数据请求各 1 次')
    }
  )
})

test('diagnoseHaier 逐端点报告，不泄露请求头', async () => {
  await withFetch(() => jsonRes({ code: 0, data: [] }), async () => {
    const out = await diagnoseHaier({
      ...ENV,
      HAIER_HEADERS: JSON.stringify({ Authorization: 'Bearer SECRET_TOKEN' }),
    })
  assert.equal(out.mode, 'real')
  assert.equal(out.steps.length, 3)
  for (const s of out.steps) {
    assert.ok('status' in s || 'error' in s)
    // 任何一步都不能把 Authorization 带出来
    assert.ok(!JSON.stringify(s).includes('SECRET_TOKEN'))
  }
  assert.deepEqual(
    out.steps.map((s) => s.label),
    ['floorCodeList', 'positionDevice', 'deviceDetailPage']
  )
  })
})

const statusData = (url, init) => {
  if (String(url).includes('floorCodeList')) return ['1']
  if (String(url).includes('positionDevice')) return [{ categoryCode: '00', total: 1 }]
  return { total: 1, items: [{ deviceId: '1', name: '洗衣机', floorCode: '1', state: 2 }] }
}

test('匿名读取成功时不发送 token（请求头名称大小写无关）', async () => {
  await withFetch((url, init) => {
    assert.equal(new Headers(init.headers).has('authorization'), false)
    return jsonRes({ code: 0, data: statusData(url, init) })
  }, async (count) => {
    const list = await createHaierClient({ ...ENV, HAIER_HEADERS: '{"authorization":"Bearer expired"}' }).fetchStatus()
    assert.equal(list[0].state, 'occupied')
    assert.equal(count(), 3)
  })
})

test('匿名 401 后 token 503 按最终状态重试并恢复', async () => {
  let failedToken = false
  await withFetch((url, init) => {
    if (!new Headers(init.headers).has('authorization')) return jsonRes({}, 401)
    if (String(url).includes('floorCodeList') && !failedToken) {
      failedToken = true
      return jsonRes({}, 503)
    }
    return jsonRes({ code: 0, data: statusData(url, init) })
  }, async () => {
    const list = await createHaierClient({ ...ENV, HAIER_HEADERS: '{"Authorization":"Bearer valid"}' }).fetchStatus()
    assert.equal(list.length, 1)
    assert.equal(failedToken, true)
  })
})

test('匿名 401 后 token 429 保留最终错误，不能误报 401', async () => {
  await withFetch((url, init) => jsonRes({}, new Headers(init.headers).has('authorization') ? 429 : 401), async () => {
    await assert.rejects(
      () => createHaierClient({ ...ENV, HAIER_HEADERS: '{"Authorization":"Bearer limited"}' }).fetchStatus(),
      /HAIER HTTP 429.*tried 3x/
    )
  })
})

test('token 优先鉴权失败后匿名回退，每个请求拥有独立超时信号', async () => {
  const signals = new Set()
  await withFetch((url, init) => {
    assert.equal(signals.has(init.signal), false)
    signals.add(init.signal)
    if (new Headers(init.headers).has('authorization')) return jsonRes({}, 401)
    assert.equal(init.signal.aborted, false)
    return jsonRes({ code: 0, data: statusData(url, init) })
  }, async (count) => {
    const list = await createHaierClient({ ...ENV, HAIER_AUTH_MODE: 'token', HAIER_HEADERS: '{"Authorization":"Bearer expired"}' }).fetchStatus()
    assert.equal(list.length, 1)
    assert.equal(count(), 6)
  })
})

test('响应头已返回但响应体超时也会取消并重试', async () => {
  let aborted = 0
  await withFetch((url, init) => ({
    ok: true,
    text: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')) }, { once: true })
    }),
  }), async () => {
    await assert.rejects(() => createHaierClient({ ...ENV, HAIER_POSITION_ID: '', HAIER_TIMEOUT_MS: '5' }).fetchStatus(), /HAIER timeout/)
    assert.equal(aborted, 3)
  })
})

test('部分楼层查询失败不能当作完整新快照返回', async () => {
  await withFetch((url, init) => {
    if (String(url).includes('floorCodeList')) return jsonRes({ code: 0, data: ['1', '2'] })
    if (String(url).includes('deviceDetailPage') && JSON.parse(init.body).floorCode === '2') return jsonRes({}, 404)
    return jsonRes({ code: 0, data: statusData(url, init) })
  }, async () => {
    await assert.rejects(() => createHaierClient(ENV).fetchStatus(), /HAIER HTTP 404/)
  })
})

test('分页缺少 total 仍读取后续页，并限制组合并发', async () => {
  let active = 0
  let peak = 0
  const pages = []
  await withFetch(async (url, init) => {
    if (String(url).includes('floorCodeList')) return jsonRes({ code: 0, data: ['1', '2', '3', '4', '5', '6'] })
    if (String(url).includes('positionDevice')) return jsonRes({ code: 0, data: [{ categoryCode: '00', total: 20 }] })
    const { page, floorCode } = JSON.parse(init.body)
    pages.push([floorCode, page])
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active--
    return jsonRes({ code: 0, data: { items: Array.from({ length: page === 1 ? 2 : 1 }, (_, i) => ({ deviceId: `${floorCode}-${page}-${i}`, floorCode, state: 1 })) } })
  }, async () => {
    const list = await createHaierClient({ ...ENV, HAIER_PAGE_SIZE: '2' }).fetchStatus()
    assert.equal(list.length, 18)
    assert.equal(pages.length, 12)
    assert.ok(peak > 1 && peak <= 4)
  })
})

test('设备分页结构异常不能被当作空楼层', async () => {
  await withFetch((url, init) => jsonRes({ code: 0, data: String(url).includes('deviceDetailPage') ? {} : statusData(url, init) }), async () => {
    await assert.rejects(() => createHaierClient(ENV).fetchStatus(), /HAIER invalid device page/)
  })
})

test('diagnoseHaier 在非 real 模式下不出网', async () => {
  await withFetch(
    () => {
      throw new Error('不该被调用')
    },
    async (count) => {
      const out = await diagnoseHaier({ HAIER_MODE: 'mock' })
      assert.equal(out.mode, 'mock')
      assert.equal(count(), 0)
    }
  )
})
