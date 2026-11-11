#!/usr/bin/env python3
"""seamux adapter for lookout reviewers (docs/adapters.md, docs/RUNS.md).

A lookout reviewer is a background sub-agent whose brief tells it to run
`lookout findings add <review-id> <file>`. For each such sub-agent in the
session, this reports a run with the same id as the built-in
claude-subagents adapter's, so it replaces that run with a richer one:
the findings this reviewer added (those created while it ran) as its
result, a badge such as "2 major" or "clean", those findings by severity as
metrics, and the review page as a link (and in the hover text). Its
summary line counts what is still open across the session's reviews:
"lookout: 2 major open across 1 review".

It reads Claude Code's files (<session>/subagents/agent-<id>.{jsonl,meta.json})
and lookout's review store (~/.claude/plans/reviews/<id>.json, or
$SEAMUX_LOOKOUT_REVIEWS). It writes nothing.
"""
import datetime
import glob
import json
import os
import re
import sys
import time

SCHEMA = "seamux.run/1"
SEVERITIES = ["blocker", "major", "minor", "nit"]
REVIEW_ID = re.compile(r"lookout findings add ([A-Za-z0-9][A-Za-z0-9._-]*)")
STALE_MS = 10 * 60 * 1000
# A transcript untouched this long is left to the built-in adapter.
OLD_S = 24 * 3600


def ms(ts):
    """An ISO time (a transcript line's or the store's) in ms, or None."""
    if not ts:
        return None
    try:
        return int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def review_named(v):
    """The review id a transcript line gives a reviewer: a Bash call of its
    own that runs `lookout findings add <id>`, or its prompt or brief (a
    user line) telling it to."""
    msg = v.get("message") or {}
    content = msg.get("content") if isinstance(msg, dict) else None
    texts = []
    if v.get("type") == "user":
        if isinstance(content, str):
            texts.append(content)
        for b in content if isinstance(content, list) else []:
            c = b.get("content") if isinstance(b, dict) else None
            texts.extend([c] if isinstance(c, str) else [x.get("text", "") for x in c or [] if isinstance(x, dict)])
    elif v.get("type") == "assistant":
        for b in content if isinstance(content, list) else []:
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Bash":
                texts.append((b.get("input") or {}).get("command") or "")
    for t in texts:
        m = REVIEW_ID.search(t or "")
        if m:
            return m.group(1)
    return None


