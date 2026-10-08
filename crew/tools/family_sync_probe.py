#!/usr/bin/env python3
"""family_sync_probe — a deep-plan family through the real crew-sync and
crew-color, against a fake cmux. No app, no network, no real plans or colors.

The family comes from deep-plan/tools/family-fixture.sh: a parent checkout and
two worktrees (api, ui), each with a plan. Four fake workspaces sit on them
plus a bystander repo. What is asserted:

  - the first sync tags each member family:/famrole:, keeps the parent's
    color, gives each child a shade of it, and leaves the bystander alone;
  - Peacock follows where it already colors a worktree (api), and only there;
  - a second sync sets no color (it is idempotent);
  - after the parent closes, the next sync gives each child its color from
    before (api its teal, ui none) and drops the tokens.

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
    X = os.path.join(t, "bystander")
    os.makedirs(X)
    subprocess.run(["git", "init", "-q"], cwd=X, check=True)
    os.makedirs(os.path.join(A, ".vscode"))
    json.dump({"peacock.color": "#006B6B"}, open(os.path.join(A, ".vscode", "settings.json"), "w"))
    env.update(FAKE_CMUX_DIR=t, CREW_CMUX=os.path.join(HERE, "fakecmux.py"),
               XDG_CACHE_HOME=os.path.join(t, "cache"))
    mk = lambda i, cwd, color: {"id": i, "title": i, "current_directory": cwd, "custom_color": color,
                                "description": "", "has_custom_title": True}
    json.dump([mk("ws-parent", P, "#1565C0"), mk("ws-api", A, "#006B6B"),
               mk("ws-ui", U, ""), mk("ws-x", X, "#7D6608")], open(os.path.join(t, "workspaces.json"), "w"))

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

bad = results.count(False)
print(f"\nfamily sync probe: {len(results) - bad} passed, {bad} failed")
sys.exit(1 if bad else 0)
