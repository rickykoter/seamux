#!/usr/bin/env python3
"""fakecmux — a stand-in cmux CLI for probes that run crew-sync without the app.

The workspace list lives in $FAKE_CMUX_DIR/workspaces.json; every call is
appended to $FAKE_CMUX_DIR/cmux.log; `workspace-action` set-color, clear-color
and set-description are applied to the list, so the next sync sees what the
last one did. Anything else succeeds and does nothing.

    CREW_CMUX=crew/tools/fakecmux.py FAKE_CMUX_DIR=/tmp/x crew/bin/crew-sync
"""
import json
import os
import sys

T = os.environ["FAKE_CMUX_DIR"]
db = os.path.join(T, "workspaces.json")
args = sys.argv[1:]
with open(os.path.join(T, "cmux.log"), "a") as fh:
    fh.write(" ".join(args) + "\n")
rows = json.load(open(db))
if args[:3] == ["workspace", "list", "--json"]:
    print(json.dumps({"workspaces": rows}))
elif args[:2] == ["workspace-action", "--action"]:
    act, opts = args[2], dict(zip(args[3::2], args[4::2]))
    for w in rows:
        if w["id"] == opts.get("--workspace"):
            if act == "set-color":
                w["custom_color"] = opts["--color"]
            elif act == "clear-color":
                w["custom_color"] = ""
            elif act == "set-description":
                w["description"] = opts["--description"]
            elif act == "clear-description":
                w["description"] = ""
    json.dump(rows, open(db, "w"))
