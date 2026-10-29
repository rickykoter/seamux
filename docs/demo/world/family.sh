#!/bin/bash
# family — a deep-plan family in a demo world, for the families scene.
#
#   bash docs/demo/world/family.sh WORLD      (a folder stage.sh made)
#
# Like deep-plan/tools/family-fixture.sh, but in the world's own state (its
# env.sh) and with increment titles that fit the sign-in story: the parent
# example-auth-revamp lands a shared session type, example-auth-api owns
# api/auth/** and takes its go from the parent agent, example-auth-ui owns
# web/login/** and takes its go from a person.
set -eu
WORLD=${1:?usage: family.sh WORLD}
# shellcheck disable=SC1091
source "$WORLD/env.sh"
SHOP=$WORLD/shop
(cd "$SHOP" && git worktree add -q -b api ../shop.worktrees/api && git worktree add -q -b ui ../shop.worktrees/ui)

python3 - "$WORLD" "$SEAMUX/deep-plan" <<'EOF'
import json, sys
world, engine = sys.argv[1:]
base = json.load(open(f"{engine}/examples/example.spec.json"))
kids = {
  "example-auth-api": ("Serve sign-in from server sessions", "api/auth/session.ts",
                       ["POST /session", "Session expiry"]),
  "example-auth-ui": ("Sign in through the new session API", "web/login/form.tsx",
                      ["Login form posts to /session", "Signed-out banner"]),
}
for slug, (title, f, incs) in kids.items():
    s = json.loads(json.dumps(base))
    s["slug"], s["title"] = slug, title
    s["context"] = f"{title}. Part of the example-auth-revamp family."
    s["deliverables"][0].update(title=incs[0], body=incs[0] + ".", files=[f])
    s["deliverables"][1].update(title=incs[1], body=incs[1] + ".", files=[])
    json.dump(s, open(f"{world}/{slug}.spec.json", "w"))
fam = json.load(open(f"{engine}/examples/example.family.spec.json"))
for w in fam["workstreams"]:
    if w["slug"] == "example-auth-api":
        w["go"] = "parent"
json.dump(fam, open(f"{world}/example-auth-revamp.spec.json", "w"))
EOF

dp() { node "$SEAMUX/deep-plan/deep_plan.mjs" "$@"; }
dp render "$WORLD/example-auth-api.spec.json" --root "$WORLD/shop.worktrees/api" >/dev/null 2>&1
dp render "$WORLD/example-auth-ui.spec.json" --root "$WORLD/shop.worktrees/ui" >/dev/null 2>&1
dp render "$WORLD/example-auth-revamp.spec.json" --root "$SHOP" 2>&1 | grep '^family' >&2
