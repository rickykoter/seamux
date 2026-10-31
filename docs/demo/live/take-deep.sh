#!/bin/bash
# take-deep — one live take for the deep-plan and lookout videos: a plan made
# from scratch by a real Claude (Sonnet, low effort), its sections toured, its
# checks run (unit, browser, review), and its lookout review worked through.
#
#   bash docs/demo/live/setup.sh && bash docs/demo/live/deep-dive-setup.sh && bash docs/demo/live/app.sh
#   bash docs/demo/live/take-deep.sh [ROOT]
#
# Writes ROOT/take-deep/app.mp4 and beats.tsv. Questions are answered with
# their first (recommended) option, after a pause long enough to read them.
# The board's go chip is pressed with a real click, so the demo app comes to
# the front for it: keep your hands off the mouse while the take runs.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh" "${1:-/private/tmp/seamux-demo}"
OUT=$DEMO_ROOT/take-deep
rm -rf "$OUT"; mkdir -p "$OUT"
T0=0
beat() { printf '%s\t%s\n' "$(python3 -c "import time;print(round(time.time()-$T0,2))")" "$1" | tee -a "$OUT/beats.tsv"; }
fail() { echo "take-deep: $*" >&2; stop_rec; exit 1; }
REC=
stop_rec() { [ -n "$REC" ] && kill -INT "$REC" 2>/dev/null && wait "$REC" 2>/dev/null; REC=; }
trap 'stop_rec' EXIT
STATE=$DEMO_HOME/.claude/deep-plan/state
slug() { ls -t "$STATE"/*.json 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null | sed 's/\.json$//'; }
phase() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('phase',''))" "$STATE/$1.json" 2>/dev/null; }
findings() { demo_env bash -c "cd ~/code/shop.worktrees/coupons && lookout findings list $1 2>/dev/null" | grep -E '^f[0-9]+ '; }

# ── pre-roll: the workspace, the page pane widened ──────────────────────────
ui frame 60 40 1600 900 >/dev/null
tap Wake; sleep 1; tap Dock
newws coupons >/dev/null || fail "no coupons pane"
idle coupons 60
SPLIT="Resize the chat: drag, or use the arrow keys; double-click resets"
read -r SX SY <<< "$(_where "$SPLIT" 10)" || fail "no splitter"
front; "$DEMO_TOOLS/click" "$SX" "$SY" $((SX - 165)) "$SY" >/dev/null
sleep 1

"$DEMO_TOOLS/winrec" "$(win_id)" "$OUT/app.mp4" > "$OUT/winrec.log" 2>&1 & REC=$!
for _ in $(seq 50); do grep -q '^recording' "$OUT/winrec.log" && break; sleep 0.2; done
T0=$(awk '/^recording/{print $2; exit}' "$OUT/winrec.log")
[ -n "$T0" ] || fail "the recorder never started"
beat start
sleep 3

# ── deep-plan: the ask, its forks, the render ───────────────────────────────
say coupons "Deep plan this: take coupon codes at checkout. A customer types a code on the checkout page and the discount shows in the total."
beat ask
n=0 end=$((SECONDS + 1200)) asked=0
while [ $SECONDS -lt $end ]; do
  s=$(slug); [ -n "$s" ] && [ "$(phase "$s")" = review ] && break
  if screen coupons | grep -qE 'Enter to select|Ready to submit'; then
    [ $asked = 0 ] && { n=$((n + 1)); beat "fork-$n"; asked=1; sleep 5; }
    a=$(answer coupons); [ "$a" = submit ] && asked=0
    [ "$a" = pick ] && ! screen coupons | grep -qE 'Enter to select|Ready to submit' && asked=0
    sleep 1.5; continue
  fi
  sleep 2
done
SLUG=$(slug); [ -n "$SLUG" ] || fail "no plan rendered"
beat rendered
idle coupons 300
beat plan-said

# ── the plan page, section by section ───────────────────────────────────────
tap "^1 PLAN" 20 || fail "no plan tab"
sleep 3
beat tour
for sec in Context Non-goals Decisions Contracts "Verified facts" Risks Diagrams Increments "Alignment check"; do
  tap "$sec" 5 || continue
  beat "sec-$sec"
  sleep 5
done

# ── the quiz, the recipes, the go ───────────────────────────────────────────
for _ in 1 2 3; do
  say coupons "My quiz answers: $(bash "$HERE/answers.sh" "$SLUG" "$DEMO_ROOT")"
  beat quiz
  sleep 5; idle coupons 200
  [ "$(phase "$SLUG")" = implementing ] && break
done
[ "$(phase "$SLUG")" = implementing ] || fail "the grade did not pass"
beat graded
sleep 3
say coupons '!cat .seamux/verify.json'
beat recipes
sleep 4; idle coupons 120
beat recipes-said
sleep 3
hand "go 1" 30 || fail "no go chip"
beat go
sleep 3
say coupons "The go is given on the board. Build increment 1, commit it, then run deep-plan check run for it."
beat build
sleep 10; idle coupons 900 || fail "the build never finished"
beat checked
sleep 3

# ── lookout: the reviewer, the page, the fixes ──────────────────────────────
REVIEW="$SLUG-inc1"
if [ -z "$(findings "$REVIEW")" ]; then
  say coupons "Spawn the reviewer."
  beat reviewer
  end=$((SECONDS + 900))
  until [ -n "$(findings "$REVIEW")" ] || [ $SECONDS -ge $end ]; do sleep 5; done
  idle coupons 300
fi
[ -n "$(findings "$REVIEW")" ] || fail "no findings were filed"
beat findings
tap "^2 LOOKOUT" 20 || tap "^1 LOOKOUT" 5 || tap "^3 LOOKOUT" 5 || fail "no lookout tab"
beat lo-page
sleep 6
tap Path 5 && { beat lo-path; sleep 4; tap Risk 5; beat lo-risk; sleep 2; }
tap Overview 5 && { beat lo-overview; sleep 6; tap Overview 5; }
say coupons "Fix the findings that fit this increment, commit, and mark each one addressed in lookout with what changed. File any that don't fit as deep-plan notes."
beat fix
sleep 10; idle coupons 900 || fail "the fixes never finished"
beat addressed
sleep 3
# Only a person closes a finding: resolve each addressed one on the page.
for f in $(findings "$REVIEW" | awk '/\[addressed\]/{print $1}'); do
  file=$(findings "$REVIEW" | awk -v f="$f" '$1==f{print $NF}' | sed 's#.*/##; s#:.*##')
  tap "^$file" 5 || continue
  sleep 2
  tap Resolve 5 || continue
  beat "resolved-$f"
  sleep 3
done
say coupons "I've closed what you fixed. Run deep-plan check run for increment 1 again, then done."
beat close
sleep 10; idle coupons 600
beat done
sleep 6
beat end
stop_rec
echo "take-deep: $OUT"
