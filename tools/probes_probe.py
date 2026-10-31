#!/usr/bin/env python3
"""Probe tools/probes.py: its globs match as deep-plan's do, it picks recipes by
word, by changed file and by the quick rule, and a run reports a failure. Also
the section list tools/probe_sections.mjs reads from a probe's source."""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import probes as P  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f" -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


# Globs: the same answers as deep-plan's globToRegExp, asked of node itself.
cases = [("deep-plan/*.mjs", "deep-plan/probe.mjs"), ("deep-plan/*.mjs", "deep-plan/lib/x.mjs"),
         ("deep-plan/lib/**", "deep-plan/lib/a/b.mjs"), ("**", "README.md"), ("**/x.py", "x.py"),
         ("**/x.py", "a/b/x.py"), ("crew/hooks/seamux-*.sh", "crew/hooks/seamux-a.sh"),
         ("*/SKILL.md", "lookout/SKILL.md"), ("*/SKILL.md", "a/b/SKILL.md"), ("a?c", "abc"),
         ("theme", "theme/everforest.css"), ("theme", "themes/x"), ("app/Cargo.lock", "app/Cargo.lock")]
js = ("import { matchesGlob } from %s; const c = %s; console.log(JSON.stringify(c.map(([g, p]) => matchesGlob(p, g))));"
      % (json.dumps(os.path.join(os.path.dirname(HERE), "deep-plan", "lib", "verify.mjs")), json.dumps(cases)))
r = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True)
theirs = json.loads(r.stdout or "[]")
ours = [P.matches(p, g) for g, p in cases]
check("every glob matches here as it does in deep-plan", ours == theirs, f"{ours} vs {theirs} {r.stderr}")

R = [
    {"id": "a-probe", "run": "node a/probe.mjs", "match": ["a/**"], "default": True},
    {"id": "b-probe", "run": "python3 b/probe.py", "match": ["b/*.py"], "default": True},
    {"id": "b-cargo", "run": "cargo test -p b", "match": ["b/**"], "default": True},
    {"id": "b-live", "run": "bash b/live.sh", "match": ["b/**"], "default": True, "tier": "expensive"},
    {"id": "c-off", "run": "node c.mjs", "match": ["c/**"], "default": False},
]
ids = lambda rs: [r["id"] for r in rs]  # noqa: E731
check("no words: the quick set, leaving out builds, the expensive tier and non-defaults",
      ids(P.select(R)) == ["a-probe", "b-probe"], ids(P.select(R)))
check("--all adds the builds, never the expensive tier", ids(P.select(R, everything=True)) == ["a-probe", "b-probe", "b-cargo"])
check("a word picks by substring, any tier", ids(P.select(R, ["b-"])) == ["b-probe", "b-cargo", "b-live"])
check("an exact id picks only itself", ids(P.select(R, ["a-probe"])) == ["a-probe"])
check("a word that names nothing picks nothing", P.select(R, ["zzz"]) == [])
RS = R + [{"id": "probes", "run": "python3 tools/probes.py", "match": [], "default": False}]
check("a word never picks the runner's own recipe", "probes" not in ids(P.select(RS, ["probe"])))
check("…but its exact id does", ids(P.select(RS, ["probes"])) == ["probes"])
check("changed files pick the recipes whose globs cover them",
      ids(P.select(R, changed=["b/x.py"])) == ["b-probe"], ids(P.select(R, changed=["b/x.py"])))
check("…and a file no glob covers picks nothing", P.select(R, changed=["docs/x.md"]) == [])
check("…and a nested file is not a top-level glob's", P.select(R, changed=["b/sub/x.py"]) == [])

# changed_files: committed, staged, unstaged and untracked since the base.
with tempfile.TemporaryDirectory() as d:
    G = ["git", "-c", "user.email=probe@seamux", "-c", "user.name=probe"]
    sh = lambda *a: subprocess.run([*G, *a], cwd=d, capture_output=True, text=True, check=True)  # noqa: E731
    sh("init", "-q", "-b", "main")
    for f in ("kept", "edited"):
        open(os.path.join(d, f), "w").write("x\n")
    sh("add", "-A"); sh("commit", "-q", "-m", "base")
    sh("checkout", "-q", "-b", "work")
    open(os.path.join(d, "committed"), "w").write("x\n")
    sh("add", "-A"); sh("commit", "-q", "-m", "c")
    open(os.path.join(d, "edited"), "w").write("y\n")
    open(os.path.join(d, "untracked"), "w").write("x\n")
    got = P.changed_files("main", root=d)
    check("changed files: committed, edited and untracked, not the untouched",
          got == ["committed", "edited", "untracked"], got)

    # A run: a passing and a failing recipe, the failure's output printed.
    out = io.StringIO()
    with redirect_stdout(out):
        res = P.run_all([{"id": "good", "run": "echo fine"}, {"id": "bad", "run": "echo broke; exit 3"}],
                        2, False, d, root=d)
    text = out.getvalue()
    check("a run records each exit code", res["good"][0] == 0 and res["bad"][0] == 3, res)
    check("…and prints a failure's output, not a pass's", "broke" in text and "fine" not in text, text)

# The section list a node probe's parent reads.
js = ("import { listSections } from %s; console.log(JSON.stringify(listSections(%s).map(s => s.name)));"
      % (json.dumps(os.path.join(HERE, "probe_sections.mjs")),
         json.dumps('x\nif (want("one")) {\n}\n  if (want("indented")) {\nif (want("it\'s \\"two\\"")) {\n}\n')))
r = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True)
check("sections are the guards at the start of a line, quotes and all",
      json.loads(r.stdout or "[]") == ["one", 'it\'s "two"'], r.stdout + r.stderr)

print(f"\nprobes probe: {len(FAILS)} failed" if FAILS else "\nprobes probe: all passed")
sys.exit(1 if FAILS else 0)
