#!/bin/bash
# take-lookout — one live take for the lookout video, after take-deep.sh in the
# same world: the coupons branch reviewed in lookout by a fresh reviewer
# subagent, the page toured, findings fixed by the agent and closed by a
# person.
#
#   bash docs/demo/live/take-lookout.sh [ROOT]
#
# Writes ROOT/take-lookout/app.mp4 and beats.tsv. Only accessibility presses:
# the mouse is never moved.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh" "${1:-/private/tmp/seamux-demo}"
OUT=$DEMO_ROOT/take-lookout${LOOKOUT_PART2:+2}
rm -rf "$OUT"; mkdir -p "$OUT"
T0=0
beat() { printf '%s\t%s\n' "$(python3 -c "import time;print(round(time.time()-$T0,2))")" "$1" | tee -a "$OUT/beats.tsv"; }
fail() { echo "take-lookout: $*" >&2; stop_rec; exit 1; }
REC=
stop_rec() { [ -n "$REC" ] && kill -INT "$REC" 2>/dev/null && wait "$REC" 2>/dev/null; REC=; }
trap 'stop_rec' EXIT
REVIEWS=$DEMO_HOME/.claude/plans/reviews
review() { ls -t "$REVIEWS" 2>/dev/null | grep '\.json$' | grep -v '\.rows\.json$' | head -1 | sed 's/\.json$//'; }
findings() { demo_env bash -c "cd ~/code/shop.worktrees/coupons && lookout findings list $1 2>/dev/null" | grep -E '^f[0-9]+ '; }
BEFORE=$(review)

idle coupons 120
tap "Claude" 5
"$DEMO_TOOLS/winrec" "$(win_id)" "$OUT/app.mp4" > "$OUT/winrec.log" 2>&1 & REC=$!
for _ in $(seq 50); do grep -q '^recording' "$OUT/winrec.log" 2>/dev/null && break; sleep 0.2; done
T0=$(awk '/^recording/{print $2; exit}' "$OUT/winrec.log")
[ -n "$T0" ] || fail "the recorder never started"
beat start
sleep 3

# ── a review, and a fresh reviewer ──────────────────────────────────────────
# LOOKOUT_PART2=1 picks up an existing review (its findings already filed).
if [ -n "${LOOKOUT_PART2:-}" ]; then BEFORE=""; else
say coupons "Review this branch in lookout before we close increment 1: open a review against main with the quiz on, then spawn one fresh reviewer subagent with exactly what lookout prompt prints, and wait for its findings."
beat ask
end=$((SECONDS + 300))
until [ -n "$(review)" ] && [ "$(review)" != "$BEFORE" ] || [ $SECONDS -ge $end ]; do sleep 2; done
ID=$(review); [ -n "$ID" ] && [ "$ID" != "$BEFORE" ] || fail "no review opened"
beat opened
tap "^1 LOOKOUT" 20 || tap "^2 LOOKOUT" 5 || tap "^3 LOOKOUT" 5
beat lo-page
end=$((SECONDS + 900))
until [ -n "$(findings "$ID")" ] || [ $SECONDS -ge $end ]; do sleep 3; done
[ -n "$(findings "$ID")" ] || fail "no findings were filed"
beat findings
idle coupons 300
beat findings-said
fi
ID=$(review)

# ── the page: risk bands, the path view, the overview and its quiz ─────────
tap "^1 LOOKOUT" 5 || tap "^2 LOOKOUT" 5 || tap "^3 LOOKOUT" 5
sleep 2
beat lo-risk
sleep 6
tap Path 5 && { beat lo-path; sleep 4; tap Risk 5; beat lo-risk-again; sleep 2; }
tap Overview 5 && { beat lo-overview; sleep 8; tap Overview 5; }
sleep 2

# ── back and forth: the agent fixes and says so, a person closes ───────────
say coupons "Fix the lookout findings that fit this increment, commit, and mark each one addressed in lookout with what changed. On any you won't fix, reply in lookout saying why."
beat fix
sleep 10; idle coupons 900 || fail "the fixes never finished"
beat addressed
tap "^1 LOOKOUT" 5 || tap "^2 LOOKOUT" 5 || tap "^3 LOOKOUT" 5
sleep 3
for f in $(findings "$ID" | awk '/\[addressed\]/{print $1}'); do
  file=$(findings "$ID" | awk -v f="$f" '$1==f{print $NF}' | sed 's#.*/##; s#:.*##')
  tap "^$file" 5 || continue
  sleep 2
  tap Resolve 5 || continue
  beat "resolved-$f"
  sleep 3
done
sleep 2
beat gate
say coupons "I've closed what you fixed in lookout. Check the gate, then run deep-plan check run for increment 1 and done."
beat close
sleep 10; idle coupons 600
beat done
sleep 6
beat end
stop_rec
echo "take-lookout: $OUT ($ID)"
