#!/usr/bin/env python3
"""Turn-end TypeSafe judgments for the board, cached. Policy lives HERE.

    record(cwd, size, values)          writer — called by hooks/asked.sh
    fresh_map(now)                     reader — {cwd: entry}, freshness applied
    stuck_for(w, jmap) / urgency_for   what rank() actually consults

    judgments.py --record CWD SIZE     values JSON on stdin (the asked.sh CLI)
    judgments.py --apply FIXTURE.json  pure policy over a fixture, for the probe

The cache is the whole design: judgments are computed in the detached Stop
flow (hooks/asked.sh), and the board only ever reads this file — a push never
waits on the network. Same shape as costs.py's cache for the same reason.

Freshness is a proxy, enforced twice. The writer drops a judgment when the
transcript grew before it landed (asked.sh checks); the reader ignores an
entry when the workspace is mid-turn — a last-turn judgment about an agent
that is typing again is stale by definition — or older than TTL.

Policy in code, answers from the cache: stuck >= stuck_threshold reclassifies
a row to wilt, and urgency orders rows within a tier. Tier order itself never
moves. Anything missing — no cache, no key, unreadable entry — must leave the
board byte-identical to a machine that never heard of TypeSafe.
"""
import json
import os
import sys
import time

# Env override exists for the probes, and only for the probes.
CACHE = os.environ.get("CREW_JUDGMENTS_FILE") or os.path.join(
    os.path.expanduser("~"), ".cache", "cmux-crew", "judgments.json")
# How long a turn-end judgment stays credible with no newer turn. Provisional,
# like the thresholds: tune from asked.log once real transcripts have scored.
TTL = int(os.environ.get("CREW_JUDGMENT_TTL", "21600"))          # 6h
GC_AGE = 172800                                                  # writer-side, 48h
STUCK_DEFAULT = 0.8

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "hooks"))


def stuck_threshold():
    """From integrations.json via the shared client; degrades to the default."""
    try:
        import typesafe
        return typesafe.threshold("stuck_threshold", STUCK_DEFAULT)
    except Exception:
        return STUCK_DEFAULT


def _load():
    try:
        with open(CACHE) as fh:
            c = json.load(fh)
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def record(cwd, size, values, now=None):
    """Read-modify-write one entry; atomic replace; GC entries nobody will read.

    Other cwds' entries survive — twelve worktrees end turns independently and
    each write must not blank the other eleven.
    """
    now = now or time.time()
    cache = _load()
    entry = {"at": now, "transcript_size": int(size or 0)}
    for k in ("blocked", "stuck", "urgency"):
        if k in values:
            entry[k] = float(values[k])
    cache[cwd] = entry
    for k in [k for k, v in cache.items()
              if now - float(v.get("at", 0) or 0) > GC_AGE]:
        cache.pop(k, None)
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp.%d" % os.getpid()
    with open(tmp, "w") as fh:
        json.dump(cache, fh)
    os.replace(tmp, CACHE)


def fresh_map(now=None, cache=None):
    """{cwd: entry} for entries young enough to still mean something."""
    now = now or time.time()
    cache = cache if cache is not None else _load()
    out = {}
    for cwd, e in cache.items():
        try:
            if now - float(e.get("at", 0)) <= TTL:
                out[cwd] = e
        except (TypeError, ValueError):
            continue
    return out


def stuck_for(w, jmap, threshold=None):
    """Should this workspace's row read as wilt/stuck? Never True mid-turn:
    the judgment is about a turn that already ended."""
    if w.get("running"):
        return False
    e = jmap.get(w.get("cwd") or "")
    if not e:
        return False
    t = threshold if threshold is not None else stuck_threshold()
    try:
        return float(e.get("stuck", 0)) >= t
    except (TypeError, ValueError):
        return False


def urgency_for(w, jmap):
    """The within-tier sort key; 0 when unknown, so unjudged rows keep their
    gather order among themselves (python's sort is stable)."""
    e = jmap.get(w.get("cwd") or "")
    try:
        return float(e.get("urgency", 0)) if e else 0.0
    except (TypeError, ValueError):
        return 0.0


def apply(workspaces, cache, now, threshold=STUCK_DEFAULT):
    """Pure: the whole policy over explicit inputs, for the probe.
    Returns {cwd: {stuck: bool, urgency: float}}."""
    jmap = fresh_map(now=now, cache=cache)
    return {w.get("cwd", ""): {"stuck": stuck_for(w, jmap, threshold),
                               "urgency": urgency_for(w, jmap)}
            for w in workspaces}


def main(argv):
    if argv[:1] == ["--record"] and len(argv) >= 3:
        # --record CWD SIZE [BLOCKED]; stuck/urgency JSON on stdin. BLOCKED is
        # an arg because asked.sh already holds it as a plain line-1 string.
        vals = json.loads(sys.stdin.read() or "{}")
        if len(argv) > 3:
            try:
                vals["blocked"] = float(argv[3])
            except ValueError:
                pass
        record(argv[1], argv[2], vals)
        return 0
    if argv[:1] == ["--apply"] and len(argv) >= 2:
        with open(argv[1]) as fh:
            fx = json.load(fh)
        print(json.dumps(apply(fx.get("workspaces") or [], fx.get("cache") or {},
                               fx.get("now") or time.time(),
                               fx.get("threshold", STUCK_DEFAULT))))
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
