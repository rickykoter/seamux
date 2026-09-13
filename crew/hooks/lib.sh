#!/usr/bin/env bash
# crew — shared helpers for the Claude Code -> cmux hooks.
#
# Sourced by every hook. Must be cheap: some callers run on PreToolUse, which
# fires thousands of times a session. Nothing here spawns a subprocess until a
# hook explicitly asks for it.

# --- cmux binary -------------------------------------------------------------
# `cmux` on PATH is a per-session shim under $TMPDIR that disappears between
# app launches, so fall back to the app bundle.
if [ -z "${CREW_CMUX:-}" ]; then
  if command -v cmux >/dev/null 2>&1; then
    CREW_CMUX="$(command -v cmux)"
  elif CREW_CMUX="$(ls -dt /Applications/cmux*.app/Contents/Resources/bin/cmux 2>/dev/null | head -1)" \
       && [ -x "$CREW_CMUX" ]; then
    : # newest bundle by mtime, so an upgrade wins and a stale bundle does not
  else
    CREW_CMUX=""
  fi
fi

CREW_STATE="${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew"

# Every hook calls this first. Outside cmux, or with crew disabled, hooks are
# no-ops that never touch the agent.
crew_guard() {
  [ -n "$CREW_CMUX" ] || exit 0
  [ -n "${CMUX_WORKSPACE_ID:-}" ] || exit 0
  [ -z "${CREW_DISABLED:-}" ] || exit 0
  [ ! -f "$CREW_STATE/disabled" ] || exit 0
}

# Fire-and-forget cmux call. cmux failures must never fail a Claude turn.
crew_cmux() { "$CREW_CMUX" "$@" >/dev/null 2>&1 || true; }

# --- payload -----------------------------------------------------------------
# Hooks receive JSON on stdin. Read it once; parse only when needed.
crew_read_payload() { CREW_PAYLOAD="$(cat 2>/dev/null || true)"; }

# crew_json <key> — top-level string field, via python3. Not for hot paths.
crew_json() {
  command -v python3 >/dev/null 2>&1 || return 0
  printf '%s' "${CREW_PAYLOAD:-}" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    v = d.get(sys.argv[1], "")
    print(v if isinstance(v, str) else ("" if v is None else str(v)))
except Exception:
    pass' "$1" 2>/dev/null
}

# --- cwd / branch ------------------------------------------------------------
# Cached: crew_json forks python, and several call sites want the same answer.
crew_cwd() {
  if [ -z "${CREW_CWD:-}" ]; then
    CREW_CWD="$(crew_json cwd)"
    [ -n "$CREW_CWD" ] || CREW_CWD="${CMUX_AGENT_LAUNCH_CWD:-$PWD}"
  fi
  printf '%s' "$CREW_CWD"
}

crew_branch() { git -C "$1" branch --show-current 2>/dev/null || true; }

# Did this turn leave something to look at? Dirty tree, or commits the upstream
# hasn't seen. Used to decide whether pinning the `review` lane is honest.
crew_has_unreviewed_work() {
  local dir="$1" ahead
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || return 1
  [ -n "$(git -C "$dir" status --porcelain 2>/dev/null | head -1)" ] && return 0
  ahead="$(git -C "$dir" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
  [ "${ahead:-0}" -gt 0 ]
}

# Human name for this workspace: the branch's ticket if there is one, else the
# directory. Used for notification titles.
crew_label() {
  local cwd branch label
  cwd="$(crew_cwd)"
  branch="$(crew_branch "$cwd")"
  label="$(crew_ticket_label "${branch:-}")"
  [ -n "$label" ] || label="$(basename "$cwd")"
  printf '%s' "$label"
}

# --- ticket parsing ----------------------------------------------------------
# dev/graphql-db-schema-updates-proj-961 -> "PROJ-961 · graphql-db-schema-updates"
# proj-961-graphql-db-schema-updates     -> "PROJ-961 · graphql-db-schema-updates"
# main                                 -> "" (caller falls back to the dir name)
crew_ticket_label() {
  local branch="$1" rest ticket
  rest="${branch#*/}"                                   # drop any "dev/" prefix
  shopt -s nocasematch
  if [[ "$rest" =~ ^(.+)-([a-z]+-[0-9]+)$ ]]; then      # ticket at the end
    ticket="${BASH_REMATCH[2]}"; rest="${BASH_REMATCH[1]}"
  elif [[ "$rest" =~ ^([a-z]+-[0-9]+)-(.+)$ ]]; then    # ticket at the start
    ticket="${BASH_REMATCH[1]}"; rest="${BASH_REMATCH[2]}"
  elif [[ "$rest" =~ ^([a-z]+-[0-9]+)$ ]]; then         # bare ticket branch
    ticket="${BASH_REMATCH[1]}"; rest=""
  else
    shopt -u nocasematch; return 0
  fi
  shopt -u nocasematch
  ticket="$(printf '%s' "$ticket" | tr '[:lower:]' '[:upper:]')"
  printf '%s' "$ticket${rest:+ · $rest}"
}

