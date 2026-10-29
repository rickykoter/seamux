#!/bin/bash
# stage — build the throwaway world the demo media is recorded against.
#
#   bash docs/demo/stage.sh DIR          build DIR, print `source DIR/env.sh`
#   source DIR/env.sh                    then dp / lk / rs run on it
#
# DIR/shop is a git repo made from docs/demo/world/shop, with a bare remote at
# DIR/remote.git. Every deep-plan, lookout and restack path (state, keys, plans,
# reviews, the engine pointers, the page servers) lives under DIR, and
# SEAMUX_HOST=terminal makes each plugin serve its own page on 127.0.0.1, so
# nothing reads or writes your real plans, reviews or cmux.
set -eu
DIR=${1:?usage: stage.sh DIR}
SEAMUX=$(cd "$(dirname "$0")/../.." && pwd)
WORLD=$SEAMUX/docs/demo/world
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd -P)
[ -e "$DIR/shop" ] && { echo "stage: $DIR/shop exists; use an empty folder" >&2; exit 2; }

cat > "$DIR/env.sh" <<EOF
# The demo world's environment. Sourced by record.mjs and by hook wrappers.
export DEMO=$DIR SEAMUX=$SEAMUX
export SEAMUX_HOST=terminal
unset CMUX_WORKSPACE_ID CMUX_SURFACE_ID CMUX_SOCKET_PATH CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID
export DEEP_PLAN_STATE_DIR=$DIR/dp/state DEEP_PLAN_KEYS_DIR=$DIR/dp/keys DEEP_PLAN_PLANS_DIR=$DIR/dp/plans
export DEEP_PLAN_ENGINE_FILE=$DIR/dp/engine.json DEEP_PLAN_BIN_DIR=$DIR/bin DEEP_PLAN_SERVE_FILE=$DIR/dp/serve.json
export DEEP_PLAN_SKILL_DIR=$SEAMUX/deep-plan DEEP_PLAN_ENGINE=$SEAMUX/deep-plan
export DEEP_PLAN_VENDOR_DIR=\${DEEP_PLAN_VENDOR_DIR:-\$HOME/.claude/deep-plan/vendor}
export DEEP_PLAN_TYPESAFE_CLIENT= DEEP_PLAN_OPENER=true
export LOOKOUT_REVIEWS_DIR=$DIR/lk/reviews LOOKOUT_ENGINE_FILE=$DIR/lk/engine.json LOOKOUT_BIN_DIR=$DIR/bin
export LOOKOUT_SERVE_FILE=$DIR/lk/serve.json LOOKOUT_TYPESAFE_CLIENT=
export LOOKOUT_VENDOR_DIR=\${LOOKOUT_VENDOR_DIR:-\$HOME/.claude/lookout/vendor}
export RESTACK_ENGINE_FILE=$DIR/rs/engine.json RESTACK_BIN_DIR=$DIR/bin RESTACK_TYPESAFE_CLIENT=
export GIT_AUTHOR_NAME="Sam Rivera" GIT_AUTHOR_EMAIL=sam@shop.example
export GIT_COMMITTER_NAME="Sam Rivera" GIT_COMMITTER_EMAIL=sam@shop.example
dp() { node $SEAMUX/deep-plan/deep_plan.mjs "\$@"; }
lk() { node $SEAMUX/lookout/lookout.mjs "\$@"; }
rs() { node $SEAMUX/restack/restack.mjs "\$@"; }
if [ -n "\${BASH_VERSION:-}" ]; then export -f dp lk rs; fi
EOF
# shellcheck disable=SC1091
source "$DIR/env.sh"
mkdir -p "$DIR/dp" "$DIR/lk" "$DIR/rs" "$DIR/bin"

cp -R "$WORLD/shop" "$DIR/shop"
git init -q --bare -b main "$DIR/remote.git"
( cd "$DIR/shop" && git init -q -b main && git add -A && git commit -q -m "shop: cart, totals, checkout" &&
  git remote add origin "$DIR/remote.git" && git push -q origin main 2>/dev/null )

# Hook wrappers: the demo's claude sessions run this checkout's gate and news
# hooks through --settings $DIR/hooks.json, each carrying the world's env.
mkdir -p "$DIR/hooks"
for h in gate news; do
  printf '#!/bin/bash\nsource %s\nexec bash %s/hooks/%s.sh\n' "$DIR/env.sh" "$SEAMUX/deep-plan" "$h" > "$DIR/hooks/$h.sh"
  chmod +x "$DIR/hooks/$h.sh"
done
# The agent's own deep-plan, lookout and restack: the session runs without the
# world's env (see cast.mjs), so these shims put it back for the CLIs alone.
# Without them `deep-plan` on PATH would read your real plans.
mkdir -p "$DIR/agentbin"
for t in deep-plan:deep-plan/deep_plan.mjs lookout:lookout/lookout.mjs restack:restack/restack.mjs; do
  printf '#!/bin/bash\nsource %s\nexec node %s/%s "$@"\n' "$DIR/env.sh" "$SEAMUX" "${t#*:}" > "$DIR/agentbin/${t%%:*}"
  chmod +x "$DIR/agentbin/${t%%:*}"
done
cat > "$DIR/hooks.json" <<JSON
{ "hooks": {
  "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
                   "hooks": [{ "type": "command", "command": "$DIR/hooks/gate.sh" }] }],
  "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$DIR/hooks/news.sh" }] }] } }
JSON

echo "source $DIR/env.sh"
