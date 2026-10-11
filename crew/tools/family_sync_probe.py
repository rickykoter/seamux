#!/usr/bin/env python3
"""family_sync_probe — a deep-plan family through the real crew-sync and
crew-color, against a fake cmux. No app, no network, no real plans or colors.

The family comes from deep-plan/tools/family-fixture.sh: a parent checkout and
two worktrees (api, ui), each with a plan. Four fake workspaces sit on them
plus a bystander repo. What is asserted:

  - the first sync tags each member family:/famrole:, keeps the parent's
    color, gives each child a shade of it, and leaves the bystander alone;
  - Peacock follows where it already colors a worktree (api), and only there;
  - a crew-feed ask (feed:*) on the bystander survives the sync;
  - the bystander's sandbox, registered under a path with a space, is found;
  - a second sync sets no color (it is idempotent);
  - after the parent closes, the next sync gives each child its color from
    before (api its teal, ui none) and drops the tokens;
  - two overlapping syncs send one banner for one PR transition (the run lock);
  - the machine's deep-plan engine pointer is not moved to this checkout.

    python3 crew/tools/family_sync_probe.py      exit 0 when all hold
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
results = []


def check(name, cond, extra=""):
    results.append(cond)
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


# The fixture runs this checkout's engine, and every run refreshes the
# machine-wide engine pointer to the copy that ran unless DEEP_PLAN_ENGINE_FILE
# says otherwise. Run from a worktree, that repointed the machine's deep-plan
# at it. The fixture keeps its pointer in its own dir; this holds it to that.
# What is checked is the leak's own mark, the pointer newly naming this
# checkout's engine: another session may rewrite the pointer to its own copy
# meanwhile, and that is not this run's doing.
POINTER = os.path.join(os.path.expanduser("~"), ".claude", "deep-plan", "engine.json")
ENGINE = os.path.realpath(os.path.join(REPO, "deep-plan"))


def pointer_root():
    try:
        with open(POINTER) as fh:
            root = json.load(fh).get("root") or ""
    except (OSError, ValueError, AttributeError):
        return None
    return os.path.realpath(root) if root else None


root_before = pointer_root()

with tempfile.TemporaryDirectory(prefix="family-sync-") as t:
    t = os.path.realpath(t)
    # The fixture prints the shell it used; let bash evaluate it and hand back
    # the environment, rather than parsing shell here.
    fixture = os.path.join(REPO, "deep-plan", "tools", "family-fixture.sh")
    fx = subprocess.run(["bash", "-c", 'eval "$(bash "$0" "$1")" && env -0', fixture, os.path.join(t, "fx")],
                        capture_output=True, text=True)
    if fx.returncode:
        sys.exit("fixture failed:\n" + fx.stderr)
    env = dict(kv.split("=", 1) for kv in fx.stdout.split("\0") if "=" in kv)
    P, A, U = env["FIX_PARENT"], env["FIX_API"], env["FIX_UI"]
    # A space in the bystander's path, registered as a sandbox the way
    # crew-sandbox writes it (printf %q), so the registry has to be unquoted.
    X = os.path.join(t, "by stander")
    os.makedirs(X)
    subprocess.run(["git", "init", "-q"], cwd=X, check=True)
    reg = os.path.join(t, "cache", "cmux-crew", "sandbox", "roots")
    os.makedirs(reg)
    with open(os.path.join(reg, "bystander"), "w") as fh:
        fh.write("NAME=crew-by-stander\n" + subprocess.run(
            ["bash", "-c", 'printf "ROOT=%q\\n" "$0"', X], capture_output=True, text=True).stdout)
    os.makedirs(os.path.join(A, ".vscode"))
    json.dump({"peacock.color": "#006B6B"}, open(os.path.join(A, ".vscode", "settings.json"), "w"))
    env.update(FAKE_CMUX_DIR=t, CREW_CMUX=os.path.join(HERE, "fakecmux.py"),
               CREW_SBX=os.path.join(t, "no-sbx"),
               XDG_CACHE_HOME=os.path.join(t, "cache"))
    mk = lambda i, cwd, color: {"id": i, "title": i, "current_directory": cwd, "custom_color": color,
                                "description": "", "has_custom_title": True}
    # The bystander carries a pending crew-feed ask: sync must leave it alone.
    json.dump([mk("ws-parent", P, "#1565C0"), mk("ws-api", A, "#006B6B"), mk("ws-ui", U, ""),
               dict(mk("ws-x", X, "#7D6608"), description="feed:perm feedby:9999999999 feedgate:allow")],
              open(os.path.join(t, "workspaces.json"), "w"))

    def sync():
        subprocess.run([sys.executable, os.path.join(REPO, "crew", "bin", "crew-sync")],
                       env=env, capture_output=True, text=True, timeout=180)
        return {w["id"]: w for w in json.load(open(os.path.join(t, "workspaces.json")))}

    def peacock():
        return json.load(open(os.path.join(A, ".vscode", "settings.json"))).get("peacock.color", "")

    def toks(w):
        return {x for x in (w.get("description") or "").split() if x.startswith(("family:", "famrole:"))}

    w = sync()
    check("members are tagged with their family and role",
          toks(w["ws-parent"]) == {"family:example-auth-revamp", "famrole:parent"} and
          toks(w["ws-api"]) == {"family:example-auth-revamp", "famrole:child"} and
          toks(w["ws-ui"]) == {"family:example-auth-revamp", "famrole:child"}, json.dumps(w))
    check("the parent keeps its color", w["ws-parent"]["custom_color"] == "#1565C0")
    kids = {w["ws-api"]["custom_color"], w["ws-ui"]["custom_color"]}
    check("each child wears its own shade, not its old color",
          len(kids) == 2 and "#006B6B" not in kids and "" not in kids and "#1565C0" not in kids, str(kids))
    check("the bystander is untouched", w["ws-x"]["custom_color"] == "#7D6608" and not toks(w["ws-x"]))
    check("crew-feed's ask survives the sync",
          {"feed:perm", "feedby:9999999999", "feedgate:allow"} <= set(w["ws-x"]["description"].split()),
          w["ws-x"]["description"])
    check("a sandbox registered under a path with a space is found",
          "sandbox:stopped" in w["ws-x"]["description"].split(), w["ws-x"]["description"])
    check("Peacock follows the shade where it already colored the worktree",
          peacock() == w["ws-api"]["custom_color"], peacock())
    check("Peacock is not created where it was not", not os.path.exists(os.path.join(U, ".vscode")))
    sets = open(os.path.join(t, "cmux.log")).read().count("set-color")
    sync()
    check("a second sync sets no color", open(os.path.join(t, "cmux.log")).read().count("set-color") == sets)

    subprocess.run(["node", os.path.join(REPO, "deep-plan", "deep_plan.mjs"), "close", "example-auth-revamp"],
                   env=env, capture_output=True)
    w = sync()
    check("a closed family gives each child its color from before",
          w["ws-api"]["custom_color"] == "#006B6B" and w["ws-ui"]["custom_color"] == "", json.dumps(w))
    check("…and Peacock its color from before", peacock() == "#006B6B", peacock())
    check("…and drops the family tokens", not any(toks(x) for x in w.values()))

    # Two overlapping syncs (the Stop hook and the listener's tick, say) see one
    # PR transition: one banner, not two. A slow fake gh holds both runs between
    # reading the last-notified signature and writing the new one, which is
    # exactly where they used to race. The cache is seeded stale, so gh is asked.
    import hashlib
    gh_bin = os.path.join(t, "bin")
    os.makedirs(gh_bin)
    with open(os.path.join(gh_bin, "gh"), "w") as fh:
        fh.write('#!/bin/sh\n[ "$(pwd -P)" = "$FAKE_GH_CWD" ] || '
                 '{ echo "no pull requests found for branch" >&2; exit 1; }\nsleep 2\n'
                 "echo '" + json.dumps({
                     "number": 7, "url": "https://example.com/pr/7", "baseRefName": "main",
                     "state": "OPEN", "isDraft": False, "reviewDecision": "",
                     "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                     "statusCheckRollup": [{"name": "build", "conclusion": "FAILURE"}],
                     "closingIssuesReferences": []}) + "'\n")
    os.chmod(os.path.join(gh_bin, "gh"), 0o755)
    with open(os.path.join(env["XDG_CACHE_HOME"], "cmux-crew",
                           "gh-" + hashlib.md5(X.encode()).hexdigest() + ".json"), "w") as fh:
        json.dump({"at": 0, "pr": 7, "notified": {"ci": "pass"}}, fh)
    genv = dict(env, PATH=gh_bin + os.pathsep + env.get("PATH", ""), FAKE_GH_CWD=X)
    runs = [subprocess.Popen([sys.executable, os.path.join(REPO, "crew", "bin", "crew-sync")],
                             env=genv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(2)]
    for r in runs:
        r.wait(timeout=180)
    banners = [l for l in open(os.path.join(t, "cmux.log")).read().splitlines()
               if l.startswith("notify") and "crew:pr" in l]
    check("two overlapping syncs send one banner for one PR transition, not two",
          len(banners) == 1, "\n       ".join(banners) or "no banner")

root_after = pointer_root()
check("the machine's engine pointer is not moved to this checkout",
      root_before == ENGINE or root_after != ENGINE, f"{POINTER} now names {root_after}, before {root_before}")

bad = results.count(False)
print(f"\nfamily sync probe: {len(results) - bad} passed, {bad} failed")
sys.exit(1 if bad else 0)
