#!/bin/bash
# deep-plan family news — UserPromptSubmit and SessionStart. A family member's
# session is told, as context, what changed in its family since it last
# looked; everyone else pays one bash glob and no interpreter.
# On the remote host state lives in the repo (<git root>/.seamux/state), the
# rule lib/host.mjs states: SEAMUX_HOST wins, then cmux, then
# CLAUDE_CODE_REMOTE=true. Only that host pays for the git call.
seamux_data_root() {
  case "${SEAMUX_HOST:-}" in
    remote) ;;
    cmux|desktop|terminal) return 1 ;;
    *) [ -z "${CMUX_WORKSPACE_ID:-}" ] && [ "${CLAUDE_CODE_REMOTE:-}" = true ] || return 1 ;;
  esac
  top=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ -n "$top" ] && printf '%s/.seamux/state' "$top"
}
DATA="$(seamux_data_root)" || DATA="$HOME/.claude"
STATE_DIR="${DEEP_PLAN_STATE_DIR:-$DATA/deep-plan/state}"
set -- "$STATE_DIR"/families/*/index.json
[ -e "$1" ] || exit 0
if [ -n "${DEEP_PLAN_SKILL_DIR:-}" ]; then HOOKS="$DEEP_PLAN_SKILL_DIR/hooks"
else case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
fi
exec node "$HOOKS/news.mjs"
