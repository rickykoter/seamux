#!/usr/bin/env bash
# crew — publish Claude's plan into the cmux sidebar. Sourced by crew-hook.sh.
#
# Rather than parsing the hook payload (which only carries the delta), this
# reads the authoritative state Claude Code persists at
# ~/.claude/tasks/<session_id>/<n>.json — each file is
# {id, subject, description, activeForm, status, blocks, blockedBy}.
#
# Publishes three things:
#   set-progress  the completed/total bar on the workspace row
#   set-status    a pill naming the task in flight (cmux's own claude_code pill
#                 already covers tool-level state, so duplicating it is waste)
#   todo set      the whole checklist, atomically, in one socket call

crew_publish_progress() {
  local session_id tasks_dir out frac label todos active

  session_id="$(crew_json session_id)"
  [ -n "$session_id" ] || return 0

  tasks_dir="$HOME/.claude/tasks/$session_id"
  [ -d "$tasks_dir" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  # fraction \n label \n todo-json
  out="$(python3 - "$tasks_dir" <<'PY'
import glob, json, os, sys

def order(path):
    stem = os.path.basename(path)[:-5]
    return int(stem) if stem.isdigit() else 1 << 30

done = total = 0
active = ""
items = []
STATE = {"completed": "completed", "in_progress": "in-progress"}

for path in sorted(glob.glob(os.path.join(sys.argv[1], "*.json")), key=order):
    try:
        with open(path) as fh:
            t = json.load(fh)
    except Exception:
        continue
    if not isinstance(t, dict) or "subject" not in t:
        continue
    status = t.get("status") or "pending"
    total += 1
    if status == "completed":
        done += 1
    elif status == "in_progress" and not active:
        active = t.get("activeForm") or t.get("subject") or ""
    items.append({"text": (t.get("subject") or "")[:200],
                  "state": STATE.get(status, "pending")})

if not total:
    raise SystemExit(0)

label = f"{done}/{total}" + (f" · {active}" if active else "")
print(f"{done / total:.4f}")
print(label[:120])
print(json.dumps(items, separators=(",", ":")))
PY
  )" || return 0

  frac="$(printf '%s\n' "$out" | sed -n 1p)"
  label="$(printf '%s\n' "$out" | sed -n 2p)"
  todos="$(printf '%s\n' "$out" | sed -n 3p)"
  [ -n "$frac" ] || return 0

  crew_cmux set-progress "$frac" --label "$label"
  [ -n "$todos" ] && crew_cmux todo set "$todos"

  # The pill carries the in-flight task, not the tool. Everything after "N/M · ".
  active="${label#* · }"
  if [ "$active" != "$label" ] && [ -n "$active" ]; then
    crew_cmux set-status claude "$active" --icon "list.bullet" --color "#4C8DFF"
  fi
}
