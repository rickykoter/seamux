#!/usr/bin/env python3
"""fakecmux — a stand-in cmux CLI for probes that run crew without the app.

The workspace list lives in $FAKE_CMUX_DIR/workspaces.json; every call is
appended to $FAKE_CMUX_DIR/cmux.log; `workspace-action` set-color, clear-color
and set-description are applied to the list (to $CMUX_WORKSPACE_ID's row when
no --workspace is given, as cmux does), so the next sync sees what the last
one did.

    workspace list --json [--window W]   the list (one window, whatever W is)
    list-windows --json                  one window
    workspace close <ws> [--force]       drops the row; a row with "process":
                                         true needs --force, as cmux does, and
                                         one with "close_fails": true never goes
    workspace create | new-workspace     appends a row, prints OK workspace:<n>
    sessions list --json                 $FAKE_CMUX_DIR/sessions.json, else none
    sidebar-state --workspace <ws>       cwd=, color= and claude_code= from the row
    tree --json                          one window; a row's "tty" is its terminal
    new-pane                             OK surface:900 pane:900 <workspace>

With $FAKE_CMUX_DIR/panes.json, one workspace's panes as a split tree, for
the Wake's split (crew-board-intent _wake_tab):

    {"ws": <id in front>, "width": <main area>, "focused": <surface>, "dock": [<surface>...],
     "trees": {<ws id>: <tree>}     (or "tree": <tree>, for ws alone)}
    <tree> = {"pane": <id>, "surfaces": [...]}
           | {"split": "h", "ratio": <of a>, "a": <tree>, "b": <tree>}

    Only ws, the workspace in front, is laid out; the others list no frames.
    Like cmux, the answers lag: tree names the old workspace for two reads
    after a select, and a new pane lists no frame on the first read.

    workspace select W                   W becomes ws
    tree --json                          "active" names that ws (and no windows)
    list-panes --json                    a frame per pane, the Dock pane unframed
    resize-pane --pane P -L --amount N   moves the divider of the nearest split
                                         holding P on its right side, and no
                                         other; the left side keeps MIN points
    new-pane --direction right           splits the focused surface's pane
    new-surface --pane P                 a tab in P; both print UUID-shaped ids
    focus-panel --panel S | close-surface --surface S | browser --surface S ...
                                         S must exist (the Dock counts)

For crew-listen and crew-feed (cli_probe):

    events --cursor-file F [--name N]... replays $FAKE_CMUX_DIR/events.jsonl, one
                                         JSON event per line with a "seq": those
                                         past the cursor and named by --name, then
                                         stores the last seq in F and exits
    rpc feed.list                        {"items": $FAKE_CMUX_DIR/feed.json}
    rpc feed.permission.reply <json>     {"ok": true}; the call is in the log
    workspace status --workspace <ws>    "override: " + the row's "override"
                                         ("none" when unset); `workspace status
                                         set` only logs

A leading --id-format is dropped; ids are whatever the file holds.

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
if args[:1] == ["--id-format"]:
    args = args[2:]
with open(os.path.join(T, "cmux.log"), "a") as fh:
    fh.write(" ".join(args) + "\n")
if os.environ.get("FAKE_CMUX_DELAY"):
    time.sleep(float(os.environ["FAKE_CMUX_DELAY"]))
rows = json.load(open(db)) if os.path.exists(db) else []


def named(w, handle):
    return handle in (w.get("id"), w.get("ref"))


def opts_of(argv):
    return dict(zip(argv[0::2], argv[1::2]))


PANES = os.path.join(T, "panes.json")
MIN = 80


def leaves(t):
    return [t] if "pane" in t else leaves(t["a"]) + leaves(t["b"])


def frames(t, x, w, out):
    if "pane" in t:
        out[t["pane"]] = (x, w)
    else:
        aw = w * t["ratio"]
        frames(t["a"], x, aw, out)
        frames(t["b"], x + aw, w - aw, out)
    return out


def path_to(t, pane, trail=()):
    """The splits from the root down to pane, each with the side taken."""
    if "pane" in t:
        return list(trail) if t["pane"] == pane else None
    return path_to(t["a"], pane, trail + ((t, "a"),)) or path_to(t["b"], pane, trail + ((t, "b"),))


def width_of(t, w, node):
    """node's width inside t laid out at w."""
    if t is node:
        return w
    if "pane" in t:
        return None
    aw = w * t["ratio"]
    return width_of(t["a"], aw, node) or width_of(t["b"], w - aw, node)


