#!/bin/bash
# take-family — one live take of a deep-plan family where one workstream runs
# in a (simulated) cloud session: the laptop's app and the cloud's terminal
# are filmed at once, every Claude is real (Sonnet, low effort).
#
#   bash docs/demo/live/setup.sh && bash docs/demo/live/family-setup.sh && bash docs/demo/live/app.sh
#   bash docs/demo/live/take-family.sh [ROOT]
#
# Writes ROOT/take-family/{app,cloud}.mp4, beats.tsv (seconds from the app
# recording's first frame) and cloud.offset (when the cloud recording started,
# on the same clock). A beat that doesn't happen stops the take.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh" "${1:-/private/tmp/seamux-demo}"
OUT=$DEMO_ROOT/take-family
rm -rf "$OUT"; mkdir -p "$OUT"
T0=0
beat() { printf '%s\t%s\n' "$(python3 -c "import time;print(round(time.time()-$T0,2))")" "$1" | tee -a "$OUT/beats.tsv"; }
fail() { echo "take-family: $*" >&2; stop_rec; exit 1; }
RA= RC=
stop_rec() {
  for p in $RA $RC; do kill -INT "$p" 2>/dev/null; done
  for p in $RA $RC; do wait "$p" 2>/dev/null; done
  RA= RC=
}
trap 'stop_rec' EXIT
press() { for _ in $(seq 20); do ui press "$1" | grep -q pressed && return 0; sleep 0.5; done; echo "no control: $1" >&2; return 1; }

# ── pre-roll: the workspaces, the plans, the cloud ──────────────────────────
ui frame 60 40 1600 900 >/dev/null
press Wake >/dev/null; sleep 1; press Dock >/dev/null
newws auth-revamp >/dev/null || fail "no auth-revamp pane"
newws auth-ui >/dev/null || fail "no auth-ui pane"
bash "$HERE/family-stage.sh" "$DEMO_ROOT" || fail "the family did not stage"
CWID=$(CLOUD_X=330 CLOUD_Y=190 bash "$HERE/cloud.sh" "$DEMO_ROOT" start)
[ -n "$CWID" ] || fail "no cloud window"
idle cloud 60 || fail "the cloud session did not start"
idle auth-revamp 60; idle auth-ui 60
press "auth-revamp (parent)" >/dev/null || fail "no family strip"
sleep 1.5
press "1 PLAN" >/dev/null
sleep 2
ui press Workstreams >/dev/null
sleep 2

# ── record both windows ─────────────────────────────────────────────────────
# One recorder for both windows: two at once interrupt each other.
"$DEMO_TOOLS/winrec" "$(win_id)" "$OUT/app.mp4" "$CWID" "$OUT/cloud.mp4" > "$OUT/winrec.log" 2>&1 & RA=$!
for _ in $(seq 50); do [ "$(grep -c '^recording' "$OUT/winrec.log")" = 2 ] && break; sleep 0.2; done
T0=$(awk '/^recording.*app.mp4/{print $2}' "$OUT/winrec.log")
TC=$(awk '/^recording.*cloud.mp4/{print $2}' "$OUT/winrec.log")
[ -n "$T0" ] && [ -n "$TC" ] || fail "a recorder never started"
python3 -c "print(round($TC-$T0,3))" > "$OUT/cloud.offset"
beat start
sleep 7

# ── 1. the cloud workstream waits for its go ────────────────────────────────
beat cloud-ask
say cloud "You are the auth-api workstream of the auth-revamp family, running in a cloud session. Run \`deep-plan status auth-api\`. Its go comes from the parent agent on the laptop, so wait for it the way the deep-plan skill says: run \`deep-plan await-go auth-api\` as a background command and end your turn. When it returns an increment, build it: api/auth/session.js exporting createSession(userId) that returns { id, userId, expiresAt } 30 minutes ahead, and test/session.test.js with node:test. Run npm test, then \`deep-plan check run auth-api 1\` and \`deep-plan done auth-api 1\`. Don't commit."
until_screen cloud 'shell still running|1 shell' 180 || fail "the cloud never waited"
idle cloud 120
beat cloud-waiting
sleep 3

# ── 2. a workstream waits for the parent ────────────────────────────────────
press "auth-ui" >/dev/null || fail "no auth-ui chip"
beat ui
sleep 2
say auth-ui "Start on the login form: create web/login/form.js. Write the file first."
until_screen auth-ui 'auth-revamp increment 1|waits on auth-revamp' 120 || fail "the ui gate did not say what it waits on"
beat ui-refused
idle auth-ui 90
beat ui-said
sleep 4

# ── 3. the parent lands its step and gives the cloud its go ─────────────────
press "auth-revamp (parent)" >/dev/null
beat parent
sleep 2
say auth-revamp "Build increment 1: shared/session.js exporting SESSION_MINUTES = 30, with a node:test test in test/shared-session.test.js. Run npm test, then \`deep-plan check run auth-revamp 1\` and \`deep-plan done auth-revamp 1\`. Then give auth-api its go for increment 1: it runs in a cloud session and is waiting for it. Don't commit."
beat parent-asks
idle auth-revamp 120 || fail "the parent never stopped to ask"
beat parent-waits
sleep 3
# The go is a person's answer to the agent's question, on its own line.
say auth-revamp "go"
beat go
idle auth-revamp 400 || fail "the parent never finished its step"
beat parent-built
sleep 4
# One go per turn: the workstream's go is another answer from the person.
say auth-revamp "Yes, give auth-api its go."
beat child-go
until_screen auth-revamp 'go auth-api' 120 || fail "the parent never gave auth-api its go"
beat parent-gave-go
idle auth-revamp 120
beat parent-done

# ── 4. the go arrives in the cloud ──────────────────────────────────────────
until_screen cloud 'Wrote [0-9]+ lines|go arrived' 120 || fail "the cloud never heard its go"
beat cloud-go
idle cloud 400 || fail "the cloud never finished"
beat cloud-done
sleep 3

# ── 5. back on the laptop ───────────────────────────────────────────────────
beat home
say auth-revamp "Pull auth-api's state from its branch and show me the family status."
until_screen auth-revamp 'pulled auth-api' 120
idle auth-revamp 120
beat home-status
sleep 6
beat end
stop_rec
echo "take-family: $OUT"
