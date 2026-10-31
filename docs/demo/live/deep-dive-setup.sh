#!/bin/bash
# deep-dive-setup — the shop for the deep-plan and lookout videos. Run after
# setup.sh:
#
#   bash docs/demo/live/deep-dive-setup.sh [ROOT]
#
# Lays docs/demo/world/shop-web over ~/code/shop and commits it: a checkout
# page, a small static server, a browser-check script, and a verify.json with
# three recipes (lint, unit tests, a browser check of the checkout page).
#
# Browser checks run outside cmux through Playwright and headless Chromium,
# when `playwright` resolves from the repo. The shop gets a one-line
# `playwright` that loads the reel's playwright-core (docs/demo/reel, `npm
# install` there first), and the demo HOME uses your Playwright browser cache,
# so nothing is downloaded.
set -eu
ROOT=${1:-/private/tmp/seamux-demo}
H=$ROOT/home
SHOP=$H/code/shop
CHECKOUT=$(cd "$(dirname "$0")/../../.." && pwd)
CORE=$CHECKOUT/docs/demo/reel/node_modules/playwright-core
[ -d "$SHOP" ] || { echo "deep-dive-setup: run setup.sh first" >&2; exit 2; }
[ -d "$CORE" ] || { echo "deep-dive-setup: no $CORE (cd docs/demo/reel && npm install)" >&2; exit 2; }

rsync -a "$CHECKOUT/docs/demo/world/shop-web/" "$SHOP/"
( cd "$SHOP" && HOME=$H git add -A && HOME=$H git commit -q -m "shop: a checkout page, and recipes for its checks" && HOME=$H git push -q origin main )

mkdir -p "$SHOP/node_modules/playwright"
printf '{ "name": "playwright", "version": "0.0.0-demo", "main": "index.js" }\n' > "$SHOP/node_modules/playwright/package.json"
printf "module.exports = require(%s)\n" "\"$CORE\"" > "$SHOP/node_modules/playwright/index.js"
grep -q PLAYWRIGHT_BROWSERS_PATH "$H/.zshenv" ||
  echo "export PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright" >> "$H/.zshenv"
echo "deep-dive-setup: the shop has a checkout page and three recipes"
