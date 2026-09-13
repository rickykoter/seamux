#!/usr/bin/env bash
# crew — the single Claude Code hook entry point.
#
#   crew-hook.sh <session|pretool|task|notification|stop|end>
#
# One process per hook event. The pieces used to be separate scripts, but
# PreToolUse alone fires thousands of times a session, so each avoided fork is
# real. Everything below either exits on the guard or does one socket call.
#
# Events, and what each one knows that cmux does not:
#
#   session       the branch's ticket -> a readable workspace name and a stable
#                 per-ticket color
#   pretool       work resumed -> release any lane override back to cmux
#   task          the plan changed -> progress bar, checklist, in-flight pill
#   notification  Claude is blocked on you -> needs-attention lane + banner
#   stop          turn finished -> review lane, sidebar-only record, clear pill
#   end           session over -> release the lane

set -u

event="${1:-}"

# --- hot path ----------------------------------------------------------------
# pretool fires on every tool use — thousands of times a session — and in the
# overwhelming majority of those there is no lane override to release. Handle
# it before sourcing lib.sh: parsing the library costs more than the work.
# Measured on this machine: 9.1ms here, 15.7ms through the general path, and
# 51.5ms for set_status_running.sh — the v1 hook this replaces, which made an
# unconditional socket call every single time.
if [ "$event" = "pretool" ]; then
  _m="${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew/lane-${CMUX_WORKSPACE_ID:-none}"
  [ -f "$_m" ] || exit 0
  [ -f "${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew/disabled" ] && exit 0
  rm -f "$_m" 2>/dev/null
  if command -v cmux >/dev/null 2>&1; then
    cmux workspace status set auto >/dev/null 2>&1
  else
    # Newest bundle by mtime. No subprocess beyond this: pretool is the hot path.
    _c="$(ls -dt /Applications/cmux*.app/Contents/Resources/bin/cmux 2>/dev/null | head -1)"
    [ -x "$_c" ] && "$_c" workspace status set auto >/dev/null 2>&1
  fi
  exit 0
fi

CREW_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$CREW_DIR/lib.sh"
crew_guard

crew_read_payload

case "$event" in
  session)
    # Marker so `crew status` can tell you whether hooks are actually live for
    # this session. They bind at session start, so a session that predates
    # `crew apply` never gets them and silently publishes nothing.
    #
    # `crew adopt` replays this same event to back-fill such a session, and must
    # NOT leave the marker behind — that would forge the very state it is
    # working around.
    if [ "${CREW_ADOPT:-}" != "1" ]; then
      sid="$(crew_json session_id)"
      if [ -n "$sid" ]; then
        mkdir -p "$CREW_STATE" 2>/dev/null || true
        : > "$CREW_STATE/session-$sid" 2>/dev/null || true
      fi
    fi

    cwd="$(crew_cwd)"
    dir="$(basename "$cwd")"
    branch="$(crew_branch "$cwd")"

    # Without this a worktree shows in the sidebar as its raw path — unreadable
    # at sidebar width and near-identical to its neighbours.
    label=""
    [ -n "$branch" ] && label="$(crew_ticket_label "$branch")"
    [ -n "$label" ] || label="$dir"   # main, a spike, or a non-repo dir

    crew_cmux rename-workspace "$label"
    crew_cmux rename-tab "$dir${branch:+ · $branch}"

    # Colour comes from crew-color's registry, not from a hash of the ticket --
    # see crew_color_ensure. Only ever fills a blank.
    crew_color_ensure "$cwd"
    crew_phase "working"

    # Start the always-on reconciler if it is not already up. Session start is the
    # right place: it runs inside a cmux terminal, so the daemon inherits the
    # socket capability that launchd cannot get. Idempotent -- crew-listen is a
    # singleton on its own pidfile.
    crew_listen_ensure
    ;;

  task)
    # shellcheck source=progress.sh
    . "$CREW_DIR/progress.sh"
    crew_publish_progress
    crew_phase "working"
    ;;

  notification)
    crew_lane_set needs-attention
    crew_phase "waiting on you"
    # Publish the pending ask while the 120s window is still open. The hook is
    # the only thing fast enough — crew-sync's own clock is 120s, i.e. exactly
    # the width of the window it would be trying to catch.
    ( nohup "$(dirname "$CREW_DIR")/bin/crew-feed" publish "$CMUX_WORKSPACE_ID" \
        >/dev/null 2>&1 & ) >/dev/null 2>&1
    message="$(crew_json message)"
    [ -n "$message" ] || message="Claude needs attention"
    crew_cmux notify --title "$(crew_label)" --subtitle "crew:blocked" --body "$message"
    ;;

  stop)
    # Claude re-enters Stop when a stop hook continues the turn; don't restate.
    [ "$(crew_json stop_hook_active)" = "True" ] && exit 0
    cwd="$(crew_cwd)"
    branch="$(crew_branch "$cwd")"

    # cmux already infers a lane from live signals (needs input, running, open
    # PR, dirty tree). Only pin `review` when the turn actually left something
    # to look at — otherwise release and let that inference stand, so a plain
    # question-answering turn doesn't park the workspace in review.
    if crew_has_unreviewed_work "$cwd"; then
      crew_lane_set review
    else
      crew_lane_release
    fi

    crew_cmux clear-status claude
    # One read-modify-write for the lot, not one call per key.
    #
    # The feed keys must match crew-feed's own list (bin/crew-feed:211) --
    # "feedws" was missing here, so a turn ending while a Feed ask was still
    # pending stripped four of the five and orphaned the fifth. Invisible on the
    # board, because has(w, "feed:") does not match "feedws:", but still a lie in
    # the description.
    crew_token_clear phase feed feedby feedgate feedreq feedws
    # "crew:turn" is the marker the cmux notification hook in cmux.json matches
    # on to strip the desktop banner. The sidebar entry survives.
    crew_cmux notify --title "$(crew_label)" --subtitle "crew:turn" \
      --body "Turn complete${branch:+ — $branch}"
    crew_sync_maybe
    ;;

  end)
    crew_lane_release
    crew_cmux clear-status claude
    crew_phase ""
    ;;
esac

exit 0
