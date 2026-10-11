#!/usr/bin/env python3
"""Hold a skill to its recorded eval scores.

`claude plugin eval` scores a plugin's suite, but a score on its own says
nothing about whether an edit to the skill made it better or worse. This keeps
one committed baseline per plugin and model, and refuses a run in which any
case lost more than one run's worth of score against it.

    record  <plugin> --model M [--model M ...]   run the suite, write the baseline
    compare <plugin> --model M [--model M ...]   run the suite, hold it to the baseline

Both take --result FILE to trim or compare a `--json` result that already
exists instead of running the suite (one model per call then).

Why the shape is what it is:

- Record and compare both run with `--ablation none`. Under the default
  two-arm run a `tool_used: Skill` grader is excluded from the score, and
  under one arm it is not, so the two modes give different numbers for the
  same transcript. A baseline is only comparable to a run in its own mode, and
  one arm is half the cost.
- The bar is per case: a case may fall at most 1/3 below its baseline (one run
  in three gone wrong). There is deliberately no overall rule -- any single
  dropped case also drops the overall score, so an overall floor would cancel
  the one-run tolerance it sits beside.
- The baseline is trimmed to per-case numbers. The raw result carries
  absolute paths (scrub_check refuses those in tracked files), the prompts and
  the grader configs, none of which a comparison needs, and all of which would
  make a re-baseline's diff unreadable.

Exit: 0 held (or recorded), 1 a case fell, a case is missing from one side or
the run failed, 2 bad usage.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

SCHEMA = 1
TOLERANCE = 1 / 3
EPS = 1e-9
DEFAULT_CAP_USD = 40.0


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(here)


def baseline_path(root, plugin, model):
    return os.path.join(root, plugin, "evals", "baseline", f"{model}.json")


def trim(result, plugin, model):
    """The comparable part of a `claude plugin eval --json` result."""
    if result.get("partial"):
        raise ValueError("the run is partial (cost ceiling or a rejected credential); nothing to record")
    if result.get("suite", {}).get("ablation") != "none":
        raise ValueError("the run was not --ablation none; its scores are not comparable to a one-arm baseline")
    cases = {}
    for c in result.get("cases", []):
        runs = c.get("arms", {}).get("with", [])
        graders = {}
        for r in runs:
            for g in r.get("graders", []):
                graders.setdefault(g["name"], 0)
                if g.get("passed"):
                    graders[g["name"]] += 1
        errors = sum(1 for r in runs if r.get("error"))
        cases[c["name"]] = {
            "runs": len(runs),
            "score": round(float(c.get("aggregates", {}).get("score", 0.0)), 4),
            "graders": dict(sorted(graders.items())),
            "errors": errors,
        }
    return {
        "schema": SCHEMA,
        "plugin": plugin,
        "model": model,
        "claudeVersion": result.get("claudeVersion"),
        "costUsd": round(float(result.get("costUsd") or 0.0), 4),
        "cases": dict(sorted(cases.items())),
    }


def compare(baseline, current):
    """Every way `current` fails to hold `baseline`, as one line each."""
    out = []
    if baseline.get("schema") != SCHEMA:
        out.append(f"baseline schema {baseline.get('schema')} is not {SCHEMA}; re-record it")
        return out
    if baseline.get("model") != current.get("model"):
        out.append(f"baseline is for {baseline.get('model')}, the run is {current.get('model')}")
        return out
    b, c = baseline["cases"], current["cases"]
    for name in sorted(set(b) - set(c)):
        out.append(f"{name}: in the baseline, not in the run")
    for name in sorted(set(c) - set(b)):
        out.append(f"{name}: in the run, not in the baseline -- record it before comparing")
    for name in sorted(set(b) & set(c)):
        was, now = b[name]["score"], c[name]["score"]
        if now < was - TOLERANCE - EPS:
            out.append(f"{name}: {was:.2f} -> {now:.2f} ({now - was:+.2f}), more than one run lost")
    return out


def summary(baseline, current):
    lines = []
    for name in sorted(set(baseline["cases"]) | set(current["cases"])):
        was = baseline["cases"].get(name, {}).get("score")
        now = current["cases"].get(name, {}).get("score")
        fmt = lambda v: "  -  " if v is None else f"{v:.2f}"
        lines.append(f"  {name:<40} {fmt(was)} -> {fmt(now)}")
    return lines


def run_suite(root, plugin, model, cap, runs, concurrency):
    """Run the suite once for one model; the raw `--json` result."""
    with tempfile.TemporaryDirectory(prefix="skill-evals-") as tmp:
        out = os.path.join(tmp, "result.json")
        cmd = ["claude", "plugin", "eval", os.path.join(root, plugin),
               "--model", model, "--ablation", "none", "--no-publish", "--trust-plugin",
               "--threshold", "0", "--max-cost-usd", str(cap), "-j", str(concurrency),
               "--json", out]
        if runs:
            cmd += ["--runs", str(runs)]
        print(f"$ {' '.join(cmd)}", file=sys.stderr)
        proc = subprocess.run(cmd, cwd=root)
        if not os.path.exists(out):
            raise RuntimeError(f"claude plugin eval exited {proc.returncode} without a result")
        with open(out) as fh:
            result = json.load(fh)
        if proc.returncode not in (0, 1):
            raise RuntimeError(f"claude plugin eval exited {proc.returncode} (partial or interrupted)")
        return result


def load_result(args, root, model):
    if args.result:
        with open(args.result) as fh:
            return json.load(fh)
    return run_suite(root, args.plugin, model, args.max_cost_usd, args.runs, args.concurrency)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("verb", choices=["record", "compare"])
    ap.add_argument("plugin", help="plugin directory under the repo root, e.g. deep-plan")
    ap.add_argument("--model", action="append", required=True)
    ap.add_argument("--result", help="trim or compare this --json result instead of running")
    ap.add_argument("--root", default=repo_root(), help="repo root (default: this checkout)")
    ap.add_argument("--max-cost-usd", type=float, default=DEFAULT_CAP_USD, help="per model")
    ap.add_argument("--runs", type=int, help="override every case's runs")
    ap.add_argument("--concurrency", type=int, default=4)
    args = ap.parse_args(argv)
    if args.result and len(args.model) != 1:
        ap.error("--result holds one model's run; pass exactly one --model")
    if not os.path.isdir(os.path.join(args.root, args.plugin, "evals")):
        ap.error(f"{args.plugin}/evals does not exist under {args.root}")

    failed = False
    for model in args.model:
        try:
            current = trim(load_result(args, args.root, model), args.plugin, model)
        except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as e:
            print(f"{args.plugin} {model}: {e}", file=sys.stderr)
            failed = True
            continue
        path = baseline_path(args.root, args.plugin, model)
        if args.verb == "record":
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                json.dump(current, fh, indent=2)
                fh.write("\n")
            print(f"{args.plugin} {model}: recorded {len(current['cases'])} cases "
                  f"(${current['costUsd']:.2f}) -> {os.path.relpath(path, args.root)}")
            for name, c in current["cases"].items():
                print(f"  {name:<40} {c['score']:.2f}  ({c['runs']} runs, {c['errors']} errors)")
            continue
        try:
            with open(path) as fh:
                baseline = json.load(fh)
        except OSError:
            print(f"{args.plugin} {model}: no baseline at {os.path.relpath(path, args.root)}; record one first",
                  file=sys.stderr)
            failed = True
            continue
        problems = compare(baseline, current)
        verdict = "FELL" if problems else "held"
        print(f"{args.plugin} {model}: {verdict} (${current['costUsd']:.2f})")
        print("\n".join(summary(baseline, current)))
        for p in problems:
            print(f"  x {p}")
        failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
