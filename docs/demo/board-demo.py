#!/usr/bin/env python3
"""board-demo — push the README's demo cast into the LIVE crew board.

    python3 docs/demo/board-demo.py            one push (scene 1), then exit
    python3 docs/demo/board-demo.py --loop     cycle the whole timeline until ^C
    python3 docs/demo/board-demo.py --restore  put the real workspaces back

For screenshots and screen recordings of the board inside cmux. Everything is
fake but the pipeline is real: the same push path the collector uses, so the
ranking animation, the ripple, the cat and the chips all behave exactly as
shipped. Claude Code activity also pushes real state on its hooks, so use
--loop while recording — the demo re-pushes every few seconds and wins.

The two attend rows carry the `example-outbox-retry` slug (render it first:
`node ~/.claude/skills/deep-plan/deep_plan.mjs render deep-plan/examples/example.spec.json`)
so their plan chips open a real review page. Rows without a workspace ref are
inert to clicks — deliberately: these workspaces don't exist.

Restore is just a normal collector push; nothing here writes anything the next
real push doesn't overwrite.

Demoing the ADR / contracts flow (needs the plan rendered as above, with
--root at a repo that has a docs/adr tree):
  1. open the plan chip — the review page now shows Contracts, a draft ADR
     with in-page Edit, and an "add an ADR" chip on unflagged decisions
  2. answer the check (this render: q1=a q2=c q3=d), Copy for session,
     paste it back — `deep-plan grade` passes and the Dock tab becomes the
     working surface
  3. `deep-plan adr apply example-outbox-retry` writes the approved ADR into
     docs/adr/ at the next free number (refused while still in review)
Undo after recording: `deep-plan close example-outbox-retry`, delete the
applied docs/adr file if you don't want it, `--restore` for the board.
"""

import importlib.machinery
import importlib.util
import os
import sys
import time

BOARD = os.path.expanduser("~/.config/cmux/crew/board/crew-board")
loader = importlib.machinery.SourceFileLoader("crew_board", BOARD)
spec = importlib.util.spec_from_loader("crew_board", loader)
cb = importlib.util.module_from_spec(spec)
loader.exec_module(cb)

PLAN_SLUG = "example-outbox-retry"

# One row is REAL: checkout-flow borrows this machine's first live workspace
# (ref, cwd, Peacock colour) so the VS Code tie-ins work on camera — the branch
# fact opens the worktree in a Peacock-painted window, `jump` switches to the
# workspace, and the row's inner stripe matches that title bar. The other rows
# stay fake and inert.
import subprocess

def real_workspace():
    try:
        out = subprocess.run([BOARD, "state", "--json"], capture_output=True,
                             text=True, timeout=30).stdout
        for r in json_mod.loads(out).get("rows", []):
            if r.get("cwd") and r.get("ref"):
                return {k: r[k] for k in ("ref", "cwd", "color") if r.get(k)}
    except Exception:
        pass
    return {}

import json as json_mod
REAL = real_workspace()
COLORS = {"checkout-flow": "#dfa000", "rate-limits": "#d699b6",
          "search-index": "#83c092", "login-copy": "#e69875",
          "payments-idem": "#7fbbb3"}


def row(**o):
    o.setdefault("color", COLORS.get(o["id"]))
    return o


QUIET = [
    row(id="docs-site", kind="quiet", name="docs-site — zsh", badge="", frac=None,
        branch="dev/docs-site"),
    row(id="spike-cache", kind="quiet", name="spike-cache — idle 3h", badge="",
        frac=None, branch="dev/spike-cache"),
]

LOGIN = row(id="login-copy", kind="done", name="login-copy", badge="MERGED",
            said="Merged — {{reclaim}} when ready.", frac=1,
            branch="dev/login-copy", pr="#137", cost=2.05,
            chips=["jump"], meta="4/4 increments")


def checkout(state):
    if state == "attend":
        return row(id="checkout-flow", kind="attend", name="checkout-flow",
                   badge="PLAN GATE", slug=PLAN_SLUG,
                   said="Increment 3 ready — {{go 3}} authorizes `coupon at capture`.",
                   frac=0.5, branch="dev/checkout-flow", dirty=True, pr="#142",
                   pr_state="open", cost=4.20, chips=["go 3", "plan", "diff", "jump"],
                   meta="2/4 increments · checkout-flow", **REAL)
    return row(id="checkout-flow", kind="running", name="checkout-flow",
               badge="WORKING", slug=PLAN_SLUG,
               said="Increment 3 authorized — applying `coupon at capture`.",
               frac=None, branch="dev/checkout-flow", dirty=True, pr="#142",
               pr_state="open", cost=4.31, chips=["plan", "diff", "jump"],
               meta="3/4 increments · checkout-flow", **REAL)


