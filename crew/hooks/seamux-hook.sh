#!/usr/bin/env bash
# crew — the Claude Code hook entry point, on seamux.
#
#   seamux-hook.sh <session|pretool|ask|answered|task|notification|stop|end>
#
# The same events as crew-hook.sh, with the work done by `seamux crew-hook`.
# Only pretool's hot path stays here: it fires on every tool use, and almost
# always there is no lane override to release, so a missing marker has to
# exit from bash without starting a binary (crew-hook.sh explains the cost).
#
# seamux is $SEAMUX_BIN, else the link install.sh makes in ~/.local/bin.
# Without it every event is a no-op: exit 0, nothing printed, nothing sent.

set -u

event="${1:-}"
seamux="${SEAMUX_BIN:-$HOME/.local/bin/seamux}"
[ -x "$seamux" ] || exit 0

if [ "$event" = "pretool" ]; then
  _m="${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew/lane-${CMUX_WORKSPACE_ID:-none}"
  [ -f "$_m" ] || exit 0
  [ -f "${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew/disabled" ] && exit 0
  # AskUserQuestion also fires the `ask` hook, in parallel with this one, and
  # that is no resumed work. A builtin read and match, so no fork.
  IFS= read -r -d '' _p || true
  [[ ${_p:-} =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"AskUserQuestion\" ]] && exit 0
  exec "$seamux" crew-hook pretool </dev/null
fi

exec "$seamux" crew-hook "$event"
