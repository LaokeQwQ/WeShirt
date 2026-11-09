import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirectBoardClient } from '../frontend/src/haierDirect.js'

test('optional direct client retains the authoritative query category for an unnamed dryer', async () => {
  const result = data => new Response(JSON.stringify({ code: 0, data }))
  const client = createDirectBoardClient({
    getInfo: async () => ({ base: 'https://upstream.example.test', positionId: 'fixture' }),
    fetchImpl: async (url) => {
      if (url.includes('floorCodeList')) return result(['1'])
      if (url.includes('positionDevice')) return result([{ categoryCode: '02', total: 1 }])
      return result({ total: 1, items: [{ id: 'alias', name: 'Alias fixture', state: 2 }] })
    },
  })
  const machine = (await client.fetchBoardDirect()).board.floors[0].machines[0]
  assert.equal(machine.categoryCode, '02')
  assert.equal(machine.kind, 'dryer')
})
