#!/bin/bash
# deep-plan gate — PreToolUse on Edit|Write|MultiEdit|NotebookEdit|Bash.
# Exit 2 + stderr blocks the call; anything else allows. The stderr of a
# denial opens `deep-plan gate [<slug>]: ` (written by decide.mjs), which the
# seamux-mods band matches on; probe.mjs holds that shape.
#
# The hot path: this fires on every tool call, almost always with no plan
# tracked. The glob test answers that case before any interpreter starts
# (~6ms bash vs ~52ms node, measured in ADAPTING.md; re-measured here by
# probe.mjs). The real decision lives in lib/state.mjs — one definition of
# "may I edit", shared with the CLI.
# On the remote host state lives in the repo (<git root>/.seamux/state), the
# rule lib/host.mjs states: SEAMUX_HOST wins, then cmux, then
# CLAUDE_CODE_REMOTE=true. Only that host pays for the git call.
seamux_data_root() {
  h=""
  # Lowercased and trimmed, as host.mjs reads it; a subprocess only when set.
  [ -n "${SEAMUX_HOST:-}" ] && h=$(printf '%s' "$SEAMUX_HOST" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case "$h" in
    remote) ;;
    cmux|desktop|terminal) return 1 ;;
    *) [ -z "${CMUX_WORKSPACE_ID:-}" ] && [ "${CLAUDE_CODE_REMOTE:-}" = true ] || return 1 ;;
  esac
  # The main checkout (the shared .git's parent), as host.mjs finds it.
  g=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  case "$g" in */.git) top=${g%/.git} ;; *) top=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || return 1 ;; esac
  [ -n "$top" ] && printf '%s/.seamux/state' "$top"
}
DATA="$(seamux_data_root)" || DATA="$HOME/.claude"
STATE_DIR="${DEEP_PLAN_STATE_DIR:-$DATA/deep-plan/state}"
set -- "$STATE_DIR"/*.json
[ -e "$1" ] || exit 0
# decide.mjs sits beside this file wherever the plugin is installed; hooks.json
# calls it by absolute path, so no dirname subprocess is needed. The override is
# for the probe and for extensions that want another copy's decision.
if [ -n "${DEEP_PLAN_SKILL_DIR:-}" ]; then HOOKS="$DEEP_PLAN_SKILL_DIR/hooks"
else case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
fi
exec node "$HOOKS/decide.mjs"
