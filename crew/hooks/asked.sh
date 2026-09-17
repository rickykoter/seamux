#!/usr/bin/env bash
# crew — turn-end follow-up: promote "turn complete" to "waiting on you" when the
# turn actually ended on a question. Optional; see asked.py.
#
#   asked.sh <transcript-size-at-stop>  < stop-payload
#
# Spawned detached by the stop hook, so the turn never waits on the network. It
# keeps the hook's environment, and with it the cmux socket capability (see
# crew_listen_ensure in lib.sh for why that survives detachment).
#
# The judgment arrives a second or two after the turn ended, so it re-checks that
# the conversation has not moved on before acting: an answer about a transcript
# you have already replied to is stale, and applying it would park a working
# agent under "asked you".

set -u

CREW_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$CREW_DIR/lib.sh"
crew_guard

crew_read_payload
size_at_stop="${1:-}"

out="$(printf '%s' "$CREW_PAYLOAD" | python3 "$CREW_DIR/asked.py" judge 2>>"$CREW_STATE/asked.log")"
rc=$?
# 0 = asked, 1 = not asked — both carry a judgment worth caching for the
# board's ranking. 2 (or anything else) is "no judgment": stop here.
{ [ "$rc" = 0 ] || [ "$rc" = 1 ]; } || exit 0

transcript="$(crew_json transcript_path)"
if [ -n "$transcript" ] && [ -n "$size_at_stop" ]; then
  now_size="$(wc -c <"$transcript" 2>/dev/null | tr -d ' ')"
  [ "$now_size" = "$size_at_stop" ] || exit 0
fi

question="$(printf '%s\n' "$out" | sed -n 2p)"
extras="$(printf '%s\n' "$out" | sed -n 3p)"
printf '%s %s p=%s extras=%s\n' "$(date +%H:%M:%S)" "$CMUX_WORKSPACE_ID" \
  "$(printf '%s\n' "$out" | sed -n 1p)" "${extras:-{\}}" \
  >>"$CREW_STATE/asked.log" 2>/dev/null

# The board's ranking cache: line 1 (blocked) plus line 3 (stuck, urgency),
# keyed by cwd so rank() can join without cmux. Best-effort — a failed write
# must not cost the lane/banner below.
if [ -n "$extras" ]; then
  printf '%s' "$extras" | python3 "$CREW_DIR/../board/judgments.py" --record \
    "$(crew_cwd)" "${size_at_stop:-0}" "$(printf '%s\n' "$out" | sed -n 1p)" \
    2>>"$CREW_STATE/asked.log" || true
fi

[ "$rc" = 0 ] || exit 0

# The same three moves as the notification event, plus a marker so the next tool
# use can take the phase back (see the pretool hot path in crew-hook.sh).
crew_lane_set needs-attention
crew_phase "waiting on you"
: > "$CREW_STATE/asked-$CMUX_WORKSPACE_ID" 2>/dev/null || true
crew_cmux notify --title "$(crew_label)" --subtitle "crew:blocked" \
  --body "${question:-Claude is waiting on you}"
