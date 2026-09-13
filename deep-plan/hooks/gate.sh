#!/bin/bash
# deep-plan gate — PreToolUse on Edit|Write|MultiEdit|NotebookEdit|Bash.
# Exit 2 + stderr blocks the call; anything else allows.
#
# The hot path: this fires on every tool call, almost always with no plan
# tracked. The glob test answers that case before any interpreter starts
# (~6ms bash vs ~52ms node, measured in ADAPTING.md; re-measured here by
# probe.mjs). The real decision lives in lib/state.mjs — one definition of
# "may I edit", shared with the CLI.
STATE_DIR="${DEEP_PLAN_STATE_DIR:-$HOME/.claude/deep-plan/state}"
set -- "$STATE_DIR"/*.json
[ -e "$1" ] || exit 0
exec node "${DEEP_PLAN_SKILL_DIR:-$HOME/.claude/skills/deep-plan}/hooks/decide.mjs"
