#!/usr/bin/env python3
"""Add the status line and the deep-plan gate to ~/.claude/settings.json.

    python3 merge_settings.py [--dry-run] [--settings PATH]

`crew apply` wires the crew hooks itself. These two are not crew's, so they are
here instead: the status line is a display choice, and the gate belongs to the
deep-plan skill and must not be wired if that skill is not installed -- a
PreToolUse hook pointing at a missing script fails on every edit, which is far
worse than having no gate.

Idempotent and additive only: it never removes or rewrites an entry it did not
add, it leaves an existing status line alone, and it backs the file up first.
"""
import json, os, shutil, sys, time

HOME = os.path.expanduser("~")
args = sys.argv[1:]
dry = "--dry-run" in args
path = os.path.join(HOME, ".claude", "settings.json")
if "--settings" in args:
    path = args[args.index("--settings") + 1]

GATE = os.path.join(HOME, ".claude", "skills", "deep-plan", "hooks", "gate.sh")
GUARD = os.path.join(HOME, ".claude", "hooks", "cmux", "guard_bash.sh")
STATUSLINE = os.path.join(HOME, ".claude", "statusline.py")
MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash"

s = {}
if os.path.exists(path):
    with open(path) as fh:
        s = json.load(fh)

changes = []

if not os.path.exists(STATUSLINE):
    changes.append("SKIPPED: no ~/.claude/statusline.py (run install.sh first)")
elif not s.get("statusLine"):
    s["statusLine"] = {"type": "command", "command": f"python3 {STATUSLINE}"}
    changes.append("statusLine -> statusline.py")
elif STATUSLINE in json.dumps(s["statusLine"]):
    changes.append("already set: statusLine")
else:
    changes.append("LEFT ALONE: you already have a status line — "
                   f"point it at {STATUSLINE} by hand if you want this one")

# Phone pushes for the board's "attend" tier: agentPushNotifEnabled covers
# task-done pushes, inputNeededNotifEnabled covers permission prompts and
# questions — the "waiting on a human" moments the crew board ranks first.
# Only ever set to true when absent; an explicit false is the user's choice.
for key in ("agentPushNotifEnabled", "inputNeededNotifEnabled"):
    if key not in s:
        s[key] = True
        changes.append(f"{key} -> true (phone push via Remote Control)")
    else:
        changes.append(f"already set: {key}")

hooks = s.setdefault("hooks", {})
if not os.path.exists(GATE):
    changes.append("SKIPPED: no deep-plan skill here, so no gate hook (see deep-plan/TIE-INS.md)")
else:
    pre = hooks.setdefault("PreToolUse", [])
    if any(GATE in (h.get("command") or "") for m in pre for h in m.get("hooks", [])):
        changes.append("already wired: deep-plan gate")
    else:
        entry = {"type": "command", "command": f'bash "{GATE}"'}
        slot = [m for m in pre if m.get("matcher") == MATCHER]
        if slot:
            slot[0].setdefault("hooks", []).append(entry)
        else:
            pre.append({"matcher": MATCHER, "hooks": [entry]})
        changes.append("PreToolUse -> deep-plan gate")

# The destructive-command guard, wired separately from crew on purpose: `crew
# off` must not turn it off.
if not os.path.exists(GUARD):
    changes.append("SKIPPED: no guard_bash.sh (run install.sh first)")
else:
    pre = hooks.setdefault("PreToolUse", [])
    if any("guard_bash.sh" in (h.get("command") or "") for m in pre for h in m.get("hooks", [])):
        changes.append("already wired: guard_bash")
    else:
        entry = {"type": "command", "command": f'bash "{GUARD}"', "timeout": 5,
                 "statusMessage": "Checking for destructive shell commands..."}
        slot = [m for m in pre if m.get("matcher") == "Bash"]
        if slot:
            slot[0].setdefault("hooks", []).append(entry)
        else:
            pre.append({"matcher": "Bash", "hooks": [entry]})
        changes.append("PreToolUse -> guard_bash")

for c in changes:
    print("  " + c)

wrote = any(c.startswith(("statusLine ->", "PreToolUse ->",
                          "agentPushNotifEnabled ->", "inputNeededNotifEnabled ->"))
            for c in changes)
if dry:
    print("\n--dry-run: nothing written")
elif wrote:
    if os.path.exists(path):
        bak = f"{path}.pre-crew-dock.{time.strftime('%Y%m%d-%H%M%S')}.bak"
        shutil.copy2(path, bak)
        print(f"\nbacked up -> {os.path.basename(bak)}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(s, fh, indent=2)
        fh.write("\n")
    print(f"wrote {path}")
    print("New Claude sessions pick these up; existing ones do not.")
