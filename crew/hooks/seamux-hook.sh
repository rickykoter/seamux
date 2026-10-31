#!/usr/bin/env bash
# crew — the Claude Code hook entry point, on seamux.
#
#   seamux-hook.sh <session|pretool|ask|answered|task|notification|stop|end>
#
# The same events as crew-hook.sh, with the work done by `seamux crew-hook`.
# Only pretool's hot path stays here: it fires on every tool use, and almost
# always this pane holds nothing to release, so it has to exit from bash
# without starting a binary (crew-hook.sh explains the cost). A pane with a
# state file is tested by its hold-<surface> marker, which crew-core's status
# keeps while the pane waits, was asked or left work to review: another
# pane's wait in the same workspace never sends this one to the binary.
# A pane without one (state from before pane files) falls back to the
# workspace's lane-<ws> marker.
#
# seamux is $SEAMUX_BIN, else ~/.local/bin/seamux, where the family's
# install is to link it (the cutover makes the link before it points
# hooks.json here).
# Without it every event is a no-op: exit 0, nothing printed, nothing sent.

set -u

event="${1:-}"
seamux="${SEAMUX_BIN:-$HOME/.local/bin/seamux}"
[ -x "$seamux" ] || exit 0

if [ "$event" = "pretool" ]; then
  _d="${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew"
  # The pane and workspace as crew_core::ident reads them: a backend's
  # SEAMUX_* first, then a plain cmux pane's CMUX_*.
  _w="${SEAMUX_WORKSPACE_ID:-${CMUX_WORKSPACE_ID:-none}}"
  _k="${SEAMUX_PANE_ID:-${CMUX_SURFACE_ID:-$_w}}"
  if [ -f "$_d/pane-$_k.json" ]; then
    [ -f "$_d/hold-$_k" ] || exit 0
  else
    [ -f "$_d/lane-$_w" ] || exit 0
  fi
  [ -f "$_d/disabled" ] && exit 0
  # AskUserQuestion also fires the `ask` hook, in parallel with this one, and
  # that is no resumed work. A builtin read and match, so no fork.
  IFS= read -r -d '' _p || true
  [[ ${_p:-} =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"AskUserQuestion\" ]] && exit 0
  exec "$seamux" crew-hook pretool </dev/null
fi

exec "$seamux" crew-hook "$event"
