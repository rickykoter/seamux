#!/usr/bin/env python3
"""seamux adapter for Claude Code's Explore sub-agents (docs/adapters.md).

An Explore agent searches a codebase and hands back an answer full of
path:line citations. For each background sub-agent whose agentType is
Explore, this reports a run with the built-in claude-subagents adapter's id,
so it takes that run's place with more to show:

- badge: how many distinct files its answer cites ("14 files");
- metrics: files read, searches run, citations;
- links: the cited files, most cited first, each at its first cited line
  (the session page opens one in VS Code when it is inside the worktree);
- hover text: the answer's opening lines.

It reads the session's Claude Code files and writes nothing.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import claude_agent as ca  # noqa: E402

LINKS_MAX = 8
RUNS_MAX = 50


def explore_run(aid, meta, transcript, listed, cache):
    """The run for one Explore agent, or None when its transcript is gone."""
    facts = cache.read(transcript)
    if facts is None:
        return None
    st = ca.status(aid, meta, transcript, listed)
    r = ca.run(aid, meta, transcript, facts, st, "explore")
    cites = ca.citations(facts.answer or "", facts.cwd, facts.reads)
    files = ca.cited_files(cites)
    r["metrics"] = [{"label": "read", "value": len(facts.reads)}, {"label": "searches", "value": facts.searches}]
    if facts.answer:
        r["metrics"].append({"label": "cites", "value": len(cites)})
        if files:
            r["agents"][0]["result"] = dict(r["agents"][0]["result"] or {}, badge="%d file%s" % (len(files), "" if len(files) == 1 else "s"))
    r["links"] = [{"label": ca.short(p), "file": p, "line": line} for p, line, _ in files[:LINKS_MAX]]
    return r


def main():
    ctx = json.load(sys.stdin)
    sdir = ctx.get("sessionDir") or ""
    listed = {b.get("id") for b in ctx.get("background", [])}
    runs = []
    cache = ca.Cache()
    for aid, meta, transcript in ca.background_agents(sdir):
        if meta.get("agentType") != "Explore":
            continue
        r = explore_run(aid, meta, transcript, listed, cache)
        if r:
            runs.append(r)
    cache.save()
    runs.sort(key=lambda r: r.get("start") or 0, reverse=True)
    json.dump({"schema": ca.SCHEMA, "runs": runs[:RUNS_MAX]}, sys.stdout)


if __name__ == "__main__":
    main()
