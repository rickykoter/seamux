#!/bin/bash
# take-lookout-loop — the deeper lookout video: a coupon feature built by a
# live Claude across several clusters of files, reviewed in lookout with
# System-1 (Jev) risk, then one prompt that has the agent loop review → fix →
# test → review until a round files nothing new.
#
#   bash docs/demo/live/setup.sh && bash docs/demo/live/deep-dive-setup.sh
#   bash docs/demo/live/system-one-setup.sh && bash docs/demo/live/app.sh
#   bash docs/demo/live/take-lookout-loop.sh [ROOT]
#
# Writes ROOT/take-loop/app.mp4 and beats.tsv. File rows are opened with a
# real click (the demo app comes to the front): keep hands off the mouse.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh" "${1:-/private/tmp/seamux-demo}"
OUT=$DEMO_ROOT/take-loop${LOOP_RESUME:+B}
rm -rf "$OUT"; mkdir -p "$OUT"
T0=0
beat() { printf '%s\t%s\n' "$(python3 -c "import time;print(round(time.time()-$T0,2))")" "$1" | tee -a "$OUT/beats.tsv"; }
fail() { echo "take-loop: $*" >&2; stop_rec; exit 1; }
REC=
stop_rec() { [ -n "$REC" ] && kill -INT "$REC" 2>/dev/null && wait "$REC" 2>/dev/null; REC=; }
trap 'stop_rec' EXIT
REVIEWS=$DEMO_HOME/.claude/plans/reviews
review() { ls -t "$REVIEWS" 2>/dev/null | grep '\.json$' | grep -v '\.rows\.json$' | head -1 | sed 's/\.json$//'; }
findings() { demo_env bash -c "cd ~/code/shop.worktrees/coupons && lookout findings list $1 2>/dev/null" | grep -E '^f[0-9]+ '; }
# The Dock lists a review a few seconds after it opens: keep looking.
lookout_tab() {
  local end=$((SECONDS + ${1:-30}))
  while [ $SECONDS -lt $end ]; do
    for n in 1 2 3 4; do "$DEMO_TOOLS/axfind" --press "$(app_pid)" "^$n LOOKOUT" >/dev/null 2>&1 && return 0; done
    sleep 1
  done
  return 1
}
# A file row opens on the second click: the first one only focuses the page.
open_file() { hand "^$1" 5 || return 1; sleep 0.7; hand "^$1" 3; }
# The agent is done when its prompt is idle and nothing runs in the background.
settled() {
  local s; s=$(screen coupons 2>/dev/null)
  printf '%s' "$s" | grep -qiE 'background agent|shell still running|shells? running' && return 1
  idle coupons 3 2>/dev/null
}

# LOOP_RESUME=1 picks up a world where the review is open and no reviewer
# has run: no pre-roll, no open; the tour starts at once.
# ── pre-roll: the feature, built live across several clusters ───────────────
ui frame 60 40 1600 900 >/dev/null
if [ -z "${LOOP_RESUME:-}" ]; then
tap Wake; sleep 1; tap Dock
newws coupons >/dev/null || fail "no coupons pane"
idle coupons 60
SPLIT="Resize the chat: drag, or use the arrow keys; double-click resets"
read -r SX SY <<< "$(_where "$SPLIT" 10)" || fail "no splitter"
front; "$DEMO_TOOLS/click" "$SX" "$SY" $((SX - 165)) "$SY" >/dev/null
say coupons "Build coupon codes, in exactly these files, then run npm test and commit everything. (1) src/coupons/lookup.js: export findCoupon(code, coupons) that trims and uppercases the code and returns the matching coupon or null; test it in test/lookup.test.js. (2) src/checkout/route.js: import findCoupon from '../coupons/lookup.js' and pass the coupon's discount to total(); add a case to test/total.test.js. (3) db/migrate/002_coupons.sql: a coupons table (code, percent_off, expires_at). (4) src/auth/admin.js: export isAdmin(req), true when req.headers['x-admin-token'] equals the token in config/admin.json; create that config file. (5) src/admin/coupons-api.js: a createCoupon(req) handler that requires isAdmin from '../auth/admin.js' and caps percent_off at the maxPercent it reads from config/coupons.json; create that file too. (6) docs/coupons.md: how coupons work, in a few lines. Don't import between the checkout and admin files."
sleep 10; idle coupons 900 || fail "the build never finished"
idle coupons 30
fi

