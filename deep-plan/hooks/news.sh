#!/bin/bash
# deep-plan family news — UserPromptSubmit and SessionStart. A family member's
# session is told, as context, what changed in its family since it last
# looked; everyone else pays one bash glob and no interpreter.
STATE_DIR="${DEEP_PLAN_STATE_DIR:-$HOME/.claude/deep-plan/state}"
set -- "$STATE_DIR"/families/*/index.json
[ -e "$1" ] || exit 0
if [ -n "${DEEP_PLAN_SKILL_DIR:-}" ]; then HOOKS="$DEEP_PLAN_SKILL_DIR/hooks"
else case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
fi
exec node "$HOOKS/news.mjs"
