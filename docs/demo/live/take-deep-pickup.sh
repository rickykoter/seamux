#!/bin/bash
# take-deep-pickup — after take-deep: click the Dock terminal so it redraws
# the agent's summary (it can freeze mid-take), then open the plan's
# Increments. Writes ROOT/take-pickup, which edit-deep.json cuts from.
set -u
source "$(cd "$(dirname "$0")" && pwd)/lib.sh" "${1:-/private/tmp/seamux-demo}"
OUT=$DEMO_ROOT/take-pickup; rm -rf "$OUT"; mkdir -p "$OUT"
"$DEMO_TOOLS/winrec" "$(win_id)" "$OUT/app.mp4" > "$OUT/winrec.log" 2>&1 & REC=$!
for _ in $(seq 50); do grep -q '^recording' "$OUT/winrec.log" 2>/dev/null && break; sleep 0.2; done
T0=$(awk '/^recording/{print $2; exit}' "$OUT/winrec.log")
beat() { printf '%s\t%s\n' "$(python3 -c "import time;print(round(time.time()-$T0,2))")" "$1" | tee -a "$OUT/beats.tsv"; }
beat start; sleep 2
front; "$DEMO_TOOLS/click" 620 520 >/dev/null; beat term; sleep 4
tap Increments 5 && beat incs || { "$DEMO_TOOLS/click" 1400 600 >/dev/null; tap Increments 5 && beat incs; }
sleep 7
beat end
kill -INT $REC; wait $REC