def holding(t, sid):
    return next((p for p in leaves(t) if sid in p["surfaces"]), None)


def panes_cmd():
    """Handle a pane verb against panes.json; None when it is not one."""
    if not os.path.exists(PANES):
        return None
    st = json.load(open(PANES))
    if "tree" in st:                             # one workspace, the one in front
        st["trees"] = {st["ws"]: st.pop("tree")}
    o = opts_of(args[1:])
    # The tree the call names with --workspace, else the one in front. Only the
    # one in front is laid out: a workspace off screen has no frames.
    named = o.get("--workspace") or st["ws"]
    t = st["trees"].get(named) or {"pane": "none-%s" % named, "surfaces": []}

    def save():
        json.dump(st, open(PANES, "w"))

    def exists(sid):
        return any(holding(tr, sid) for tr in st["trees"].values()) or sid in st.get("dock", [])

    if args[:2] == ["workspace", "select"]:
        if args[2] not in st["trees"]:
            print("Error: not_found: Workspace not found", file=sys.stderr)
            sys.exit(1)
        st["was"], st["stale"] = st["ws"], 2   # "active" lags a select by two reads
        st["ws"] = args[2]
        save()
        print("OK " + args[2])
    elif args[:2] == ["tree", "--json"]:
        active = st["ws"]
        if st.get("stale"):
            st["stale"] -= 1
            active = st["was"]
            save()
        print(json.dumps({"active": {"workspace_id": active, "surface_id": st.get("focused")},
                          "windows": []}))
    elif args[:1] == ["list-panes"]:
        shown = named == st["ws"]
        fr = frames(t, 0, st["width"], {})
        unlaid = st.pop("unlaid", None)          # a new pane has no frame on the first read
        if unlaid:
            save()
        out = [dict({"id": p["pane"], "ref": p["pane"], "surface_ids": p["surfaces"],
                     "selected_surface_id": (p["surfaces"] or [None])[0]},
                    **({"pixel_frame": {"x": fr[p["pane"]][0], "width": fr[p["pane"]][1],
                                        "y": 28, "height": 900}} if shown else {}))
               for p in leaves(t)]
        out = [dict(p, pixel_frame=None) if p["id"] == unlaid else p for p in out]
        if st.get("dock"):
            out.append({"id": "DOCK", "dock_scope": "global", "surface_ids": st["dock"]})
        print(json.dumps({"container_frame": {"width": st["width"] if shown else 0, "height": 900},
                          "panes": out}))
    elif args[:1] == ["resize-pane"]:
        trail = path_to(t, o.get("--pane"))
        if trail is None:
            print("Error: not_found: Pane not found", file=sys.stderr)
            sys.exit(1)
        # -L takes no value, so the pairs opts_of reads are off by one after it.
        amount = float(args[args.index("--amount") + 1]) if "--amount" in args else 1.0
        for node, side in reversed(trail):
            if side == "b" and "-L" in args:
                w = width_of(t, st["width"], node)
                aw = max(MIN, w * node["ratio"] - amount)
                node["ratio"] = min(node["ratio"], aw / w)
                break
        save()
        print("OK " + o["--pane"])
    elif args[:1] == ["new-pane"]:
        leaf = holding(t, st.get("focused"))
        n = 1 + sum(len(leaves(tr)) for tr in st["trees"].values())
        new, pane = "00000000-0000-4000-8000-%012d" % n, "00000000-0000-4000-9000-%012d" % n
        split = {"split": "h", "ratio": 0.5, "a": dict(leaf), "b": {"pane": pane, "surfaces": [new]}}
        leaf.clear()
        leaf.update(split)
        st["focused"] = new
        st["unlaid"] = pane
        save()
        print("OK %s %s %s" % (new, pane, st["ws"]))
    elif args[:1] == ["new-surface"]:
        leaf = next(p for p in leaves(t) if p["pane"] == o.get("--pane"))
        new = "00000000-0000-4000-a000-%012d" % (1 + sum(len(p["surfaces"]) for tr in st["trees"].values()
                                                         for p in leaves(tr)))
        leaf["surfaces"].append(new)
        save()
        print("OK %s %s %s" % (new, leaf["pane"], st["ws"]))
    elif args[:1] in (["focus-panel"], ["close-surface"]) or args[:2] == ["browser", "--surface"]:
        sid = o.get("--panel") or o.get("--surface") or args[2]
        if not exists(sid):
            print("Error: not_found: Surface not found", file=sys.stderr)
            sys.exit(1)
        if args[0] == "focus-panel":
            st["focused"] = sid
        elif args[0] == "close-surface":
            if sid in st.get("dock", []):
                st["dock"].remove(sid)
            else:
                next(holding(tr, sid) for tr in st["trees"].values() if holding(tr, sid))["surfaces"].remove(sid)
        save()
        print("OK " + sid)
    else:
        return None
    return True


