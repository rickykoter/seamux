#!/bin/bash
# plan-map-setup — a plan's End state map for the lookout video. Run after
# setup.sh and deep-dive-setup.sh, before the take builds anything:
#
#   bash docs/demo/live/plan-map-setup.sh [ROOT]
#
# Builds the map with deep-plan's own builder (deep-plan/lib/map.mjs, the one
# render uses) from docs/demo/world/coupons-plan.spec.json, against the shop
# as it stands on main, and writes ~/.claude/plans/coupons.map.json in the
# demo HOME. The take opens its review with --plan-map, so lookout's Map view
# holds that plan against what the agent builds. The spec plans one file the
# build prompt never asks for (test/admin.test.js), and the map shows it.
set -eu
ROOT=${1:-/private/tmp/seamux-demo}
H=$ROOT/home
CHECKOUT=$(cd "$(dirname "$0")/../../.." && pwd)
SHOP=$H/code/shop
[ -d "$SHOP" ] || { echo "plan-map-setup: run setup.sh first" >&2; exit 2; }
mkdir -p "$H/.claude/plans"
OUT=$H/.claude/plans/coupons.map.json
NODE=$(node -p process.execPath)
HOME=$H "$NODE" --input-type=module -e "
import fs from 'node:fs';
import { buildMap } from '$CHECKOUT/deep-plan/lib/map.mjs';
const spec = JSON.parse(fs.readFileSync('$CHECKOUT/docs/demo/world/coupons-plan.spec.json', 'utf8'));
fs.writeFileSync('$OUT', JSON.stringify(buildMap(spec, '$SHOP'), null, 1));
"
echo "plan-map-setup: $OUT"
