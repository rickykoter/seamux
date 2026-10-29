import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkout } from '../src/checkout/route.js'

test('checkout returns a total', async () => {
  const r = await checkout({ body: { items: [{ price: 500, qty: 1 }] } })
  assert.equal(r.status, 200)
})
