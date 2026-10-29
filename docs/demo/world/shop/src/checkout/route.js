// POST /checkout: takes a cart, returns what the customer pays.
import { total } from './total.js'

export async function checkout(req) {
  const { items } = req.body
  if (!Array.isArray(items) || items.length === 0) {
    return { status: 400, body: { error: 'empty cart' } }
  }
  return { status: 200, body: { total: total(items) } }
}