if panes_cmd():
    pass
elif args[:3] == ["workspace", "list", "--json"]:
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
elif args[:2] == ["tree", "--json"]:
    # One window; a row's "tty" becomes its one terminal surface.
    print(json.dumps({"windows": [{"workspaces": [
        {"id": w["id"], "ref": w.get("ref"), "panes": [{"surfaces": (
            [{"type": "terminal", "tty": w["tty"]}] if w.get("tty") else [])}]}
        for w in rows]}]}))
elif args[:1] == ["new-pane"]:
    print("OK surface:900 pane:900 " + (opts_of(args[1:]).get("--workspace") or "workspace:1"))
elif args[:1] == ["sidebar-state"]:
    w = next((w for w in rows if named(w, opts_of(args[1:]).get("--workspace"))), None)
    if not w:
        sys.exit(1)
    print("cwd=" + (w.get("current_directory") or ""))
    print("color=" + (w.get("custom_color") or "none"))
    if w.get("claude"):
        print("  claude_code=" + w["claude"])
elif args[:1] == ["events"]:
    cur_file = args[args.index("--cursor-file") + 1] if "--cursor-file" in args else ""
    names = [args[i + 1] for i, a in enumerate(args[:-1]) if a == "--name"]
    try:
        cursor = int(open(cur_file).read().strip() or 0) if cur_file else 0
    except (OSError, ValueError):
        cursor = 0
    path = os.path.join(T, "events.jsonl")
    last = cursor
    for line in (open(path).read().splitlines() if os.path.exists(path) else []):
        if not line.strip():
            continue
        ev = json.loads(line)
        if ev.get("seq", 0) <= cursor or (names and ev.get("name") not in names):
            continue
        print(line, flush=True)
        last = max(last, ev.get("seq", 0))
    if cur_file:
        open(cur_file, "w").write(str(last))
elif args[:1] == ["rpc"]:
    if args[1:2] == ["feed.list"]:
        path = os.path.join(T, "feed.json")
        print(json.dumps({"items": json.load(open(path)) if os.path.exists(path) else []}))
    else:
        print(json.dumps({"ok": True}))
elif args[:2] == ["workspace", "status"] and args[2:3] != ["set"]:
    w = next((w for w in rows if named(w, opts_of(args[2:]).get("--workspace"))), None)
    if not w:
        print("Error: not_found: Workspace not found", file=sys.stderr)
        sys.exit(1)
    print("override: " + (w.get("override") or "none"))
elif args[:2] == ["workspace-action", "--action"]:
    act, opts = args[2], opts_of(args[3:])
    # Like cmux: no --workspace means the caller's own, from CMUX_WORKSPACE_ID.
    target = opts.get("--workspace") or os.environ.get("CMUX_WORKSPACE_ID")
    for w in rows:
        if named(w, target):
            if act == "set-color":
                w["custom_color"] = opts["--color"]
            elif act == "clear-color":
                w["custom_color"] = ""
            elif act == "set-description":
                w["description"] = opts["--description"]
            elif act == "clear-description":
                w["description"] = ""
    json.dump(rows, open(db, "w"))
