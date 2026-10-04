#!/usr/bin/env python3
"""Point Claude's status line at crew's, and turn on the phone pushes.

    python3 merge_settings.py [--dry-run] [--settings PATH] [--remove]

`crew apply` runs this from the live tree (~/.config/cmux/crew/claude/). It
exists because a plugin cannot set either thing: plugin `settings` honours only
`agent` and `subagentStatusLine`, so `statusLine` and the two notification
flags still have to be merged into ~/.claude/settings.json.

It no longer wires hooks. The deep-plan gate, the destructive-command guard and
crew's own hooks each ship in their plugin's hooks/hooks.json.

The status line it sets is the statusline.py beside this file, so it runs from
the live tree, at a path that never moves. One the old installer set at
~/.claude/statusline.py is ours too, and is repointed; any other status line is
yours and is left alone.

`--remove` undoes what this adds: the status line, if it is one of ours. It
leaves the notification flags (you may have come to rely on them).

Idempotent and additive: it never rewrites an entry it did not add, and it
backs the file up before writing.
"""
import json, os, shutil, sys, time

HOME = os.path.expanduser("~")
args = sys.argv[1:]
dry = "--dry-run" in args
path = os.path.join(HOME, ".claude", "settings.json")
if "--settings" in args:
    path = args[args.index("--settings") + 1]

STATUSLINE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "statusline.py")
LEGACY_STATUSLINE = os.path.join(HOME, ".claude", "statusline.py")
COMMAND = f"python3 {STATUSLINE}"


def ours(status_line):
    """Is this status line one crew set (here, or the old installer's)?"""
    text = json.dumps(status_line or {})
    return (STATUSLINE in text or LEGACY_STATUSLINE in text
            or "/crew/claude/statusline.py" in text)


s = {}
if os.path.exists(path):
    with open(path) as fh:
        s = json.load(fh)

changes = []

if "--remove" in args:
    if s.get("statusLine") and ours(s["statusLine"]):
        del s["statusLine"]
        changes.append("removed: statusLine")
    for c in changes or ["nothing of ours found in " + path]:
        print("  " + c)
    if dry:
        print("\n--dry-run: nothing written")
    elif changes:
        bak = f"{path}.pre-uninstall.{time.strftime('%Y%m%d-%H%M%S')}.bak"
        shutil.copy2(path, bak)
        with open(path, "w") as fh:
            json.dump(s, fh, indent=2)
            fh.write("\n")
        print(f"\nbacked up -> {os.path.basename(bak)}, wrote {path}")
    sys.exit(0)

current = s.get("statusLine")
if not os.path.exists(STATUSLINE):
    changes.append(f"SKIPPED: no {STATUSLINE}")
elif not current:
    s["statusLine"] = {"type": "command", "command": COMMAND}
    changes.append("statusLine -> crew's statusline.py")
elif (current or {}).get("command") == COMMAND:
    changes.append("already set: statusLine")
elif ours(current):
    s["statusLine"] = {**current, "type": "command", "command": COMMAND}
    changes.append("statusLine -> crew's statusline.py (repointed from the old copy)")
else:
    changes.append("LEFT ALONE: you already have a status line — "
                   f"set it to `{COMMAND}` by hand if you want this one")

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

for c in changes:
    print("  " + c)

wrote = any(c.startswith(("statusLine ->", "agentPushNotifEnabled ->",
                          "inputNeededNotifEnabled ->")) for c in changes)
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
