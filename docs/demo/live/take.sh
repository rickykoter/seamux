#!/bin/bash
# take — one live take of the seamux app: real Claude sessions (Sonnet, low
# effort) in the demo app's workspaces, filmed by winrec, each beat logged.
#
#   bash docs/demo/live/setup.sh && bash docs/demo/live/app.sh
#   bash docs/demo/live/take.sh [ROOT]
#
# Writes ROOT/take/app.mp4 (the window) and ROOT/take/beats.tsv (seconds from
# the first frame, beat name). A beat that doesn't happen stops the take.
# Nothing here moves your mouse or types into another app: buttons are pressed
# through accessibility and Claude is typed to through the app's tmux.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh" "${1:-/private/tmp/seamux-demo}"
OUT=$DEMO_ROOT/take
rm -rf "$OUT"; mkdir -p "$OUT"
T0=0
beat() { printf '%s\t%s\n' "$(python3 -c "import time;print(round(time.time()-$T0,2))")" "$1" | tee -a "$OUT/beats.tsv"; }
fail() { echo "take: $*" >&2; stop_rec; exit 1; }
REC=
stop_rec() { [ -n "$REC" ] && kill -INT "$REC" 2>/dev/null && wait "$REC" 2>/dev/null; REC=; }
trap 'stop_rec' EXIT

ui frame 60 40 1600 900 >/dev/null
ui press Dock >/dev/null
sleep 2

"$DEMO_TOOLS/winrec" "$(win_id)" "$OUT/app.mp4" > "$OUT/winrec.log" 2>&1 &
REC=$!
for _ in $(seq 50); do grep -q '^recording' "$OUT/winrec.log" && break; sleep 0.2; done
T0=$(awk '/^recording/{print $2; exit}' "$OUT/winrec.log")
[ -n "$T0" ] || fail "the recorder never started"
beat start
sleep 3

# ── 1. a hard choice, with pictures ─────────────────────────────────────────
beat form-ask
newws checkout-errors "Checkout needs a rule for coupon codes that don't work. Show me the choice with \`deep-plan ask ~/coupon-ask.json\`, then ask me the same question with AskUserQuestion: one question, the same three option labels. When I answer, reply in one sentence." >/dev/null || fail "no checkout-errors pane"
beat created-ask
until_screen checkout-errors 'Enter to select|Esc to cancel' 180 || fail "no question in checkout-errors"
beat asked
sleep 4
for _ in $(seq 20); do ui press "1 ASK" | grep -q pressed && break; sleep 0.5; done
beat ask-page
sleep 7
ui pressx "1" >/dev/null
beat picked
until_screen checkout-errors '→|Say why' 30
idle checkout-errors 120
beat answered
sleep 3

# ── 2. a plan, and a gate on edits ──────────────────────────────────────────
beat form-plan
newws coupons >/dev/null || fail "no coupons pane"
idle coupons 60
W=$DEMO_HOME/code/shop.worktrees/coupons
demo_env bash -c "cd '$W' && deep-plan render '$DEMO_HOME/demo-coupons.spec.json' --root '$W' >/dev/null && deep-plan grade demo-coupons \$(python3 -c \"import json;k=json.load(open('$DEMO_HOME/.claude/deep-plan/keys/demo-coupons.key.json'));print(' '.join(f'{q}={a[\\\"letter\\\"]}' for q,a in k['answers'].items()))\") >/dev/null" || fail "the plan did not render or grade"
beat plan-ready
sleep 3
# The tab appears a moment after the plan does: press until it is there.
for _ in $(seq 20); do ui press "1 PLAN" | grep -q pressed && break; sleep 0.5; done
beat plan-page
sleep 6
say coupons "Start on the coupon lookup: create src/coupons/lookup.js with a lookup(code) function. Write the file first."
beat try-edit
until_screen coupons 'No increment is authorized' 120 || fail "the gate did not refuse"
beat refused
idle coupons 90
beat gate-shut
sleep 5
say coupons "go. Build increment 1: src/coupons/lookup.js seeded with WELCOME10 (10% off, any case) and a node:test test in test/coupons.test.js. Run npm test. Don't commit."
beat go
until_screen coupons 'Wrote [0-9]+ lines' 240 || fail "no edit after go"
beat building
idle coupons 400 || fail "coupons never finished"
beat built
sleep 4

# ── 3. the guard ────────────────────────────────────────────────────────────
beat form-guard
newws release "Push this branch to origin now with git push --force. If anything stops you, say what in one sentence and stop." >/dev/null || fail "no release pane"
until_screen release 'guard' 180 || fail "bash-guard did not block"
beat blocked
idle release 60
beat guard-said
# Claude Code offers auto mode after a refused command: keep accept edits.
if until_screen release 'Make auto mode' 8 2>/dev/null; then keys release Down Enter; fi
sleep 4

# ── 4. the wake ─────────────────────────────────────────────────────────────
ui press Wake >/dev/null
beat wake
sleep 8
ui press Dock >/dev/null
beat dock
sleep 6
beat end
stop_rec
echo "take: $OUT/app.mp4"
