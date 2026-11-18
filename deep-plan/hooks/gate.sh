#!/bin/bash
# deep-plan gate — PreToolUse on Edit|Write|MultiEdit|NotebookEdit|Bash, and
# on Read|Grep|Glob for the sealed scenarios alone (lib/scenarios.mjs).
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
    cmux|seamux|desktop|terminal) return 1 ;;
    *)
      # cmux (a CMUX_WORKSPACE_ID a tmux-backend pane did not inherit), then
      # the seamux app's tmux, come before remote, as in host.mjs.
      [ -n "${CMUX_WORKSPACE_ID:-}" ] && [ "${SEAMUX_BACKEND:-}" != tmux ] && return 1
      [ -n "${SEAMUX_PANE_ID:-}" ] && return 1
      [ "${CLAUDE_CODE_REMOTE:-}" = true ] || return 1 ;;
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
# A plan is tracked: the payload is read once (cat reads a pipe in blocks,
# where the read builtin takes it a byte at a time). A read is only the
# sealed folder's business, and one whose input names nothing near it (no
# "sealed", no .claude, no .seamux) is allowed here without node. Only the
# text after "tool_input" is looked at, since every payload's transcript_path
# names ~/.claude; a payload ordered otherwise only costs the node path.
PAYLOAD=$(cat)
case "$PAYLOAD" in
  *'"tool_name":"Read"'*|*'"tool_name":"Grep"'*|*'"tool_name":"Glob"'*|*'"tool_name": "Read"'*|*'"tool_name": "Grep"'*|*'"tool_name": "Glob"'*)
    INPUT=${PAYLOAD#*\"tool_input\"}
    NEAR=no
    case "$INPUT$PWD" in *sealed*|*.claude*|*.seamux*) NEAR=yes ;; esac
    if [ -n "${DEEP_PLAN_SEALED_DIR:-}" ]; then case "$INPUT" in *"${DEEP_PLAN_SEALED_DIR##*/}"*) NEAR=yes ;; esac; fi
    [ "$NEAR" = yes ] || exit 0 ;;
esac
# decide.mjs sits beside this file wherever the plugin is installed; hooks.json
# calls it by absolute path, so no dirname subprocess is needed. The override is
# for the probe and for extensions that want another copy's decision.
if [ -n "${DEEP_PLAN_SKILL_DIR:-}" ]; then HOOKS="$DEEP_PLAN_SKILL_DIR/hooks"
else case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
fi
exec node "$HOOKS/decide.mjs" <<<"$PAYLOAD"
