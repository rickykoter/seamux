// The checkout page in a real browser: the cart shows, and so does what the
// customer pays. deep-plan's browser checks run this (verify.json).
await step('open checkout', async () => {
  await page.goto(env.BASE_URL)
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible()
})
await step('the cart and its total', async () => {
  await expect(page.locator('#items li')).toHaveCount(2)
  await expect(page.locator('#total')).toHaveText('$32.40')
})
