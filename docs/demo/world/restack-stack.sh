#!/bin/bash
# restack-stack — a two-branch stack whose base moved, for the restack scene.
#
#   bash docs/demo/world/restack-stack.sh DIR      (DIR/shop must not exist)
#
# main gains a route and a new tax rate after the stack was cut. The stack
# (coupons-api, then coupons-email on top) adds routes too, so the generated
# route table src/routes.gen.json conflicts on both branches: restack
# regenerates it. coupons-api also changed the tax rate, which is a conflict a
# person has to settle, so the walk stops there once.
set -eu
DIR=${1:?usage: restack-stack.sh DIR}
mkdir -p "$DIR" && cd "$DIR"
git init -q --bare -b main remote.git
git init -q -b main shop && cd shop
git config user.name "Sam Rivera"; git config user.email sam@shop.example
mkdir -p src/routes scripts .seamux
cat > scripts/gen-routes.mjs <<'EOF'
// Writes src/routes.gen.json: one entry per file in src/routes, sorted.
import { readdirSync, writeFileSync } from 'node:fs'
const routes = readdirSync('src/routes').filter((f) => f.endsWith('.js')).sort()
  .map((f) => ({ path: '/' + f.replace(/\.js$/, ''), handler: `src/routes/${f}` }))
writeFileSync('src/routes.gen.json', JSON.stringify({ generated: 'node scripts/gen-routes.mjs', routes }, null, 2) + '\n')
EOF
cat > .seamux/restack.json <<'EOF'
{ "base": "origin/main", "remote": "origin", "rerere": false, "stack": { "tool": "auto" },
  "artifacts": [
    { "name": "route-table", "paths": ["src/routes.gen.json"], "resolve": "regen", "tier": "cheap",
      "regen": "node scripts/gen-routes.mjs", "breaks": "CI regenerates it and fails on any diff" } ] }
EOF
printf 'export const TAX_RATE = 0.08\n' > src/tax.js
printf 'export default () => "cart"\n' > src/routes/cart.js
node scripts/gen-routes.mjs
git add -A && git commit -qm "shop: cart route, route table" && git remote add origin ../remote.git && git push -q origin main

git checkout -qb coupons-api
printf 'export default () => "coupon"\n' > src/routes/coupon.js
printf 'export const TAX_RATE = 0.085 // coupons are taxed after the discount\n' > src/tax.js
node scripts/gen-routes.mjs
git add -A && git commit -qm "coupons: POST /coupon, tax after discount"

git checkout -qb coupons-email
printf 'export default () => "receipt"\n' > src/routes/receipt.js
node scripts/gen-routes.mjs
git add -A && git commit -qm "coupons: receipt email shows the code"

git checkout -q main
printf 'export default () => "wishlist"\n' > src/routes/wishlist.js
printf 'export const TAX_RATE = 0.0825 // the state rate went up\n' > src/tax.js
node scripts/gen-routes.mjs
git add -A && git commit -qm "wishlist route; state tax 8.25%" && git push -q origin main
git reset -q --hard HEAD~1   # the local main is behind, as after a while away
git checkout -q coupons-email
