#!/usr/bin/env python3
"""Run seamux's probes at the same time, from the recipes in .seamux/verify.json.

    python3 tools/probes.py                  every quick probe (see below)
    python3 tools/probes.py deep-plan lookout   recipes whose id contains a word
    python3 tools/probes.py --changed        the recipes whose `match` globs cover
                                             a file changed since main (committed,
                                             staged, unstaged or untracked)
    python3 tools/probes.py --list           print what would run, run nothing

A quick probe is a default recipe that is not in the expensive tier and needs
no build or outside CLI (cargo, npm, npx, claude). `--all` adds those; a recipe
in the expensive tier runs only when named. Each probe's output goes to a log
file, printed whole when it fails (and with -v when it passes).
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEEDS_BUILD = re.compile(r"\b(cargo|npm|npx|claude)\b")


def glob_re(glob):
    """deep-plan's globToRegExp (deep-plan/lib/verify.mjs), so a recipe matches
    here exactly the files it matches for `deep-plan check run`."""
    out, i = "", 0
    while i < len(glob):
        c = glob[i]
        if c == "*":
            if glob[i + 1:i + 2] == "*":
                if glob[i + 2:i + 3] == "/":
                    out += "(?:.*/)?"
                    i += 2
                else:
                    out += ".*"
                    i += 1
            else:
                out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


def matches(path, glob):
    if glob_re(glob).match(path):
        return True
    # A directory named on its own covers its contents, as in deep-plan.
    return "*" not in glob and path.startswith(glob.rstrip("/") + "/")


def load(root=ROOT):
    with open(os.path.join(root, ".seamux", "verify.json")) as fh:
        return [r for r in json.load(fh)["recipes"] if r.get("kind", "test") == "test"]


def quick(r):
    return r.get("default") and r.get("tier") != "expensive" and not NEEDS_BUILD.search(r["run"])


def changed_files(base, root=ROOT):
    def git(*a):
        p = subprocess.run(["git", *a], cwd=root, capture_output=True, text=True)
        return p.stdout.split("\n") if p.returncode == 0 else []
    mb = (git("merge-base", base, "HEAD") or [""])[0].strip()
    files = set(git("diff", "--name-only", mb) if mb else [])
    files |= set(git("ls-files", "--others", "--exclude-standard"))
    return sorted(f for f in files if f)


def select(recipes, words=(), changed=None, everything=False):
    """The recipes to run, in verify.json's order.

    Named words pick by id (exact, else substring) and may name any recipe;
    `changed` (a list of paths) picks by match globs; otherwise the quick set."""
    if words:
        picked = []
        for w in words:
            exact = [r for r in recipes if r["id"] == w]
            # A recipe that is this runner (verify.json's `probes`) runs only
            # when named exactly: a word must not start the whole suite again.
            picked += exact or [r for r in recipes if w in r["id"] and "tools/probes.py" not in r["run"]]
        ids = {r["id"] for r in picked}
        return [r for r in recipes if r["id"] in ids]
    pool = [r for r in recipes if r.get("default") and r.get("tier") != "expensive"
            and (everything or quick(r))]
    if changed is not None:
        pool = [r for r in pool if any(matches(f, g) for f in changed for g in r.get("match", []))]
    return pool


def run_all(picked, jobs, verbose, logdir, root=ROOT):
    lock = threading.Lock()
    results = {}

    def one(r):
        log = os.path.join(logdir, r["id"] + ".log")
        t = time.time()
        with open(log, "w") as fh:
            try:
                code = subprocess.run(["bash", "-c", r["run"]], cwd=root, stdout=fh, stderr=subprocess.STDOUT,
                                      stdin=subprocess.DEVNULL, timeout=r.get("timeout", 1800)).returncode
            except subprocess.TimeoutExpired:
                code = "timeout"
        secs = time.time() - t
        results[r["id"]] = (code, secs, log)
        with lock:
            print(f"{'ok  ' if code == 0 else 'FAIL'} {secs:6.1f}s  {r['id']}", flush=True)
            if code != 0 or verbose:
                with open(log) as fh:
                    body = fh.read().rstrip()
                if body:
                    print("      " + body.replace("\n", "\n      "))
                if code != 0:
                    print(f"      (exit {code}; log: {log})")
        return code

    # The slowest first, by the last run's times when there are any, so one
    # long probe does not start last and set the wall time on its own.
    order = sorted(picked, key=lambda r: -LAST.get(r["id"], 0))
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        list(ex.map(one, order))
    return results


TIMES = os.path.join(tempfile.gettempdir(), "seamux-probe-times.json")
try:
    with open(TIMES) as _fh:
        LAST = json.load(_fh)
except (OSError, ValueError):
    LAST = {}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("words", nargs="*", help="recipe ids, or words in them")
    ap.add_argument("--changed", nargs="?", const="main", metavar="BASE",
                    help="run what covers files changed since BASE (default main)")
    ap.add_argument("--all", action="store_true", help="include recipes that build (cargo, npm) or need claude")
    ap.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 4)
    ap.add_argument("-v", "--verbose", action="store_true", help="print every probe's output, not only failures")
    ap.add_argument("--list", action="store_true", help="print what would run and stop")
    a = ap.parse_args(argv)

    recipes = load()
    changed = changed_files(a.changed) if a.changed else None
    picked = select(recipes, a.words, changed, a.all)
    if a.list or not picked:
        if changed is not None:
            print(f"{len(changed)} changed file(s) since {a.changed}")
        for r in picked:
            print(f"  {r['id']:24} {r['run']}")
        if not picked:
            print("nothing to run" + (f": no recipe id contains {' or '.join(a.words)}" if a.words else ""))
        return 0 if picked or not a.words else 1

    logdir = tempfile.mkdtemp(prefix="seamux-probes-")
    t = time.time()
    results = run_all(picked, max(1, a.jobs), a.verbose, logdir)
    wall = time.time() - t
    failed = [i for i, (code, _, _) in results.items() if code != 0]
    total = sum(s for _, s, _ in results.values())
    LAST.update({i: s for i, (_, s, _) in results.items()})
    try:
        with open(TIMES, "w") as fh:
            json.dump(LAST, fh)
    except OSError:
        pass
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed in {wall:.1f}s "
          f"({total:.0f}s one after another, -j {a.jobs})" + (f": {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
