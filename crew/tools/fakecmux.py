#!/usr/bin/env python3
"""fakecmux — a stand-in cmux CLI for probes that run crew without the app.

The workspace list lives in $FAKE_CMUX_DIR/workspaces.json; every call is
appended to $FAKE_CMUX_DIR/cmux.log; `workspace-action` set-color, clear-color
and set-description are applied to the list, so the next sync sees what the
last one did.

    workspace list --json [--window W]   the list (one window, whatever W is)
    list-windows --json                  one window
    workspace close <ws> [--force]       drops the row; a row with "process":
                                         true needs --force, as cmux does, and
                                         one with "close_fails": true never goes
    workspace create | new-workspace     appends a row, prints OK workspace:<n>
    sessions list --json                 $FAKE_CMUX_DIR/sessions.json, else none
    sidebar-state --workspace <ws>       cwd= and claude_code= from the row

$FAKE_CMUX_DELAY (seconds) sleeps before every call, for hook-budget probes.
Anything else succeeds and does nothing.

    CREW_CMUX=crew/tools/fakecmux.py FAKE_CMUX_DIR=/tmp/x crew/bin/crew-sync
"""
import json
import os
import sys
import time

T = os.environ["FAKE_CMUX_DIR"]
db = os.path.join(T, "workspaces.json")
args = sys.argv[1:]
with open(os.path.join(T, "cmux.log"), "a") as fh:
    fh.write(" ".join(args) + "\n")
if os.environ.get("FAKE_CMUX_DELAY"):
    time.sleep(float(os.environ["FAKE_CMUX_DELAY"]))
rows = json.load(open(db))


def named(w, handle):
    return handle in (w.get("id"), w.get("ref"))


def opts_of(argv):
    return dict(zip(argv[0::2], argv[1::2]))


if args[:3] == ["workspace", "list", "--json"]:
    print(json.dumps({"window_ref": "window:1", "workspaces": rows}))
elif args[:2] == ["list-windows", "--json"]:
    print(json.dumps([{"id": "W1", "index": 0}]))
elif args[:2] == ["sessions", "list"]:
    path = os.path.join(T, "sessions.json")
    print(open(path).read() if os.path.exists(path) else json.dumps({"sessions": []}))
elif args[:2] == ["workspace", "close"] or args[:1] == ["close-workspace"]:
    rest = args[2:] if args[0] == "workspace" else args[1:]
    force = "--force" in rest
    rest = [a for a in rest if a != "--force"]
    handle = opts_of(rest).get("--workspace") or (rest[0] if rest else "")
    w = next((w for w in rows if named(w, handle)), None)
    if not w:
        print("Error: not_found: Workspace not found", file=sys.stderr)
        sys.exit(1)
    if w.get("close_fails"):
        print("Error: internal: close failed", file=sys.stderr)
        sys.exit(1)
    if w.get("process") and not force:
        print("Error: confirmation_required: Workspace has a running process; retry with --force",
              file=sys.stderr)
        sys.exit(1)
    rows.remove(w)
    json.dump(rows, open(db, "w"))
    print("OK " + (w.get("ref") or w["id"]))
elif args[:2] == ["workspace", "create"] or args[:1] == ["new-workspace"]:
    o = opts_of(args[2:] if args[0] == "workspace" else args[1:])
    n = 1 + max([int((w.get("ref") or "workspace:0").split(":")[-1] or 0) for w in rows] + [100])
    ref = "workspace:%d" % n
    cwd = o.get("--cwd", "")
    rows.append({"id": "ws-new-%d" % n, "ref": ref, "title": o.get("--name") or os.path.basename(cwd),
                 "current_directory": cwd, "custom_color": "", "description": "",
                 "command": o.get("--command", "")})
    json.dump(rows, open(db, "w"))
    print("OK " + ref)
elif args[:1] == ["sidebar-state"]:
    w = next((w for w in rows if named(w, opts_of(args[1:]).get("--workspace"))), None)
    if not w:
        sys.exit(1)
    print("cwd=" + (w.get("current_directory") or ""))
    if w.get("claude"):
        print("  claude_code=" + w["claude"])
elif args[:2] == ["workspace-action", "--action"]:
    act, opts = args[2], opts_of(args[3:])
    for w in rows:
        if named(w, opts.get("--workspace")):
            if act == "set-color":
                w["custom_color"] = opts["--color"]
            elif act == "clear-color":
                w["custom_color"] = ""
            elif act == "set-description":
                w["description"] = opts["--description"]
            elif act == "clear-description":
                w["description"] = ""
    json.dump(rows, open(db, "w"))
