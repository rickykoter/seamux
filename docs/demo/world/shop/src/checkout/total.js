// Order totals, in cents.
export const TAX_RATE = 0.08

export function subtotal(items) {
  return items.reduce((sum, it) => sum + it.price * it.qty, 0)
}

export function total(items, { discount = 0 } = {}) {
  const net = Math.max(0, subtotal(items) - discount)
  return Math.round(net * (1 + TAX_RATE))
}