def read_transcript(path):
    """(review id, start, end, model, tokens) from one sub-agent's transcript."""
    review, start, end, model, tokens, seen = None, None, None, None, 0, set()
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None
    with f:
        for line in f:
            if '"timestamp"' not in line:
                continue
            try:
                v = json.loads(line)
            except ValueError:
                continue
            if review is None and "lookout findings add" in line:
                review = review_named(v)
            t = ms(v.get("timestamp"))
            if t:
                start = t if start is None else min(start, t)
                end = t if end is None else max(end, t)
            msg = v.get("message") or {}
            if v.get("type") == "assistant" and isinstance(msg, dict):
                if isinstance(msg.get("model"), str) and not msg["model"].startswith("<"):
                    model = msg["model"]
                mid, usage = msg.get("id"), msg.get("usage") or {}
                if usage and mid not in seen:
                    seen.add(mid)
                    tokens += sum(usage.get(k) or 0 for k in
                                  ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return review, start, end, model, tokens


def store_dir():
    return os.environ.get("SEAMUX_LOOKOUT_REVIEWS") or os.path.expanduser("~/.claude/plans/reviews")


def review_url(review):
    """The review page on crew's intent server, when it is up."""
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    try:
        port = open(os.path.join(cache, "cmux-crew", "board-intent.port")).read().strip()
    except OSError:
        return None
    return "http://127.0.0.1:%s/review/%s" % (port, review) if port.isdigit() else None


def load_store(review):
    try:
        with open(os.path.join(store_dir(), review + ".json"), encoding="utf-8") as f:
            store = json.load(f)
    except (OSError, ValueError):
        return None
    return store if isinstance(store, dict) else None


CLOSED = ("resolved", "dismissed")


def open_counts(store):
    """The review's findings still open, by severity."""
    live = [f for f in store.get("findings", []) if f.get("status", "open") not in CLOSED]
    return {s: sum(1 for f in live if f.get("severity") == s) for s in SEVERITIES}


def summary_of(reviews):
    """One line for the session: what is open across its reviewers' reviews."""
    total = {s: 0 for s in SEVERITIES}
    n = 0
    for review in reviews:
        store = load_store(review)
        if store is None:
            continue
        n += 1
        for s, c in open_counts(store).items():
            total[s] += c
    if not n:
        return None
    what = ", ".join("%d %s" % (total[s], s) for s in SEVERITIES if total[s]) or "nothing"
    return "lookout: %s open across %d review%s" % (what, n, "" if n == 1 else "s")


def result_of(review, start, end, done):
    """(badge, detail, counts) from the findings this reviewer added."""
    store = load_store(review)
    if store is None:
        return None, "lookout review %s (its store could not be read)" % review, {}
    hi = (end if done and end else int(time.time() * 1000)) + 5000
    inside = lambda t: start is not None and t is not None and start <= t <= hi
    # The findings a reviewer filed while it ran: not a person's, and not
    # another round's.
    mine = [f for f in store.get("findings", [])
            if f.get("by", "reviewer") == "reviewer" and inside(ms(f.get("createdAt")))]
    counts = {s: sum(1 for f in mine if f.get("severity") == s) for s in SEVERITIES}
    top = next((s for s in SEVERITIES if counts[s]), None)
    # "clean" only when its ingest landed: the review says it was reviewed
    # while this reviewer ran.
    ingested = inside(ms(store.get("reviewedAt")))
    badge = ("%d %s" % (counts[top], top)) if top else ("clean" if done and ingested else None)
    lines = ["%s · %s" % (store.get("title") or review, ", ".join("%d %s" % (counts[s], s) for s in SEVERITIES))]
    for f in mine:
        where = "%s:%s" % (os.path.basename(f.get("file") or ""), f.get("line") or "")
        lines.append("%-7s %-4s %s  %s" % (f.get("severity", ""), f.get("id", ""), where,
                                          f.get("short_summary") or f.get("summary") or ""))
    url = review_url(review)
    if url:
        lines.append("")
        lines.append("Review page: " + url)
    return badge, "\n".join(lines), counts


def main():
    ctx = json.load(sys.stdin)
    sdir = ctx.get("sessionDir") or ""
    listed = {b.get("id") for b in ctx.get("background", [])}
    now = int(time.time() * 1000)
    runs = []
    reviews = []
    for meta_path in glob.glob(os.path.join(glob.escape(sdir), "subagents", "agent-*.meta.json")):
        aid = os.path.basename(meta_path)[len("agent-"):-len(".meta.json")]
        try:
            meta = json.load(open(meta_path))
        except (OSError, ValueError):
            continue
        if meta.get("requestShape") != "background":
            continue
        tr = os.path.join(sdir, "subagents", "agent-%s.jsonl" % aid)
        try:
            if time.time() - os.path.getmtime(tr) > OLD_S:
                continue
        except OSError:
            continue
        got = read_transcript(tr)
        if not got or not got[0]:
            continue  # not a lookout reviewer: the built-in adapter reports it
        review, start, end, model, tokens = got
        done = bool(meta.get("finished"))
        try:
            touched = int(os.path.getmtime(tr) * 1000)
        except OSError:
            touched = 0
        status = "done" if done else ("running" if aid in listed or now - touched < STALE_MS else "unknown")
        badge, detail, counts = result_of(review, start, end, done)
        if review not in reviews:
            reviews.append(review)
        label = meta.get("description") or "lookout review"
        agent = {"id": aid, "label": label, "model": model or meta.get("model"), "state": "done" if done else "running",
                 "start": start, "end": end if done else None, "tokens": tokens or None,
                 "result": {"badge": badge, "detail": detail}, "transcript": tr if os.path.isfile(tr) else None}
        url = review_url(review)
        runs.append({"id": aid, "kind": "lookout", "name": label, "task": aid, "status": status,
                     "start": start, "end": end if done else None, "agents": [agent],
                     "metrics": [{"label": s, "value": counts[s]} for s in SEVERITIES if counts.get(s)][:4],
                     "links": [{"label": "review page", "url": url}] if url else []})
    runs.sort(key=lambda r: r.get("start") or 0, reverse=True)
    doc = {"schema": SCHEMA, "runs": runs[:20]}
    summary = summary_of(reviews)
    if summary:
        doc["summary"] = summary
    json.dump(doc, sys.stdout)


if __name__ == "__main__":
    main()
