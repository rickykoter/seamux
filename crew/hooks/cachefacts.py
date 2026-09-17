#!/usr/bin/env python3
"""Cache facts from a Claude Code transcript: breaks, causes, and a staleness clock.

Every request rides a serverside prompt cache; a break re-caches the whole
context at a 1.25-2x write premium. The transcript records what happened --
`cache_read_input_tokens` and `cache_creation_input_tokens` per assistant
record -- so a break is visible after the fact: the read figure collapses
while the creation figure re-writes most of the prior context. What this
module adds is the *why* (compaction, model switch, TTL gap, Claude Code
upgrade) and the *when next* (staleAt, from a TTL that is derived, never
inferred: Claude Code documents the choice as billing mode plus overrides at
code.claude.com/docs/en/prompt-caching.md).

Facts land in ~/.cache/cmux-crew/cache-facts/<session_id>.json, written
atomically, one file per session. The Stop hook writes them; the statusline
and the /usage page only read. Nothing here calls a network.

CLI:
    cachefacts.py <transcript.jsonl> [session_id]   write facts, print JSON
    cachefacts.py --scan <projects_dir>             corpus sweep, cause table
    cachefacts.py --stop <transcript> <session_id> [label]
        Stop-hook mode: write facts; print {"systemMessage": ...} on stdout
        ONLY when the turn that just ended broke the cache. Quiet otherwise.
    cachefacts.py --sleep <session_id> <transcript> [label]
        Detached staleness timer: sleeps until staleAt minus 60s, then fires
        cmux notify if the session is still idle. A newer sleeper for the
        same session supersedes this one via the pid token in the facts dir.
"""

import json
import os
import sys
import time

FACTS_DIR = os.path.join(os.path.expanduser("~"), ".cache", "cmux-crew", "cache-facts")

# A transcript reaches 8MB+; the tail holds plenty of requests. 512k covers
# hundreds of records -- enough for the clock and the last few breaks, which
# is all the Stop hook needs. --scan reads files whole instead.
TAIL_BYTES = 512 * 1024

# Break rule, tuned on this machine's own corpus (151 breaks / 8,675 requests):
# only meaningful once real context has accumulated, and both halves must
# agree -- the read collapsed AND the creation re-wrote most of it. One-sided
# signals are ordinary turns (small creation = incremental caching; small read
# = short context).
MIN_CONTEXT = 20_000
READ_COLLAPSE = 0.5
CREATION_SPIKE = 0.4

FIVE_MIN = 5 * 60
ONE_HOUR = 60 * 60


# ---------------------------------------------------------------- TTL

def _crew_local():
    base = os.environ.get("CREW_LOCAL") or os.path.join(
        os.path.expanduser("~"), ".config", "cmux", "crew-local")
    try:
        with open(os.path.join(base, "config.json"), encoding="utf-8") as fh:
            cfg = json.load(fh)
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def _settings_ttl():
    """promptCacheTtl from ~/.claude/settings.json, as seconds, or 0."""
    path = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh).get("promptCacheTtl")
    except (OSError, ValueError):
        return 0
    return _parse_ttl(raw)


def _parse_ttl(raw):
    """'5m' / '1h' / seconds-as-number -> seconds, else 0."""
    if isinstance(raw, (int, float)) and raw > 0:
        return int(raw)
    s = str(raw or "").strip().lower()
    if s in ("5m", "300"):
        return FIVE_MIN
    if s in ("1h", "60m", "3600"):
        return ONE_HOUR
    return 0


def derive_ttl():
    """(seconds, source). Derivation order mirrors the documented precedence:
    force-5m > enable-1h > explicit TTL (env, then settings) > billing mode.
    The fallback is the conservative 5m -- early warnings on a 1h session are
    harmless; the reverse silently misses staleness."""
    if os.environ.get("FORCE_PROMPT_CACHING_5M"):
        return FIVE_MIN, "FORCE_PROMPT_CACHING_5M"
    if os.environ.get("ENABLE_PROMPT_CACHING_1H"):
        return ONE_HOUR, "ENABLE_PROMPT_CACHING_1H"
    env = _parse_ttl(os.environ.get("CLAUDE_CODE_PROMPT_CACHE_TTL"))
    if env:
        return env, "CLAUDE_CODE_PROMPT_CACHE_TTL"
    st = _settings_ttl()
    if st:
        return st, "promptCacheTtl"
    billing = str(os.environ.get("CREW_BILLING")
                  or _crew_local().get("billing") or "").strip().lower()
    if billing == "usage":
        return FIVE_MIN, "billing:usage"
    if billing:
        return ONE_HOUR, "billing:" + billing
    return FIVE_MIN, "default"


