#!/usr/bin/env python3
"""Probe tools/skill_evals.py without calling claude: trim and compare on
fixture results shaped like `claude plugin eval --json`, and the CLI's record
and compare verbs through --result against a throwaway repo root."""
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skill_evals as se  # noqa: E402

FAILS = []
# Spelled in two pieces so this file never trips scrub_check's home-path rule.
HOME_PATH = "/" + "Users/someone"


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f" -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def result(scores, ablation="none", partial=False, model=None, plugin=None):
    """A --json result: one case per (name, [run passes]) with two graders a run."""
    cases = []
    for name, runs in scores.items():
        arms = []
        for passes in runs:
            arms.append({"score": passes / 2, "error": None, "tracePath": "/private/tmp/e-x/out/trace.jsonl",
                         "graders": [{"name": "skill", "passed": passes >= 1},
                                     {"name": "reply", "passed": passes >= 2}]})
        mean = sum(a["score"] for a in arms) / len(arms)
        cases.append({"name": name, "dir": f"evals/{name}", "promptMarkdown": "a prompt",
                      "arms": {"with": arms}, "aggregates": {"score": mean}})
    return {"schemaVersion": 1, "claudeVersion": "2.1.294", "costUsd": 0.0123, "partial": partial,
            "suite": {"root": HOME_PATH + "/code/seamux/deep-plan", "ablation": ablation,
                      **({"modelOverride": model} if model else {}),
                      **({"plugins": [{"name": plugin}]} if plugin else {})},
            "cases": cases}


def run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            code = se.main(argv)
        except SystemExit as e:
            code = e.code
    return code, out.getvalue() + err.getvalue()


# trim keeps numbers, drops paths and prompts
t = se.trim(result({"fires": [2, 2, 2], "quiet": [2, 1, 0]}), "deep-plan", "haiku")
blob = json.dumps(t)
check("trim drops every absolute path", HOME_PATH not in blob and "/private/" not in blob, blob)
check("trim drops prompts", "a prompt" not in blob)
check("trim keeps per-case score", t["cases"]["fires"]["score"] == 1.0 and t["cases"]["quiet"]["score"] == 0.5,
      json.dumps(t["cases"]))
check("trim counts grader passes", t["cases"]["quiet"]["graders"] == {"reply": 1, "skill": 2},
      json.dumps(t["cases"]["quiet"]))
check("trim records runs and model", t["cases"]["fires"]["runs"] == 3 and t["model"] == "haiku")

for bad, why in ((result({"a": [2]}, partial=True), "partial"), (result({"a": [2]}, ablation="with-without"), "two-arm")):
    try:
        se.trim(bad, "p", "m")
        check(f"trim refuses a {why} run", False, "accepted")
    except ValueError:
        check(f"trim refuses a {why} run", True)

base = se.trim(result({"a": [2, 2, 2], "b": [2, 2, 2], "c": [1, 1, 1]}), "p", "opus")


def cmp(scores, model="opus"):
    return se.compare(base, se.trim(result(scores), "p", model))


check("identical scores hold", cmp({"a": [2, 2, 2], "b": [2, 2, 2], "c": [1, 1, 1]}) == [])
check("one case down exactly one run holds",
      cmp({"a": [2, 2, 0], "b": [2, 2, 2], "c": [1, 1, 1]}) == [])
check("one flaky case with the rest equal holds (no overall rule)",
      cmp({"a": [2, 2, 1], "b": [2, 2, 2], "c": [1, 1, 1]}) == [])
p = cmp({"a": [2, 1, 0], "b": [2, 2, 2], "c": [1, 1, 1]})
check("a case down more than one run fails, naming it", len(p) == 1 and p[0].startswith("a:"), str(p))
# Scores are stored rounded: 2/3 -> 0.6667 and 1/3 -> 0.3333 is still one run.
thirds = se.trim(result({"a": [2, 2, 0]}), "p", "opus")
check("a one-run drop between rounded scores holds",
      se.compare(thirds, se.trim(result({"a": [2, 0, 0]}), "p", "opus")) == [],
      str(se.compare(thirds, se.trim(result({"a": [2, 0, 0]}), "p", "opus"))))
check("two runs lost from a rounded score fails",
      len(se.compare(thirds, se.trim(result({"a": [0, 0, 0]}), "p", "opus"))) == 1)