def ratelimits(state):
    if state == "wilt":
        return row(id="rate-limits", kind="wilt", name="rate-limits",
                   badge="CHECKS RED", said="Checks are red on `dev/rate-limits`.",
                   frac=0.75, branch="dev/rate-limits", pr="#139", pr_state="open",
                   cost=11.87, chips=["checks", "diff", "jump"],
                   meta="3/4 increments")
    return row(id="rate-limits", kind="done", name="rate-limits",
               badge="CHECKS GREEN", said="Checks green — {{ready to merge}}.",
               frac=1, branch="dev/rate-limits", pr="#139", pr_state="open",
               cost=12.02, chips=["jump"], meta="4/4 increments")


def search(frac, said, kind="running"):
    done = kind == "done"
    return row(id="search-index", kind=kind, name="search-index",
               badge="DONE" if done else "WORKING", said=said, frac=frac,
               branch="dev/search-index", dirty=not done,
               pr="#145" if done else "", pr_state="open", cost=0.62,
               chips=["jump"] if done else ["diff", "jump"],
               meta=("4/4" if done else "2/4" if frac >= 0.5 else "1/4") +
                    " increments")


def payments():
    return row(id="payments-idem", kind="attend", name="payments-idem",
               badge="QUESTION", slug=PLAN_SLUG,
               said="Reuse the idempotency table, or a new ledger? "
                    "The {{plan}} carries the trade-off.",
               frac=None, branch="dev/payments-idem", cost=1.14,
               chips=["take the check", "plan"], meta="alignment check pending",
               feedby=int(time.time()) + 95)


def snap(rows):
    return {"rows": rows, "quiet": "", "src": "demo data · board-demo.py",
            "stamp": "just now", "stale": False}


SCENES = [
    (0, lambda: snap([checkout("attend"), ratelimits("wilt"),
        search(0.25, "Inc 2 in progress — building the tokenizer."), LOGIN] + QUIET)),
    (5, lambda: snap([checkout("attend"), ratelimits("wilt"),
        search(0.5, "Inc 2 — tokenizer wired, tests running."), LOGIN] + QUIET)),
    (5, lambda: snap([checkout("attend"), ratelimits("wilt"),
        search(1, "Done — all four increments landed, PR opened.", "done"), LOGIN] + QUIET)),
    (5, lambda: snap([payments(), checkout("running"), ratelimits("wilt"),
        search(1, "Done — all four increments landed, PR opened.", "done"), LOGIN] + QUIET)),
    (5, lambda: snap([payments(), checkout("running"), ratelimits("done"),
        search(1, "Done — all four increments landed, PR opened.", "done"), LOGIN] + QUIET)),
]


# Demo pushes carry the flag that lets them through the hold they set.
os.environ["CREW_DEMO_PUSH"] = "1"
HOLD = os.path.join(cb.STATE_DIR, "demo-hold")


def hold_on():
    os.makedirs(cb.STATE_DIR, exist_ok=True)
    with open(HOLD, "w") as fh:
        fh.write("set by board-demo.py\n")


def hold_off():
    try:
        os.unlink(HOLD)
    except OSError:
        pass


def main():
    if "--restore" in sys.argv:
        hold_off()
        sys.exit(os.system(os.path.expanduser("~/.local/bin/crew-board") + " push"))
    if "--loop" in sys.argv:
        print("cycling demo scenes until ^C — real pushes are held off; record now")
        try:
            while True:
                hold_on()          # refreshed each lap: the hold expires after 1h
                for delay, scene in SCENES:
                    time.sleep(delay)
                    cb.push_state(scene())
                time.sleep(8)
        except KeyboardInterrupt:
            hold_off()
            print("\nhold released. restore real data with: python3 %s --restore"
                  % sys.argv[0])
        return
    hold_on()
    cb.push_state(SCENES[0][1]())
    print("pushed scene 1; real pushes are held off (auto-expires in 1h).")
    print("--loop cycles the timeline; --restore lifts the hold and puts real data back")


if __name__ == "__main__":
    main()