"$DEMO_TOOLS/winrec" "$(win_id)" "$OUT/app.mp4" > "$OUT/winrec.log" 2>&1 & REC=$!
for _ in $(seq 50); do grep -q '^recording' "$OUT/winrec.log" 2>/dev/null && break; sleep 0.2; done
T0=$(awk '/^recording/{print $2; exit}' "$OUT/winrec.log")
[ -n "$T0" ] || fail "the recorder never started"
beat start
sleep 3

# ── the review opens: risk, with System-1 ───────────────────────────────────
if [ -z "${LOOP_RESUME:-}" ]; then
  say coupons "Open a lookout review of this branch against main. Only open it: no reviewer yet."
  beat open
  end=$((SECONDS + 300)); until [ -n "$(review)" ] || [ $SECONDS -ge $end ]; do sleep 2; done
  idle coupons 120
  beat opened
  sleep 4
fi
ID=$(review); [ -n "$ID" ] || fail "no review opened"
# Before a reviewer reports, the Dock lists no review; the app's Lookout tab
# shows it full width, with lookout's own risk and groups.
tap Lookout 5 || fail "no Lookout tab"
sleep 1.5
front; "$DEMO_TOOLS/click" 158 323 >/dev/null; sleep 0.8; "$DEMO_TOOLS/click" 158 323 >/dev/null
beat page
sleep 7

# ── risk up close: each file's reasons, in its diff header ──────────────────
for f in admin.js route.js 002_coupons.sql coupons.md; do
  open_file "$f" && { beat "file-$f"; sleep 5; }
done

# ── grouping: the path view, then the overview's groups and their whys ─────
tap Path 5 && { beat path; sleep 5; tap Risk 5; beat risk; sleep 2; }
tap Overview 5 && { beat groups; sleep 8; tap Overview 5; }

# ── the loop: review → fix → test → review, run by the agent ───────────────
tap Dock 5
sleep 1
say coupons "Loop lookout over this branch until it comes back clean. Each round: run lookout open again, spawn one fresh reviewer subagent with exactly what lookout prompt prints and wait for it, then fix every blocker, major and minor it filed, run npm test, commit, and mark each fix addressed in lookout with what changed. On any finding you won't fix, reply in lookout saying why. Stop when a round files nothing new, or after 3 rounds. Start each round's report with \"Round N:\"."
beat loop
nf=0 na=0 seen_round=0 open_ov=0 end=$((SECONDS + 2700)) still=0
while [ $SECONDS -lt $end ]; do
  F=$(findings "$ID")
  c=$(printf '%s\n' "$F" | grep -c '^f'); a=$(printf '%s\n' "$F" | grep -c '\[addressed\]')
  if [ "$c" -gt "$nf" ]; then
    [ "$nf" = 0 ] && lookout_tab 20
    nf=$c; beat "findings-$nf"
    [ $open_ov = 0 ] && { tap Overview 3 && open_ov=1; beat notes; }
  fi
  [ "$a" -gt "$na" ] && { na=$a; beat "addressed-$na"; [ $open_ov = 1 ] && { tap Overview 3; open_ov=0; }; }
  r=$(screen coupons 2>/dev/null | grep -oE 'Round [0-9]' | tail -1 | grep -oE '[0-9]')
  [ -n "$r" ] && [ "$r" -gt "$seen_round" ] && { seen_round=$r; beat "round-$r"; }
  if settled; then still=$((still + 1)); [ $still -ge 4 ] && break; else still=0; fi
  sleep 3
done
[ $open_ov = 1 ] && tap Overview 3
beat looped
sleep 4

# ── a person closes: resolve what was fixed, the gate passes ───────────────
for f in $(findings "$ID" | awk '/\[addressed\]/{print $1}'); do
  file=$(findings "$ID" | awk -v f="$f" '$1==f{print $NF}' | sed 's#.*/##; s#:.*##')
  open_file "$file" || continue
  sleep 1.5
  tap Resolve 5 && { beat "resolved-$f"; sleep 2.5; }
done
say coupons "I've resolved what you fixed in lookout. Run lookout gate for this review and tell me in one line where it stands."
beat gate-ask
sleep 8; idle coupons 180
beat gate
sleep 6
beat end
stop_rec
echo "take-loop: $OUT ($ID, $nf findings)"
