#!/bin/bash
# deep-plan family news — UserPromptSubmit and SessionStart. A family member's
# session is told, as context, what changed in its family since it last
# looked; everyone else pays one bash glob and no interpreter. It also marks a
# human prompt for the gate's same-turn go rule (below).
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
# The human spoke: the gate's refusal in the last turn (turns/<session>.denied,
# written by decide.mjs) is answered, so a `deep-plan go` may run again. The
# prompt's first 300 characters are kept beside it (turns/<session>.prompt):
# when the gate refuses an edit later in the same turn, a go that this prompt
# plainly asked for still goes through (decide.mjs). A SessionStart is no human
# turn (a compaction fires one mid-turn). Paid only while some plan is
# tracked: one glob otherwise, and no interpreter either way.
payload=""; read_payload=""
set -- "$STATE_DIR"/*.json
if [ -e "$1" ]; then
  payload=$(cat); read_payload=1
  ev=""; sid=""; prompt=""
  re_ev='"hook_event_name"[[:space:]]*:[[:space:]]*"([A-Za-z]+)"'
  re_sid='"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9_-]+)"'
  # Only the head of the payload is scanned: a prompt can be long, and only its
  # first 300 characters are kept. Claude Code writes compact JSON.
  head=${payload:0:16384}
  [[ $head =~ $re_ev ]] && ev=${BASH_REMATCH[1]}
  [[ $head =~ $re_sid ]] && sid=${BASH_REMATCH[1]}
  if [ "$ev" != SessionStart ] && [ -n "$sid" ]; then
    rm -f "$STATE_DIR/turns/$sid.denied"
    case $head in *'"prompt":"'*) prompt=${head#*\"prompt\":\"} ;; *'"prompt": "'*) prompt=${head#*\"prompt\": \"} ;; esac
    prompt=${prompt:0:300}; prompt=${prompt%%\"[,\}]*}; prompt=${prompt//\\n/ }; prompt=${prompt//\\t/ }
    mkdir -p "$STATE_DIR/turns" 2>/dev/null && printf '%s\n' "$prompt" > "$STATE_DIR/turns/$sid.prompt" 2>/dev/null
  fi
fi
set -- "$STATE_DIR"/families/*/index.json
[ -e "$1" ] || exit 0
if [ -n "${DEEP_PLAN_SKILL_DIR:-}" ]; then HOOKS="$DEEP_PLAN_SKILL_DIR/hooks"
else case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
fi
[ -n "$read_payload" ] && exec node "$HOOKS/news.mjs" <<<"$payload"
exec node "$HOOKS/news.mjs"
