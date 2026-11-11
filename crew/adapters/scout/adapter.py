#!/usr/bin/env python3
"""seamux adapter for deep-plan's scouts (docs/adapters.md).

A scout is a background sub-agent a deep-plan session sends to check one
claim before the plan is written (deep-plan's SKILL.md, step 3). By habit
its description starts with "Scout"; its type may be Explore or any other.
For each one, this reports a run with the built-in's id, so it takes that
run's place (and the Explore adapter's: scout loads after explore):

- group: "Scouts for <slug>", the plan this session owns, from deep-plan's
  state (DEEP_PLAN_STATE_DIR, else ~/.claude/deep-plan/state);
- once that plan's spec is rendered (DEEP_PLAN_KEYS_DIR, else
  ~/.claude/deep-plan/keys/<slug>.spec.json): the verifiedFacts its
  citations back (the same file, within 3 lines) and the risks that name a
  file it cited. The badge reads "3 facts", or "1 risk" when it backed no
  fact; before the spec, the number of citations;
- metrics, links and hover text as the Explore adapter gives them;
- a summary line: "scouts: 4 facts, 1 risk in <slug>".

It reads Claude Code's and deep-plan's files and writes nothing.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import claude_agent as ca  # noqa: E402

SCOUT = re.compile(r"^\s*scout\b", re.I)
NEAR = 3
LINKS_MAX = 8
# A plan rendered this long after a scout started is not the one it scouted for.
AFTER_MS = 6 * 3600 * 1000


def data_dir(env, *parts):
    return os.environ.get(env) or os.path.join(os.path.expanduser("~/.claude"), "deep-plan", *parts)


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def owned_plans(session):
    """[(slug, root, rendered at)] for the plans this session owns."""
    sdir = data_dir("DEEP_PLAN_STATE_DIR", "state")
    out = []
    try:
        names = sorted(os.listdir(sdir))
    except OSError:
        return out
    for n in names:
        if not n.endswith(".json"):
            continue
        st = load(os.path.join(sdir, n))
        if not isinstance(st, dict):
            continue
        owner = st.get("owner") if isinstance(st.get("owner"), dict) else {}
        if session not in (st.get("session"), owner.get("session")):
            continue
        log = [e.get("at") for e in st.get("log") or [] if isinstance(e, dict) and isinstance(e.get("at"), (int, float)) and e.get("at") > 0]
        out.append((st.get("slug") or n[:-5], st.get("root") or "", int(min(log)) if log else 0))
    return out


def plan_for(plans, start):
    """The plan a scout that started at `start` worked for: the first one
    rendered after it (scouts run before the spec), else the last before."""
    after = [p for p in plans if p[2] >= (start or 0) and p[2] - (start or 0) <= AFTER_MS]
    if after:
        return min(after, key=lambda p: p[2])
    before = [p for p in plans if p[2] < (start or 0)]
    return max(before, key=lambda p: p[2]) if before else None


def rel(path, root):
    root = root.rstrip("/") + "/"
    return path[len(root):] if root != "/" and path.startswith(root) else path


def spec_of(slug):
    return load(os.path.join(data_dir("DEEP_PLAN_KEYS_DIR", "keys"), slug + ".spec.json"))


def backed(spec, cites, root):
    """(facts, risks), each a set of indices into the spec's lists: the
    verifiedFacts within NEAR lines of a citation in the same file, and the
    risks that name a cited file."""
    cited = [(rel(p, root), line) for p, line in cites]
    facts = set()
    for i, f in enumerate(spec.get("verifiedFacts") or []):
        ev = str((f or {}).get("evidence") or "") if isinstance(f, dict) else ""
        m = re.match(r"^(.+?):(\d+)", ev)
        if m and any(p == m.group(1) and abs(line - int(m.group(2))) <= NEAR for p, line in cited):
            facts.add(i)
    names = {p for p, _ in cited} | {os.path.basename(p) for p, _ in cited}
    risks = set()
    for i, r in enumerate(spec.get("risks") or []):
        text = r if isinstance(r, str) else str((r or {}).get("risk") or "")
        if any(re.search(r"(?<![\w/.-])" + re.escape(n) + r"(?![\w-])", text) for n in names):
            risks.add(i)
    return facts, risks


def plural(n, word):
    return "%d %s%s" % (n, word, "" if n == 1 else "s")


def main():
    ctx = json.load(sys.stdin)
    sdir = ctx.get("sessionDir") or ""
    listed = {b.get("id") for b in ctx.get("background", [])}
    plans = owned_plans(ctx.get("session") or "")
    specs = {}
    totals = {}
    runs = []
    for aid, meta, transcript in ca.background_agents(sdir):
        if not SCOUT.search(str(meta.get("description") or "")):
            continue
        facts = ca.read(transcript)
        if facts is None:
            continue
        st = ca.status(aid, meta, transcript, listed)
        r = ca.run(aid, meta, transcript, facts, st, "scout")
        cites = ca.citations(facts.answer or "", facts.cwd, facts.reads)
        files = ca.cited_files(cites)
        plan = plan_for(plans, facts.start)
        metrics = []
        badge = None
        if plan:
            slug, root, at = plan
            r["group"] = {"id": "plan:" + slug, "label": "Scouts for " + slug, "kind": "plan", "at": at or None}
            if slug not in specs:
                specs[slug] = spec_of(slug)
            spec = specs[slug]
            if isinstance(spec, dict) and facts.answer:
                fs, rs = backed(spec, cites, root or facts.cwd or "")
                nf, nr = len(fs), len(rs)
                metrics += [{"label": "facts", "value": nf}, {"label": "risks", "value": nr}]
                badge = plural(nf, "fact") if nf else plural(nr, "risk") if nr else None
                # The summary counts each fact and risk once, whichever scouts backed it.
                t = totals.setdefault(slug, [set(), set()])
                t[0] |= fs
                t[1] |= rs
        if facts.answer:
            metrics.append({"label": "cites", "value": len(cites)})
            if badge is None:
                badge = plural(len(cites), "cite")
        metrics.append({"label": "read", "value": len(facts.reads)})
        r["metrics"] = metrics[:4]
        if badge and r["agents"][0]["result"] is not None:
            r["agents"][0]["result"]["badge"] = badge
        r["links"] = [{"label": ca.short(p), "file": p, "line": line} for p, line, _ in files[:LINKS_MAX]]
        runs.append(r)
    runs.sort(key=lambda r: r.get("start") or 0, reverse=True)
    doc = {"schema": ca.SCHEMA, "runs": runs[:50]}
    if totals:
        doc["summary"] = "; ".join("scouts: %s, %s in %s" % (plural(len(f), "fact"), plural(len(k), "risk"), s)
                                   for s, (f, k) in sorted(totals.items()))
    json.dump(doc, sys.stdout)


if __name__ == "__main__":
    main()
