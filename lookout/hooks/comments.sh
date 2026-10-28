#!/bin/bash
# lookout comments — UserPromptSubmit and SessionStart. A session whose cwd
# is inside a review's repository is told, as context, what the human said on
# that review's page since it last looked; a machine with no reviews pays one
# bash glob and no interpreter.
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
REVIEWS="${LOOKOUT_REVIEWS_DIR:-$DATA/plans/reviews}"
set -- "$REVIEWS"/*.json
[ -e "$1" ] || exit 0
case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
exec node "$HOOKS/comments.mjs"
