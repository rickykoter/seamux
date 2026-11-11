"""What crew's adapters read from a Claude Code background sub-agent's files.

The explore and scout adapters (crew/adapters/explore, crew/adapters/scout)
both report sub-agents, and both need the same things from one: its meta
file, its transcript's times, model and tokens, which files it read, how
many searches it ran, its answer (the SubagentHandback message), and the
path:line citations in that answer. This folder has no adapter.json, so
seamux never runs it as an adapter; the adapters import it.

The layout (<session>/subagents/agent-<id>.{meta.json,jsonl}) was seen with
Claude Code 2.1.319 and is undocumented (docs/RUNS.md). Read only.
"""
import datetime
import glob
import json
import os
import re
import time

SCHEMA = "seamux.run/1"
STALE_MS = 10 * 60 * 1000
# A search: a Grep or Glob call, or a shell command that runs one.
SEARCH_TOOLS = ("Grep", "Glob")
SEARCH_CMD = re.compile(r"(^|[\s;|&(])(grep|rg|ag|find|fd|git grep)\s")
# path:line, with an optional :line-line range: `app/x.rs:12`, `/w/a.py:3-9`.
CITE = re.compile(r"(?<![\w/.-])((?:/|~/|\.{1,2}/)?[\w.-]+(?:/[\w.-]+)*\.[A-Za-z0-9]+):(\d+)(?:-\d+)?")


def ms(ts):
    """An ISO time from a transcript line, in ms since the epoch."""
    if not ts:
        return None
    try:
        return int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def background_agents(session_dir):
    """(id, meta, transcript path) for each background sub-agent of the session."""
    for meta_path in sorted(glob.glob(os.path.join(glob.escape(session_dir), "subagents", "agent-*.meta.json"))):
        aid = os.path.basename(meta_path)[len("agent-"):-len(".meta.json")]
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(meta, dict) or meta.get("requestShape") != "background":
            continue
        yield aid, meta, os.path.join(session_dir, "subagents", "agent-%s.jsonl" % aid)


class Facts:
    """One pass over a sub-agent's transcript."""

    def __init__(self):
        self.start = self.end = self.model = None
        self.cwd = None
        self.tokens = 0
        self.reads = set()
        self.searches = 0
        self.answer = None
        self.last_text = None


def read(path):
    """The Facts of one transcript, or None when it cannot be opened."""
    f = Facts()
    seen = set()
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            if '"timestamp"' not in line:
                continue
            try:
                v = json.loads(line)
            except ValueError:
                continue
            t = ms(v.get("timestamp"))
            if t:
                f.start = t if f.start is None else min(f.start, t)
                f.end = t if f.end is None else max(f.end, t)
            if f.cwd is None and isinstance(v.get("cwd"), str):
                f.cwd = v["cwd"]
            msg = v.get("message") if isinstance(v.get("message"), dict) else {}
            if v.get("type") != "assistant":
                continue
            if isinstance(msg.get("model"), str) and not msg["model"].startswith("<"):
                f.model = msg["model"]
            mid, usage = msg.get("id"), msg.get("usage") or {}
            if usage and mid not in seen:
                seen.add(mid)
                f.tokens += sum(usage.get(k) or 0 for k in
                                ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
            for b in msg.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and (b.get("text") or "").strip():
                    f.last_text = b["text"].strip()
                if b.get("type") != "tool_use":
                    continue
                name, inp = b.get("name"), b.get("input") or {}
                if name == "Read" and isinstance(inp.get("file_path"), str):
                    f.reads.add(inp["file_path"])
                elif name in SEARCH_TOOLS:
                    f.searches += 1
                elif name == "Bash" and SEARCH_CMD.search(" " + str(inp.get("command") or "")):
                    f.searches += 1
                elif name == "SubagentHandback" and str(inp.get("message") or "").strip():
                    f.answer = str(inp["message"]).strip()
    return f


def citations(text, cwd, known=()):
    """[(absolute path, line)] for each path:line in `text`, in order.
    A short path (`rank.rs`, `src/rank.rs`) is the file among `known` (paths
    the agent read) or already cited whose path ends with it; else it is
    taken from `cwd`. One that cannot be made absolute is dropped."""
    out = []
    for m in CITE.finditer(text or ""):
        p, line = m.group(1), int(m.group(2))
        if p.startswith("~/"):
            p = os.path.expanduser(p)
        elif not p.startswith("/"):
            tail = "/" + os.path.normpath(p).lstrip("./")
            seen = [q for q, _ in out] + sorted(known)
            match = next((q for q in seen if q.endswith(tail)), None)
            if match:
                p = match
            elif cwd:
                p = os.path.normpath(os.path.join(cwd, p))
            else:
                continue
        out.append((p, line))
    return out


def short(path):
    """A file's name with its folder: `src/rank.rs`."""
    parts = path.rstrip("/").split("/")
    return "/".join(parts[-2:]) if len(parts) > 2 else path


def cited_files(cites):
    """[(path, first line, times cited)], most cited first, then by first mention."""
    order, count, first = [], {}, {}
    for p, line in cites:
        if p not in count:
            order.append(p)
            count[p] = 0
            first[p] = line
        count[p] += 1
    return sorted(((p, first[p], count[p]) for p in order), key=lambda x: -x[2])


def status(aid, meta, transcript, listed):
    """done, running or unknown, as the built-in adapter decides it."""
    if meta.get("finished"):
        return "done"
    try:
        touched = int(os.path.getmtime(transcript) * 1000)
    except OSError:
        touched = 0
    now = int(time.time() * 1000)
    return "running" if aid in listed or now - touched < STALE_MS else "unknown"


def first_lines(text, n=14):
    return "\n".join((text or "").strip().splitlines()[:n]) or None


def run(aid, meta, transcript, facts, st, kind):
    """A seamux.run/1 run for one sub-agent, with the built-in's id so it
    replaces the built-in's run. The caller adds badge, metrics and links."""
    done = st == "done"
    label = meta.get("description") or meta.get("agentType") or aid
    answer = facts.answer or facts.last_text
    agent = {"id": aid, "label": label, "model": facts.model or meta.get("model"),
             "state": "done" if done else "running", "start": facts.start,
             "end": facts.end if done else None, "tokens": facts.tokens or None,
             "result": {"detail": first_lines(answer)} if done and answer else None,
             "transcript": transcript if os.path.isfile(transcript) else None}
    return {"id": aid, "kind": kind, "name": label, "task": aid, "status": st,
            "start": facts.start, "end": facts.end if done else None, "agents": [agent]}
