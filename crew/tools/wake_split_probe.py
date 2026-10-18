#!/usr/bin/env python3
"""wake_split_probe — the Wake's split, against fakecmux's pane tree.

crew-board-intent opens the Wake, and whatever it opens, in a split at the
right of the workspace in front, focused and widened to WAKE_SHARE of the main
area. resize-pane moves one divider and never passes the rest on, so this
checks the widening reaches the share through nested splits, that a second
click reuses the tab, that the Wake and what it opens stay in their own tab
group, one per workspace, that a row's Wake switches to the row's workspace
first, and that a tab left in the Dock by an older crew is closed.

    python3 crew/tools/wake_split_probe.py
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
tmp = tempfile.mkdtemp(prefix="wake-split-")
os.environ.update(HOME=tmp, FAKE_CMUX_DIR=tmp, CREW_CMUX=os.path.join(HERE, "fakecmux.py"))
loader = importlib.machinery.SourceFileLoader("intent", os.path.join(ROOT, "board", "crew-board-intent"))
spec = importlib.util.spec_from_loader("intent", loader)
I = importlib.util.module_from_spec(spec)
loader.exec_module(I)

PANES = os.path.join(tmp, "panes.json")
WS1, WS2 = "00000000-0000-4000-b000-000000000001", "00000000-0000-4000-b000-000000000002"
LOG = os.path.join(tmp, "cmux.log")
checks = []


def layout(trees, ws=WS1, focused="T1", dock=(), width=1000):
    json.dump({"ws": ws, "width": width, "focused": focused, "dock": list(dock), "trees": trees},
              open(PANES, "w"))
    open(LOG, "w").close()


def state():
    return json.load(open(PANES))


def wake_width(sid, ws=WS1):
    width, panes = I._main_panes(ws)
    p = I._pane_of(panes, sid)
    return p["pixel_frame"]["width"] / width if p else 0


def kept(name, ws=WS1):
    return I._read_keep(name, ws)


def pane_of(sid, ws=WS1):
    return (I._pane_of(I._main_panes(ws)[1], sid) or {}).get("id")


def legacy(name, sid):
    with open(I._keep_path(name), "w") as fh:
        fh.write(sid + "\n")


def log():
    return open(LOG).read()


TWO = {"split": "h", "ratio": 0.4, "a": {"pane": "P1", "surfaces": ["T1"]},
       "b": {"pane": "P2", "surfaces": ["T2"]}}
URL = "http://127.0.0.1:1/artifacts?ws=x"

# Two panes side by side, the left one focused: the Wake splits the RIGHT one,
# since new-pane splits whatever is focused.
os.makedirs(I.STATE_DIR, exist_ok=True)
layout({WS1: json.loads(json.dumps(TWO)), WS2: {"pane": "Q1", "surfaces": ["U1"]}})
ok, detail = I._wake_tab(I.WAKE_TAB, URL)
sid = kept(I.WAKE_TAB)
checks.append(("a first click opens one split, keeps its surface for this workspace, and focuses it",
               ok and sid and state()["focused"] == sid and log().count("new-pane") == 1))
checks.append(("...cut from the rightmost pane, not the focused one",
               "focus-panel --panel T2" in log().split("new-pane")[0]))
checks.append(("...never asking the pane at the left edge to move a divider it does not have",
               "resize-pane --pane P1 " not in log()))
checks.append(("...and widened to at least 80%% through nested splits (%.2f)" % wake_width(sid),
               wake_width(sid) >= I.WAKE_SHARE - 0.01))

# Narrowed by hand, then clicked again: the same tab, navigated, widened again.
st = state()
st["trees"][WS1]["ratio"] = 0.6
json.dump(st, open(PANES, "w"))
open(LOG, "w").close()
narrow = wake_width(sid)
ok, detail = I._wake_tab(I.WAKE_TAB, URL + "y")
checks.append(("a second click navigates the same tab and stacks nothing",
               ok and kept(I.WAKE_TAB) == sid and "new-pane" not in log() and "new-surface" not in log() and
               ("browser --surface %s goto %sy" % (sid, URL)) in log()))
checks.append(("...focuses it, and widens it back (%.2f -> %.2f)" % (narrow, wake_width(sid)),
               state()["focused"] == sid and narrow < 0.8 and wake_width(sid) >= I.WAKE_SHARE - 0.01))

# What the Wake opens goes into its group, as a tab in the same pane.
open(LOG, "w").close()
ok, detail = I._wake_tab(I.WAKE_VIEW, "file:///tmp/a.png")
view = kept(I.WAKE_VIEW)
checks.append(("the Wake's view is a tab in the Wake's own group, focused, with no new split",
               ok and view and view != sid and pane_of(view) == pane_of(sid) and
               "new-pane" not in log() and state()["focused"] == view))
group = pane_of(sid)

# A row in another workspace: switch there, and give it a group of its own.
# The first workspace's group is left alone.
open(LOG, "w").close()
ok, detail = I._wake_tab(I.WAKE_TAB, URL, select=WS2)
two = kept(I.WAKE_TAB, WS2)
lines = log().splitlines()
checks.append(("a row's Wake switches to the row's workspace before anything else",
               ok and lines[0] == "workspace select " + WS2 and state()["ws"] == WS2))
checks.append(("...and opens a group of its own there, widened, not the other workspace's tab",
               two and two != sid and pane_of(two, WS2) and wake_width(two, WS2) >= I.WAKE_SHARE - 0.01))
checks.append(("...leaving the first workspace's group where it was",
               "close-surface" not in log() and kept(I.WAKE_TAB) == sid and kept(I.WAKE_VIEW) == view))

# Back to the first: its own group again, nothing new.
open(LOG, "w").close()
ok, detail = I._wake_tab(I.WAKE_VIEW, "file:///tmp/b.png", select=WS1)
checks.append(("back in the first workspace, the view reuses that workspace's group",
               ok and kept(I.WAKE_VIEW) == view and "new-pane" not in log() and "new-surface" not in log() and
               pane_of(view) == group))

# The view dragged out of the group: the next view opens in the group, and
# the dragged tab is left where it was put.
def drop(t, sid):
    if "pane" in t:
        if sid in t["surfaces"]:
            t["surfaces"].remove(sid)
    else:
        drop(t["a"], sid)
        drop(t["b"], sid)


st = state()
drop(st["trees"][WS1], view)
st["trees"][WS1] = {"split": "h", "ratio": 0.9, "a": st["trees"][WS1],
                      "b": {"pane": "P9", "surfaces": [view]}}
json.dump(st, open(PANES, "w"))
open(LOG, "w").close()
ok, detail = I._wake_tab(I.WAKE_VIEW, "file:///tmp/c.png")
checks.append(("a view dragged out of the group is left there, and the next opens in the group",
               ok and kept(I.WAKE_VIEW) not in ("", view) and pane_of(kept(I.WAKE_VIEW)) == group and
               pane_of(view) == "P9" and "close-surface" not in log()))

# A Wake tab an older crew kept in the Dock: closed, and its file dropped.
for name in (I.WAKE_TAB, I.WAKE_VIEW):
    for ws in (WS1, WS2):
        if os.path.exists(I._keep_path(name, ws)):
            os.remove(I._keep_path(name, ws))
legacy(I.WAKE_TAB, "D-old")
layout({WS1: {"pane": "P1", "surfaces": ["T1"]}}, dock=["D-board", "D-old"])
ok, detail = I._wake_tab(I.WAKE_TAB, URL)
new = kept(I.WAKE_TAB)
checks.append(("an older crew's Dock tab is closed, its file dropped, and the Wake opens in a split",
               ok and new and new != "D-old" and state()["dock"] == ["D-board"] and
               "close-surface --surface D-old" in log() and not os.path.exists(I._keep_path(I.WAKE_TAB)) and
               wake_width(new) >= I.WAKE_SHARE - 0.01))

# A kept id cmux no longer knows is simply replaced.
with open(I._keep_path(I.WAKE_TAB, WS1), "w") as fh:
    fh.write("gone\n")
layout({WS1: {"pane": "P1", "surfaces": ["T1"]}})
ok, detail = I._wake_tab(I.WAKE_TAB, URL)
checks.append(("a kept id cmux no longer knows is replaced, nothing closed",
               ok and kept(I.WAKE_TAB) not in ("", "gone") and "close-surface" not in log()))

# cmux not answering which workspace is in front: a reason, not a guess.
os.remove(PANES)
ok, detail = I._wake_tab(I.WAKE_TAB, URL)
checks.append(("no workspace in front is a failure with a reason", not ok and "workspace" in detail))

failed = [n for n, good in checks if not good]
for n, good in checks:
    print(("  ok   " if good else "  FAIL ") + n)
print("wake split probe: %d passed, %d failed" % (len(checks) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