# ---------------------------------------------------------------- transcript

def _iter_records(path, whole=False):
    """Parsed JSON records from a transcript, oldest first. Tail by default;
    the first line of a tail is usually cut in half, so parse errors skip."""
    with open(path, "rb") as fh:
        if not whole:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - TAIL_BYTES))
        for line in fh.read().decode("utf-8", "replace").splitlines():
            try:
                yield json.loads(line)
            except Exception:
                continue


def _epoch(ts):
    """Transcript timestamps are ISO-8601 Zulu; parse cheaply, 0 on failure."""
    try:
        import datetime
        return datetime.datetime.fromisoformat(
            str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


def read_facts(path, ttl=None, whole=False):
    """One pass over a transcript -> the facts dict (not yet written).

    Sidechain (subagent) records are skipped outright: they ride the separate
    5m bucket and their small contexts read as false break positives against
    the main conversation's.
    """
    ttl_s, ttl_source = (ttl, "caller") if ttl else derive_ttl()
    prev_total = 0
    seen_requests = set()
    prev_model = None
    prev_version = None
    prev_at = 0.0
    compact_pending = False
    breaks = []
    last_at = 0.0
    context = 0

    for rec in _iter_records(path, whole=whole):
        if rec.get("isSidechain"):
            continue
        if rec.get("isCompactSummary") or rec.get("compactMetadata") \
                or "compact" in str(rec.get("type", "")).lower():
            compact_pending = True
            continue
        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message") or {}
        usage = msg.get("usage") or {}
        read = usage.get("cache_read_input_tokens") or 0
        creation = usage.get("cache_creation_input_tokens") or 0
        total = read + creation
        if total <= 0:
            continue
        # Retries and parallel stream records repeat the same requestId with
        # the same usage; on the corpus they were 144 of 244 raw hits.
        req = rec.get("requestId")
        if req and req in seen_requests:
            continue
        if req:
            seen_requests.add(req)
        at = _epoch(rec.get("timestamp"))
        model = msg.get("model")
        version = rec.get("version")

        # A compaction break re-caches a deliberately SMALL context -- the
        # spike test would filter it out, so the read collapse alone counts.
        if (prev_total > MIN_CONTEXT
                and read < prev_total * READ_COLLAPSE
                and (compact_pending or creation > prev_total * CREATION_SPIKE)):
            if compact_pending:
                cause = "compaction"
            elif prev_model and model and model != prev_model:
                cause = "model-switch"
            elif prev_at and at and (at - prev_at) > ttl_s:
                cause = "ttl-gap"
            elif prev_version and version and version != prev_version:
                cause = "upgrade"
            else:
                cause = "unknown"
            breaks.append({"ts": rec.get("timestamp"),
                           "recachedTokens": creation, "cause": cause})
            prev_total = total  # the new, re-cached context is the baseline now
        else:
            prev_total = max(prev_total, total)
        compact_pending = False
        context = total
        prev_model = model or prev_model
        prev_version = version or prev_version
        prev_at = at or prev_at
        last_at = at or last_at

    return {
        "ttl": ttl_s, "ttlSource": ttl_source,
        "lastRequestAt": last_at,
        "staleAt": (last_at + ttl_s) if last_at else 0,
        "contextTokens": context,
        "breaks": breaks,
    }


# ---------------------------------------------------------------- state file

def write_facts(session_id, facts):
    """Atomic write; the sleeper and /usage read these. Never raises."""
    try:
        os.makedirs(FACTS_DIR, exist_ok=True)
        path = os.path.join(FACTS_DIR, session_id + ".json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(facts, fh)
        os.replace(tmp, path)
        return path
    except OSError:
        return ""


# ---------------------------------------------------------------- stop hook

STALE_LEAD = 60      # warn this many seconds before the cache expires
FRESH_WINDOW = 600   # without prior facts, a break this recent counts as new


def _read_prior(session_id):
    try:
        with open(os.path.join(FACTS_DIR, session_id + ".json"),
                  encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _fmt_tokens(n):
    n = int(n or 0)
    return f"{n / 1000:.0f}k" if n >= 1000 else str(n)


def stop_mode(transcript, session_id, label=""):
    """Write facts; emit the hook's systemMessage JSON only on a fresh break.

    Fresh means newer than the last break the previous facts file knew about
    -- or, with no prior file (first Stop of a session), recent enough to
    belong to the turn that just ended. Old breaks re-announced on every turn
    would train the human to ignore the channel.
    """
    prior = _read_prior(session_id)
    facts = read_facts(transcript)
    facts["generatedAt"] = time.time()
    if label:
        facts["label"] = label   # lets /usage name the session's workspace
    write_facts(session_id, facts)

    if not facts["breaks"]:
        return ""
    last = facts["breaks"][-1]
    if prior and prior.get("breaks"):
        if last["ts"] == prior["breaks"][-1].get("ts"):
            return ""
    elif time.time() - _epoch(last["ts"]) > FRESH_WINDOW:
        return ""
    where = f" [{label}]" if label else ""
    msg = (f"cache broke last turn{where}: ~{_fmt_tokens(last['recachedTokens'])} "
           f"tokens re-cached ({last['cause']})")
    return json.dumps({"systemMessage": msg})


# ---------------------------------------------------------------- sleeper

def _cmux():
    import shutil as _sh
    exe = _sh.which("cmux")
    if exe:
        return exe
    import glob as _gl
    bundles = sorted(_gl.glob("/Applications/cmux*.app/Contents/Resources/bin/cmux"),
                     key=lambda p: os.path.getmtime(p), reverse=True)
    return bundles[0] if bundles else ""


def sleep_mode(session_id, transcript, label=""):
    """Wake just before the cache goes stale; notify only if still idle.

    Cancellation is two checks at wake time: the pid token (a newer Stop
    spawned a newer sleeper) and the transcript mtime (the session spoke
    again, which reset the serverside TTL). Woken late -- laptop lid, most
    likely -- it stays silent: 'stale in 60s' after the fact is noise.
    """
    facts = _read_prior(session_id) or {}
    stale_at = facts.get("staleAt") or 0
    wake_at = stale_at - STALE_LEAD
    now = time.time()
    if not stale_at or wake_at <= now:
        return 0

    token = os.path.join(FACTS_DIR, session_id + ".sleeper")
    try:
        os.makedirs(FACTS_DIR, exist_ok=True)
        with open(token, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        return 0

    try:
        mtime0 = os.path.getmtime(transcript)
    except OSError:
        return 0

    time.sleep(wake_at - now)

    if time.time() > stale_at:          # overslept the whole window
        return 0
    try:
        if open(token, encoding="utf-8").read().strip() != str(os.getpid()):
            return 0                    # a newer sleeper owns this session
        if os.path.getmtime(transcript) != mtime0:
            return 0                    # session spoke again; TTL reset
    except OSError:
        return 0

    exe = _cmux()
    if not exe:
        return 0
    import subprocess
    mins = facts.get("ttl", 0) // 60
    subprocess.run(
        [exe, "notify", "--title", label or session_id[:8],
         "--subtitle", "crew:blocked",
         "--body", f"cache going stale in {STALE_LEAD}s "
                   f"({mins}m TTL) — prompt now or let it lapse"],
        capture_output=True, timeout=10)
    return 0


# ---------------------------------------------------------------- CLI

def _scan(projects_dir):
    """Corpus sweep: every transcript whole, cause distribution to stdout."""
    import glob
    import collections
    causes = collections.Counter()
    n_breaks = n_files = 0
    tokens = 0
    for path in glob.glob(os.path.join(projects_dir, "*", "*.jsonl")):
        n_files += 1
        try:
            facts = read_facts(path, whole=True)
        except OSError:
            continue
        for b in facts["breaks"]:
            causes[b["cause"]] += 1
            tokens += b["recachedTokens"]
            n_breaks += 1
    print(f"{n_files} transcripts, {n_breaks} breaks, "
          f"{tokens / 1e6:.1f}M tokens re-cached")
    for cause, count in causes.most_common():
        print(f"  {cause:14} {count}")


def main(argv):
    if len(argv) >= 2 and argv[0] == "--scan":
        _scan(os.path.expanduser(argv[1]))
        return 0
    if len(argv) >= 3 and argv[0] == "--stop":
        out = stop_mode(os.path.expanduser(argv[1]), argv[2],
                        argv[3] if len(argv) > 3 else "")
        if out:
            print(out)
        return 0
    if len(argv) >= 3 and argv[0] == "--sleep":
        return sleep_mode(argv[1], os.path.expanduser(argv[2]),
                          argv[3] if len(argv) > 3 else "")
    if not argv:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    path = os.path.expanduser(argv[0])
    facts = read_facts(path)
    facts["generatedAt"] = time.time()
    sid = argv[1] if len(argv) > 1 else ""
    if sid:
        write_facts(sid, facts)
    print(json.dumps(facts, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
