#!/bin/bash
# family-fixture — stage a throwaway deep-plan family in DIR.
#
#   eval "$(bash deep-plan/tools/family-fixture.sh DIR)"
#
# Builds a repo (DIR/shop, the parent's checkout) with two worktrees
# (DIR/shop.worktrees/api and .../ui), renders a child plan in each
# (example-auth-api owns api/auth/**, example-auth-ui owns web/login/**), and
# renders examples/example.family.spec.json as the parent adopting both. All
# plan state lives under DIR; nothing touches your real plans.
#
# Prints shell assignments on stdout, so a caller drives the family with the
# same engine and state: FIX_DIR FIX_PARENT FIX_API FIX_UI FIX_ENV (a file to
# `source` from hook wrappers), plus the DEEP_PLAN_* overrides. Shared by the
# live e2e (live-family.sh), crew's family sync probe, and demo takes that
# want a family on screen.
set -eu
DIR=${1:?usage: family-fixture.sh DIR}
HERE=$(cd "$(dirname "$0")/.." && pwd)          # the deep-plan engine root
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd -P)
G="git -c user.email=fixture@deep-plan -c user.name=fixture"

(cd "$DIR" && mkdir -p shop && cd shop && git init -q && $G commit -q --allow-empty -m init &&
  git worktree add -q -b api ../shop.worktrees/api && git worktree add -q -b ui ../shop.worktrees/ui) >&2

cat > "$DIR/env.sh" <<EOF
export DEEP_PLAN_STATE_DIR=$DIR/state DEEP_PLAN_KEYS_DIR=$DIR/keys DEEP_PLAN_PLANS_DIR=$DIR/plans
export DEEP_PLAN_VENDOR_DIR=\${DEEP_PLAN_VENDOR_DIR:-$HOME/.claude/deep-plan/vendor}
export DEEP_PLAN_SKILL_DIR=$HERE DEEP_PLAN_ENGINE=$HERE
EOF
# shellcheck disable=SC1091
source "$DIR/env.sh"

python3 - "$DIR" "$HERE" <<'EOF'
import json, sys
d, here = sys.argv[1:]
base = json.load(open(f"{here}/examples/example.spec.json"))
for slug, files in [("example-auth-api", ["api/auth/session.ts"]),
                    ("example-auth-ui", ["web/login/form.tsx"])]:
    s = json.loads(json.dumps(base))
    s["slug"] = slug
    s["deliverables"][0]["files"] = files
    s["deliverables"][1]["files"] = []
    json.dump(s, open(f"{d}/{slug}.spec.json", "w"))
EOF

dp() { node "$HERE/deep_plan.mjs" "$@"; }
dp render "$DIR/example-auth-api.spec.json" --root "$DIR/shop.worktrees/api" >/dev/null 2>&1
dp render "$DIR/example-auth-ui.spec.json" --root "$DIR/shop.worktrees/ui" >/dev/null 2>&1
dp render "$HERE/examples/example.family.spec.json" --root "$DIR/shop" 2>&1 | grep '^family' >&2

cat <<EOF
export FIX_DIR=$DIR FIX_PARENT=$DIR/shop FIX_API=$DIR/shop.worktrees/api FIX_UI=$DIR/shop.worktrees/ui
export FIX_ENV=$DIR/env.sh
source $DIR/env.sh
EOF