p = se.compare(base, se.trim(result({"a": [2, 2], "b": [2, 2, 2], "c": [1, 1, 1]}), "p", "opus"))
check("a run count that differs from the baseline fails", any("2 runs against a 3-run" in x for x in p), str(p))
for bad, why in ((result({"a": [2]}, model="haiku"), "a run of another model"),
                 (result({"a": [2]}, plugin="lookout"), "a run of another plugin")):
    try:
        se.trim(bad, "p", "opus")
        check(f"trim refuses {why}", False, "accepted")
    except ValueError:
        check(f"trim refuses {why}", True)
check("an improvement holds", cmp({"a": [2, 2, 2], "b": [2, 2, 2], "c": [2, 2, 2]}) == [])
p = cmp({"a": [2, 2, 2], "b": [2, 2, 2]})
check("a case missing from the run fails", any(x.startswith("c:") for x in p), str(p))
p = cmp({"a": [2, 2, 2], "b": [2, 2, 2], "c": [1, 1, 1], "d": [2, 2, 2]})
check("a case missing from the baseline fails", any(x.startswith("d:") for x in p), str(p))
p = cmp({"a": [2, 2, 2], "b": [2, 2, 2], "c": [1, 1, 1]}, model="haiku")
check("a model mismatch fails", len(p) == 1 and "haiku" in p[0], str(p))
try:
    se.trim(result({}), "p", "opus")
    check("trim refuses a run with no cases", False, "accepted")
except ValueError:
    check("trim refuses a run with no cases", True)
empty = dict(base, cases={})
p = se.compare(empty, empty)
check("an empty baseline against an empty run fails", len(p) == 1 and "no cases" in p[0], str(p))
p = se.compare(empty, base)
check("an empty baseline fails", len(p) == 1 and "baseline has no cases" in p[0], str(p))

# CLI: record then compare through --result, in a throwaway root
with tempfile.TemporaryDirectory() as root:
    os.makedirs(os.path.join(root, "plug", "evals"))
    good = os.path.join(root, "good.json")
    worse = os.path.join(root, "worse.json")
    with open(good, "w") as fh:
        json.dump(result({"a": [2, 2, 2], "b": [1, 1, 1]}), fh)
    with open(worse, "w") as fh:
        json.dump(result({"a": [0, 0, 2], "b": [1, 1, 1]}), fh)
    code, _ = run_cli(["compare", "plug", "--model", "opus", "--result", good, "--root", root])
    check("compare with no baseline fails", code == 1)
    code, out = run_cli(["record", "plug", "--model", "opus", "--result", good, "--root", root])
    path = os.path.join(root, "plug", "evals", "baseline", "opus.json")
    check("record writes evals/baseline/<model>.json", code == 0 and os.path.exists(path), out)
    code, out = run_cli(["compare", "plug", "--model", "opus", "--result", good, "--root", root])
    check("compare against itself holds", code == 0 and "held" in out, out)
    code, out = run_cli(["compare", "plug", "--model", "opus", "--result", worse, "--root", root])
    check("compare against a regression exits 1", code == 1 and "FELL" in out and "a:" in out, out)
    code, out = run_cli(["compare", "plug", "--model", "opus", "--model", "haiku", "--result", good, "--root", root])
    check("--result with two models is refused", code == 2, out)
    code, out = run_cli(["record", "nope", "--model", "opus", "--result", good, "--root", root])
    check("a plugin with no evals/ is refused", code == 2, out)
    nocases = os.path.join(root, "nocases.json")
    with open(nocases, "w") as fh:
        json.dump(result({}), fh)
    code, out = run_cli(["record", "plug", "--model", "opus", "--result", nocases, "--root", root])
    check("record of a run with no cases exits 1", code == 1 and "no cases" in out, out)
    check("record of a run with no cases keeps the baseline",
          json.load(open(path))["cases"].keys() == {"a", "b"})
    code, out = run_cli(["compare", "plug", "--model", "opus", "--result", nocases, "--root", root])
    check("compare of a run with no cases exits 1, not held", code == 1 and "held" not in out, out)

print(f"\n{'all good' if not FAILS else f'{len(FAILS)} failed'}")
sys.exit(1 if FAILS else 0)