# Stable color per ticket, so the same ticket looks the same in every window.
# Palette is cmux's own 16 workspace colors.
crew_ticket_color() {
  local key="$1" sum=0 i ch
  local -a palette=(
    "#922B21" "#1565C0" "#6A1B9A" "#AD1457" "#196F3D" "#A04000"
    "#283593" "#006B6B" "#C0392B" "#4A5C18" "#880E4F" "#3E4B5E"
    "#7D6608" "#7B3F00" "#0E6B8C" "#1A5276"
  )
  for (( i = 0; i < ${#key}; i++ )); do
    ch="${key:i:1}"
    sum=$(( (sum * 31 + $(printf '%d' "'$ch")) % 100003 ))
  done
  printf '%s' "${palette[$(( sum % ${#palette[@]} ))]}"
}

# --- lane override bookkeeping ----------------------------------------------
# cmux auto-infers a lane already. crew only overrides it where Claude knows
# something cmux cannot, and drops back to `auto` as soon as work resumes.
#
# The marker lets PreToolUse skip the socket call in the common case: without
# it, releasing the override would cost one round trip per tool use.
crew_lane_marker() { printf '%s/lane-%s' "$CREW_STATE" "${CMUX_WORKSPACE_ID:-none}"; }

crew_lane_set() {
  mkdir -p "$CREW_STATE" 2>/dev/null || true
  crew_cmux workspace status set "$1"
  : > "$(crew_lane_marker)" 2>/dev/null || true
}

# --- publishing the agent phase ----------------------------------------------
# The board needs to know whether an agent is working or blocked, and it cannot
# find out on its own: the custom-sidebar interpreter has no binding for
# agentLifecycle, and `latestAt` is the last *message*, which stands still for
# minutes while Claude thinks. (Observed: a board row reading "1m" beside a
# terminal reading "Inferring… 1m 4s", and turns that cogitate for over an hour.)
#
# `description` IS bindable, so crew mirrors the phase into it. It is also
# visible under the workspace title, which is why the values are written as
# plain English rather than tokens.
#
# Only fired from events that already do socket work — never from the PreToolUse
# hot path.
# Merge ONE token into the description, leaving every other token alone.
#
# The description is shared: crew-sync publishes ci:/review:/jira:/stack:/gone:
# and the hooks publish phase:/feed:. A plain set-description from either side
# wipes the other's work until the next sync, so every writer has to merge.
crew_desc_get() {
  "$CREW_CMUX" workspace list --json 2>/dev/null | python3 -c '
import json, sys
try:
    for w in json.load(sys.stdin).get("workspaces") or []:
        if w.get("id") == sys.argv[1]:
            print(w.get("description") or "")
            break
except Exception:
    pass' "$CMUX_WORKSPACE_ID" 2>/dev/null
}

crew_desc_put() {
  if [ -n "$1" ]; then
    crew_cmux workspace-action --action set-description --description "$1"
  else
    crew_cmux workspace-action --action clear-description
  fi
}

crew_token_set() {   # <key> <value|empty>
  [ -n "${CMUX_WORKSPACE_ID:-}" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  local key="$1" val="${2:-}" cur new
  cur="$(crew_desc_get)"
  new="$(python3 -c '
import sys
cur, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
toks = [t for t in cur.split() if not t.startswith(key + ":")]
if val:
    toks.append(key + ":" + val)
print(" ".join(toks))' "$cur" "$key" "$val" 2>/dev/null)"
  crew_desc_put "$new"
}

# Drop several keys in ONE read-modify-write. Turn end clears five of them, and
# doing that as five crew_token_set calls cost five `workspace list --json`
# round trips plus ten python forks per turn — and each one raced the next, since
# every call re-read a description the previous one had just rewritten.
crew_token_clear() {  # <key>...
  [ -n "${CMUX_WORKSPACE_ID:-}" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  [ "$#" -gt 0 ] || return 0
  local cur new
  cur="$(crew_desc_get)"
  new="$(python3 -c '
import sys
cur, keys = sys.argv[1], sys.argv[2:]
print(" ".join(t for t in cur.split()
                if not any(t.startswith(k + ":") for k in keys)))' "$cur" "$@" 2>/dev/null)"
  # Nothing to do is nothing to write. Every write is a socket round trip and a
  # workspace.action event, and turn end hits this whether or not any of these
  # keys were set -- which for an ordinary turn is always.
  [ "$new" = "$cur" ] && return 0
  crew_desc_put "$new"
}

# The board matches `phase:working` / `phase:waiting`, not bare words.
crew_phase() {
  case "${1:-}" in
    working)          crew_token_set phase working ;;
    "waiting on you") crew_token_set phase waiting ;;
    "")               crew_token_set phase "" ;;
    *)                crew_token_set phase "$1" ;;
  esac
}

# Throttled background reconcile. Hung off turn-end rather than the PreToolUse
# hot path: Stop fires once per turn instead of thousands of times, and because
# crew-sync reconciles *every* workspace, one active agent unsticks all the
# others. Backgrounded so a turn never waits on it.
crew_sync_maybe() {
  local stamp="$CREW_STATE/sync-stamp" now last
  now="$(date +%s)"
  if [ -f "$stamp" ]; then
    last="$(cat "$stamp" 2>/dev/null || echo 0)"
    [ $((now - last)) -ge "${CREW_SYNC_INTERVAL:-120}" ] || return 0
  fi
  mkdir -p "$CREW_STATE" 2>/dev/null || true
  printf '%s' "$now" > "$stamp" 2>/dev/null || true
  local bin; bin="$(dirname "$(dirname "${BASH_SOURCE[0]}")")/bin/crew-sync"
  [ -x "$bin" ] || return 0
  ( nohup "$bin" >/dev/null 2>&1 & ) >/dev/null 2>&1
}

# --- identity colour -----------------------------------------------------------
# Delegates to bin/crew-color rather than hashing here. The hash this file used to
# use (crew_ticket_color) collides: measured, three pairs of currently-open
# worktrees mapped to the same hex, which defeats the whole point of a per-worktree
# colour. crew-color keeps a registry and avoids colours already in use.
#
# Only fills a blank, matching crew-sync's rule. cmux's own picker offers exactly
# crew-color's sixteen, so crew cannot tell its own assignment from one you chose
# by hand -- and overwriting on every session start is precisely what it used to do.
crew_color_ensure() {
  local cwd="$1"
  [ -n "${CREW_CMUX:-}" ] || return 0
  [ -n "${CMUX_WORKSPACE_ID:-}" ] || return 0
  [ -n "$cwd" ] || return 0
  local dir; dir="$(dirname "$(dirname "${BASH_SOURCE[0]}")")"
  local cbin="$dir/bin/crew-color"
  [ -x "$cbin" ] || return 0
  local cur
  cur="$("$CREW_CMUX" sidebar-state --workspace "$CMUX_WORKSPACE_ID" 2>/dev/null \
         | sed -n 's/^color=//p')"
  [ -z "$cur" ] || [ "$cur" = "none" ] || return 0
  local hex; hex="$("$cbin" assign "$cwd" 2>/dev/null || true)"
  case "$hex" in
    \#*) crew_cmux workspace-action --action set-color --color "$hex" ;;
  esac
}

# --- the always-on reconciler --------------------------------------------------
# Spawned from SessionStart, not from launchd, and that is not a style choice: the
# cmux socket authorizes a caller by the CMUX_SOCKET_CAPABILITY it inherits, and a
# launchd job has none. Measured -- `launchctl submit ... cmux ping` answers
# "Access denied - only processes started inside cmux can connect", so
# `com.crew.sync` reconciled nothing for as long as it was loaded.
#
# A hook runs inside a cmux terminal, so it holds the token, and a detached child
# keeps it: an orphan at ppid 1 with the env intact still gets PONG, while the same
# orphan with CMUX_SOCKET* stripped is refused. Detachment was never the problem.
#
# crew-listen is a singleton on its own pidfile, so calling this from every
# SessionStart is safe and idempotent.
crew_listen_ensure() {
  [ -n "${CREW_CMUX:-}" ] || return 0
  local dir; dir="$(dirname "$(dirname "${BASH_SOURCE[0]}")")"
  local bin="$dir/bin/crew-listen"
  [ -x "$bin" ] || return 0
  [ -f "$CREW_STATE/listen.off" ] && return 0
  local pid
  pid="$(cat "$CREW_STATE/listen.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$CREW_STATE" 2>/dev/null || true
  # stderr to the log, because the daemon's only voice is stderr and nothing else
  # captures it now that launchd's StandardErrorPath is gone.
  ( nohup "$bin" >>"$CREW_STATE/listen.log" 2>&1 & ) >/dev/null 2>&1
}

crew_lane_release() {
  local m; m="$(crew_lane_marker)"
  [ -f "$m" ] || return 0          # nothing overridden — cheapest possible path
  rm -f "$m" 2>/dev/null || true
  crew_cmux workspace status set auto
}
