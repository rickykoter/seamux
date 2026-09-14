#!/usr/bin/env python3
"""Per-workspace dollars from ccusage, cached.

    costs_for(cwds) -> {cwd: {"today": float, "week": float}}

Source: `ccusage claude daily --instances --json`, whose output is already
grouped by munged project directory and date — no session bookkeeping here.
Attribution reverse-matches each munged dir against the KNOWN workspace cwds:
the munging (every non-alphanumeric to "-") is lossy, so a dir name is never
parsed back into a path, only compared against candidates we already hold.

The raw ccusage output is cached (~5 min TTL) because a run over a long
transcript history costs seconds and both consumers — the board collector and
the /usage page — want the same numbers. Attribution itself is pure and cheap,
so it is recomputed per call against whatever cwds the caller knows about.

Degrades to {} — never an error — when ccusage is missing, times out, or
emits something unreadable: a board without dollars beats a broken board.
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import date, timedelta

CACHE = os.path.join(os.path.expanduser("~"), ".cache", "cmux-crew", "costs.json")
TTL = int(os.environ.get("CREW_COSTS_TTL", "300"))
DAYS = 7


def munge(cwd: str) -> str:
    """Mirror the transcript-dir naming: every non-alphanumeric becomes '-'."""
    return re.sub(r"[^A-Za-z0-9-]", "-", cwd)


def attribute(projects: dict, cwds, today: str = "") -> dict:
    """Pure: ccusage {munged-dir: [day rows]} x known cwds -> per-cwd dollars."""
    today = today or date.today().isoformat()
    by_munged = {}
    for cwd in cwds:
        by_munged.setdefault(munge(cwd), cwd)  # first claim wins on collision
    out = {}
    for dirname, rows in (projects or {}).items():
        cwd = by_munged.get(dirname)
        if not cwd:
            continue
        tot = out.setdefault(cwd, {"today": 0.0, "week": 0.0})
        for r in rows or []:
            try:
                cost = float(r.get("totalCost") or 0)
            except (TypeError, ValueError):
                continue
            tot["week"] += cost
            if r.get("date") == today:
                tot["today"] += cost
    return out


def fetch_projects(days: int = DAYS):
    """Raw ccusage output, or None when it cannot be had."""
    since = (date.today() - timedelta(days=days)).strftime("%Y%m%d")
    try:
        p = subprocess.run(
            ["ccusage", "claude", "daily", "--instances", "--json", "--since", since],
            capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            return None
        return json.loads(p.stdout).get("projects") or {}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _read_cache():
    try:
        with open(CACHE) as fh:
            c = json.load(fh)
        if time.time() - float(c.get("at", 0)) < TTL:
            return c.get("projects")
    except (OSError, ValueError):
        pass
    return None


def _write_cache(projects):
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = CACHE + ".tmp.%d" % os.getpid()
        with open(tmp, "w") as fh:
            json.dump({"at": time.time(), "projects": projects}, fh)
        os.replace(tmp, CACHE)
    except OSError:
        pass


def costs_for(cwds) -> dict:
    projects = _read_cache()
    if projects is None:
        projects = fetch_projects()
        if projects is None:
            return {}
        _write_cache(projects)
    return attribute(projects, cwds)


def main(argv):
    # --attribute FIXTURE.json CWD... : pure attribution, for the probe.
    # CWD...                          : live costs for those workspaces.
    if argv and argv[0] == "--attribute":
        with open(argv[1]) as fh:
            fx = json.load(fh)
        print(json.dumps(attribute(fx.get("projects") or {}, argv[2:],
                                   today=fx.get("today", ""))))
        return 0
    print(json.dumps(costs_for(argv)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
