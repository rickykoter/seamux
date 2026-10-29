import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/checkout/total.js'

test('total adds tax', () => {
  assert.equal(total([{ price: 1000, qty: 2 }]), 2160)
})
