#!/usr/bin/env bash
# crew — the Claude Code hook entry point, on seamux.
#
#   seamux-hook.sh <session|pretool|posttool|ask|answered|task|notification|stop|stopfail|subagentstart|subagentstop|permreq|permdenied|end>
#
# subagentstart and subagentstop are SubagentStart and SubagentStop: they keep
# a pane's list of background sub-agents and workflows (crew_core::status).
# permreq and permdenied are PermissionRequest and PermissionDenied: a
# background agent stopped on a permission prompt, and its answer.
#
# stopfail is StopFailure for a usage limit (rate_limit, billing_error) or
# another API error: it has no bash copy, and goes straight to the binary
# like the rest.
#
# The same events as the retired crew-hook.sh, with the work done by
# `seamux crew-hook`.
# Only pretool's hot path stays here: it fires on every tool use, and almost
# always this pane holds nothing to release, so it has to exit from bash
# without starting a binary (the retired crew-hook.sh explained the cost). A pane with a
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

# Every tool use marks the pane's activity, from bash with no fork: pretool
# touches act-<pane> as a tool starts, posttool touches done-<pane> as it
# ends. crew_core::status reads their times: a tool in flight (act newer than
# done) is busy, not silent, however long it runs; a working pane with no
# tool in flight and nothing for a while may be hung.
if [ "$event" = "posttool" ]; then
  _d="${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew"
  _w="${SEAMUX_WORKSPACE_ID:-${CMUX_WORKSPACE_ID:-none}}"
  _k="${SEAMUX_PANE_ID:-${CMUX_SURFACE_ID:-$_w}}"
  [ -d "$_d" ] && : > "$_d/done-$_k" 2>/dev/null
  exit 0
fi

if [ "$event" = "pretool" ]; then
  _d="${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew"
  # The pane and workspace as crew_core::ident reads them: a backend's
  # SEAMUX_* first, then a plain cmux pane's CMUX_*.
  _w="${SEAMUX_WORKSPACE_ID:-${CMUX_WORKSPACE_ID:-none}}"
  _k="${SEAMUX_PANE_ID:-${CMUX_SURFACE_ID:-$_w}}"
  [ -d "$_d" ] && : > "$_d/act-$_k" 2>/dev/null
  # bgonly-<pane>: only background work keeps the pane working, and the
  # main agent's first tool use in a turn a background finish started is
  # what ends that. A sub-agent's tool use passes on unless something holds.
  _bg=0
  [ -f "$_d/bgonly-$_k" ] && _bg=1
  if [ -f "$_d/pane-$_k.json" ]; then
    [ -f "$_d/hold-$_k" ] || [ "$_bg" = 1 ] || exit 0
  else
    [ -f "$_d/lane-$_w" ] || exit 0
  fi
  [ -f "$_d/disabled" ] && exit 0
  # AskUserQuestion also fires the `ask` hook, in parallel with this one, and
  # that is no resumed work. A builtin read and match, so no fork.
  IFS= read -r -d '' _p || true
  [[ ${_p:-} =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"AskUserQuestion\" ]] && exit 0
  # A subagent's tool use (Claude Code sends a top-level agent_id only from
  # inside one) is not the main agent taking its question back. The text can
  # also sit inside tool_input, so the binary reads the JSON to tell.
  # Claude Code writes a sub-agent's top-level agent_id before tool_input,
  # so only the part before it is read: the main agent's tool input may
  # mention agent_id too.
  _head=${_p%%\"tool_input\"*}
  if [[ ${_head:-} == *'"agent_id"'* ]]; then
    [ -f "$_d/hold-$_k" ] || exit 0
    exec "$seamux" crew-hook pretool <<<"$_p"
  fi
  exec "$seamux" crew-hook pretool </dev/null
fi

exec "$seamux" crew-hook "$event"
