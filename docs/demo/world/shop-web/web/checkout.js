// The checkout page: the cart and what the customer pays.
import { total } from '../src/checkout/total.js'

const cart = [
  { name: 'Mug', price: 1200, qty: 1 },
  { name: 'Tea, 50 bags', price: 900, qty: 2 },
]
const money = (cents) => `$${(cents / 100).toFixed(2)}`

document.getElementById('items').innerHTML = cart
  .map((it) => `<li><span>${it.name} × ${it.qty}</span><span>${money(it.price * it.qty)}</span></li>`)
  .join('')
document.getElementById('total').textContent = money(total(cart))
