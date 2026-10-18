#!/usr/bin/env python3
"""The Artifact Log's store and indexer: what each workspace's sessions made.

    index()                       rescan changed transcripts and the stores
    backfill()                    forget every cursor, then index everything
    search(q, ws, kind, limit)    rows, newest first; q goes through FTS5
    workspaces()                  every workspace in the db, with counts
    row(id)                       one row by id

    artifacts.py index|backfill   the same, from a shell (crew-artifacts wraps it)

One SQLite file, ~/.claude/crew/artifacts.db, holds every workspace. A row is
a pointer plus its context: what was made (a file path, a claude.ai URL, a
commit), and when, by which session on which branch, answering which prompt.
Nothing is copied here; Keep (a click on the page) is the only copier.

Rows are derived, never captured live. Transcripts already record every
Write, every Artifact publish with its URL and every commit, with cwd,
session, branch and timestamp on each line, so index() reads each transcript
from the offset it stopped at last time, subagent transcripts included.
Files made through Bash variables (> $S/x.py) never show up as a literal
path, so each session's scratchpad directory is listed instead. Plan, review
and ask rows come from their own stores in ~/.claude/deep-plan and
~/.claude/plans.

The transcript is Claude Code's internal format. Every field is read with
.get() and every extractor is fenced on its own, so a line that moved shape
costs that one row, never the run. Python 3.9 compatible: /usr/bin/python3
runs this from the Stop hook on machines without Homebrew.
"""
import bisect
import calendar
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
# Env overrides exist for the probes, and only for the probes.
CREW_HOME = os.environ.get("CREW_DURABLE_DIR") or os.path.join(HOME, ".claude", "crew")
DB = os.path.join(CREW_HOME, "artifacts.db")
LOCK = os.path.join(CREW_HOME, "index.lock")
AGAIN = LOCK + ".again"
PROJECTS = os.path.join(HOME, ".claude", "projects")
PLANS = os.path.join(HOME, ".claude", "plans")
DP_STATE = os.path.join(HOME, ".claude", "deep-plan", "state")
# Claude Code's per-session scratchpads: <base>/<project dir name>/<session>/scratchpad.
SCRATCH_BASE = os.environ.get("CREW_SCRATCH_BASE") or "/private/tmp/claude-%d" % os.getuid()

VERSION = 1
PROMPT_MAX = 500
TEMP_ROOTS = tuple(os.environ["CREW_TEMP_ROOTS"].split(":")) if os.environ.get("CREW_TEMP_ROOTS") \
    else ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".bmp", ".tiff"}
DOC_EXT = {".md", ".markdown", ".html", ".htm"}
KINDS = ("plan", "review", "ask", "artifact", "temp", "image", "doc", "file", "commit")
# A scratchpad can hold a fixture repo; these are not anyone's artifact.
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".cache"}
SCRATCH_CAP = 400           # files listed per scratchpad, at most

COMMIT_RE = re.compile(r"^\[([^\]\n]+?) ([0-9a-f]{7,40})\] (.+)$", re.M)
CHANGED_RE = re.compile(r"\b\d+ files? changed\b")
GIT_COMMIT_RE = re.compile(r"\bgit\b[^;&|\n]*?\bcommit\b")
ONELINE_RE = re.compile(r"^([0-9a-f]{7,40}) (.+)$")
TMP_REDIRECT_RE = re.compile(
    r"(?:>>?|\btee(?:\s+-a)?)\s*((?:/private)?/tmp/[^\s;|&<>'\"`$()]+)")
REMINDER_RE = re.compile(
    r"<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>"
    r".*?</\1>", re.S)
TAG_RE = re.compile(r"</?[a-z][a-z0-9-]*>")
COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
GITHUB_RE = re.compile(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY,
  ws TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', locator TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  sha TEXT NOT NULL DEFAULT '', was_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  kept_at TEXT,
  UNIQUE(ws, kind, locator));
CREATE INDEX IF NOT EXISTS artifacts_ws ON artifacts(ws, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  title, path, url, prompt, content='artifacts', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, title, path, url, prompt)
  VALUES (new.id, new.title, new.path, new.url, new.prompt);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, path, url, prompt)
  VALUES ('delete', old.id, old.title, old.path, old.url, old.prompt);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, path, url, prompt)
  VALUES ('delete', old.id, old.title, old.path, old.url, old.prompt);
  INSERT INTO artifacts_fts(rowid, title, path, url, prompt)
  VALUES (new.id, new.title, new.path, new.url, new.prompt);
END;
CREATE TABLE IF NOT EXISTS cursors(
  transcript TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, mtime REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL);
"""

# An upsert never blanks what an earlier pass learned: a kept row keeps its
# copy's path, the first prompt and session stay, and the time span widens.
UPSERT = """
INSERT INTO artifacts(ws, repo, kind, title, locator, path, url, sha,
                      created_at, updated_at, session_id, branch, prompt, source)
VALUES (:ws, :repo, :kind, :title, :locator, :path, :url, :sha,
        :created_at, :updated_at, :session_id, :branch, :prompt, :source)
ON CONFLICT(ws, kind, locator) DO UPDATE SET
  repo = CASE WHEN excluded.repo <> '' THEN excluded.repo ELSE repo END,
  title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
  path = CASE WHEN kept_at IS NULL AND excluded.path <> '' THEN excluded.path ELSE path END,
  url = CASE WHEN excluded.url <> '' THEN excluded.url ELSE url END,
  sha = CASE WHEN excluded.sha <> '' THEN excluded.sha ELSE sha END,
  created_at = CASE WHEN created_at = '' OR (excluded.created_at <> ''
                    AND excluded.created_at < created_at)
               THEN excluded.created_at ELSE created_at END,
  updated_at = CASE WHEN excluded.updated_at > updated_at
               THEN excluded.updated_at ELSE updated_at END,
  session_id = CASE WHEN session_id = '' THEN excluded.session_id ELSE session_id END,
  branch = CASE WHEN branch = '' THEN excluded.branch ELSE branch END,
  prompt = CASE WHEN prompt = '' THEN excluded.prompt ELSE prompt END,
  source = CASE WHEN source = '' THEN excluded.source ELSE source END
"""
FIELDS = ("ws", "repo", "kind", "title", "locator", "path", "url", "sha",
          "created_at", "updated_at", "session_id", "branch", "prompt", "source")


def connect():
    """Open (and create or migrate) the store. The directory is 0700: the db
    holds prompt excerpts and kept/ holds copies of temp files."""
    os.makedirs(CREW_HOME, mode=0o700, exist_ok=True)
    try:
        os.chmod(CREW_HOME, 0o700)
    except OSError:
        pass
    db = sqlite3.connect(DB, timeout=30, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout = 30000")
    db.execute("PRAGMA journal_mode = WAL")
    migrate(db)
    return db


def migrate(db):
    """Migrations run by meta.version. Version 1 is the first schema."""
    have = 0
    try:
        r = db.execute("SELECT version FROM meta").fetchone()
        have = r[0] if r else 0
    except sqlite3.OperationalError:
        pass
    if have >= VERSION:
        return
    db.execute("BEGIN IMMEDIATE")
    try:
        for stmt in _statements(SCHEMA):
            db.execute(stmt)
        db.execute("DELETE FROM meta")
        db.execute("INSERT INTO meta(version) VALUES (?)", (VERSION,))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def _statements(script):
    """Split SCHEMA into statements, keeping trigger bodies whole."""
    out, cur = [], []
    for line in script.splitlines():
        if not line.strip():
            continue
        cur.append(line)
        joined = "\n".join(cur).strip()
        if joined.endswith(";") and sqlite3.complete_statement(joined):
            out.append(joined)
            cur = []
    return out


# ---------------------------------------------------------------- context


def iso(ts):
    """Epoch seconds to the transcript's own ISO form, so strings sort."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + ".%03dZ" % int((ts % 1) * 1000)


def clean_prompt(text):
    """The human's words: reminders and command scaffolding stripped,
    whitespace folded, 500 characters."""
    if not isinstance(text, str):
        return ""
    m = COMMAND_RE.search(text)
    if m:
        # A slash command reads as what was typed: /name args.
        args = COMMAND_ARGS_RE.search(text)
        text = m.group(1).strip() + " " + (args.group(1) if args else "")
    text = REMINDER_RE.sub(" ", text)
    text = TAG_RE.sub(" ", text)
    text = " ".join(text.split())
    return text[:PROMPT_MAX]


def prompt_of(d):
    """A user line's prompt text, or None when the line is not a prompt
    (a tool result, a meta line, a compaction summary)."""
    if d.get("type") != "user" or d.get("isMeta") or d.get("isCompactSummary"):
        return None
    content = (d.get("message") or {}).get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_result":
                return None
            if c.get("type") == "text":
                parts.append(c.get("text") or "")
        text = "\n".join(parts)
    else:
        return None
    text = clean_prompt(text)
    return text or None


class Timeline(object):
    """(timestamp, prompt) pairs for one transcript, in order; at(ts) is the
    prompt in flight at that moment."""

    def __init__(self):
        self.ts, self.text = [], []

    def add(self, ts, text):
        if ts and text:
            i = bisect.bisect_right(self.ts, ts)
            self.ts.insert(i, ts)
            self.text.insert(i, text)

    def at(self, ts):
        i = bisect.bisect_right(self.ts, ts or "")
        return self.text[i - 1] if i else ""


def full_timeline(path):
    """Every prompt in a transcript. Only user lines are parsed."""
    tl = Timeline()
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                # A byte-level prefilter: only user lines can be prompts.
                if b'"user"' not in raw or b'"tool_result"' in raw:
                    continue
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(d, dict):
                    tl.add(d.get("timestamp") or "", prompt_of(d))
    except OSError:
        pass
    return tl


_git_cache = {}


def git_facts(cwd):
    """(repo toplevel, GitHub web base) for a cwd, asked once per run. Empty
    strings when the directory is gone or not a git checkout."""
    if cwd in _git_cache:
        return _git_cache[cwd]
    top, web = "", ""
    if cwd and os.path.isdir(cwd):
        def git(*args):
            try:
                p = subprocess.run(["git", "-C", cwd] + list(args), capture_output=True,
                                   text=True, timeout=5)
                return p.stdout.strip() if p.returncode == 0 else ""
            except (OSError, subprocess.SubprocessError):
                return ""
        common = git("rev-parse", "--path-format=absolute", "--git-common-dir")
        if common:
            top = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        m = GITHUB_RE.search(git("remote", "get-url", "origin"))
        if m:
            web = "https://github.com/%s/%s" % (m.group(1), m.group(2))
    _git_cache[cwd] = (top, web)
    return top, web


def full_sha(cwd, sha):
    if not (cwd and os.path.isdir(cwd)):
        return ""
    try:
        p = subprocess.run(["git", "-C", cwd, "rev-parse", "--verify", "-q", sha + "^{commit}"],
                           capture_output=True, text=True, timeout=5)
        return p.stdout.strip() if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _epoch(ts):
    try:
        return calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return None


def quiet_commit(cwd, out, ts):
    """The commit a `git commit -q` made, which prints no [branch sha] line.
    First a `<sha> <subject>` line in the same output (a trailing `git log
    --oneline -1`) that names a real commit; else the commit HEAD gained in
    the two minutes before the result, asked while the worktree exists."""
    for line in out.splitlines():
        m = ONELINE_RE.match(line.strip())
        if m and full_sha(cwd, m.group(1)):
            return [(m.group(1), m.group(2).strip())]
    at = _epoch(ts)
    if at is None or not (cwd and os.path.isdir(cwd)):
        return []
    try:
        p = subprocess.run(["git", "-C", cwd, "log", "-n", "5", "--format=%h%x09%ct%x09%s", "HEAD"],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return []
    best = None
    for line in p.stdout.splitlines() if p.returncode == 0 else []:
        parts = line.split("\t", 2)
        if len(parts) == 3 and parts[1].isdigit() and at - 120 <= int(parts[1]) <= at + 5:
            if best is None or int(parts[1]) > best[0]:
                best = (int(parts[1]), parts[0], parts[2])
    return [(best[1], best[2])] if best else []


# ---------------------------------------------------------------- classify


def norm(path):
    """Absolute, with the directory's symlinks resolved (/tmp is
    /private/tmp here), so one file is one locator."""
    path = os.path.normpath(os.path.expanduser(path))
    d, b = os.path.split(path)
    return os.path.join(os.path.realpath(d), b)


def under(path, root):
    root = root.rstrip("/") + "/"
    return path.startswith(root)


def is_temp(path):
    return any(path.startswith(r) for r in TEMP_ROOTS)


def classify(path, cwd):
    """A written file's kind, or None when it is not an artifact: source code
    in the workspace (git records it) and Claude Code's own transcripts. A
    doc in a workspace that itself sits in /tmp is still a doc; the page
    flags it at risk by its path, whatever its kind."""
    if under(path, PROJECTS):
        return None
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if cwd and under(path, norm(cwd)):
        return "doc" if ext in DOC_EXT else None
    if is_temp(path):
        return "temp"
    if under(path, HOME):
        return "file"
    return None


def birth(st):
    return getattr(st, "st_birthtime", None) or st.st_mtime


# ---------------------------------------------------------------- indexer


class Scan(object):
    """One transcript's rows, collected before the transaction opens."""

    def __init__(self, path, offset):
        self.path = path
        self.offset = offset
        self.rows = []
        self.links = []          # (path, url): Artifact publishes to reconcile
        self.tl = Timeline()
        self.complete_tl = offset == 0
        self.tools = {}          # tool_use id -> (name, input)
        self.cwd = ""
        self.session = ""
        self.branch = ""
        self.first_ts = ""
        proj = os.path.basename(os.path.dirname(path))
        self.subagent = proj == "subagents"
        self.parent = None
        if self.subagent:
            # <proj>/<session>/subagents/agent-*.jsonl: the human's prompt is
            # in the parent's transcript, <proj>/<session>.jsonl.
            sess_dir = os.path.dirname(os.path.dirname(path))
            self.parent = sess_dir + ".jsonl"

    _timelines = {}

    def prompt_at(self, ts):
        if self.subagent:
            tl = Scan._timelines.get(self.parent)
            if tl is None:
                tl = Scan._timelines[self.parent] = full_timeline(self.parent)
            return tl.at(ts)
        if not self.complete_tl:
            # The chunk started mid-transcript: the prompt in flight may sit
            # before the offset. Read the whole file's prompts once.
            whole = full_timeline(self.path)
            for t, x in zip(self.tl.ts, self.tl.text):
                whole.add(t, x)
            self.tl, self.complete_tl = whole, True
        return self.tl.at(ts)

    def add(self, d, kind, locator, title="", path="", url="", sha=""):
        cwd = d.get("cwd") or self.cwd
        ts = d.get("timestamp") or ""
        repo, _ = git_facts(cwd)
        self.rows.append({
            "ws": cwd, "repo": repo, "kind": kind, "title": title, "locator": locator,
            "path": path, "url": url, "sha": sha, "created_at": ts, "updated_at": ts,
            "session_id": d.get("sessionId") or self.session,
            "branch": d.get("gitBranch") or self.branch,
            "prompt": None, "_ts": ts, "source": self.path})

    def line(self, d):
        if not isinstance(d, dict):
            return
        self.cwd = d.get("cwd") or self.cwd
        self.session = d.get("sessionId") or self.session
        self.branch = d.get("gitBranch") or self.branch
        ts = d.get("timestamp") or ""
        if ts and not self.first_ts:
            self.first_ts = ts
        p = prompt_of(d)
        if p:
            self.tl.add(ts, p)
            return
        for fn in (self._tool_uses, self._tool_result):
            try:
                fn(d)
            except Exception:
                pass                      # a line that moved shape costs only itself

    def _tool_uses(self, d):
        if d.get("type") != "assistant":
            return
        for c in (d.get("message") or {}).get("content") or []:
            if not (isinstance(c, dict) and c.get("type") == "tool_use"):
                continue
            name, inp = c.get("name"), c.get("input") or {}
            self.tools[c.get("id")] = (name, inp)
            if name == "Write" and isinstance(inp.get("file_path"), str):
                self._file(d, inp["file_path"])
            elif name == "Bash" and isinstance(inp.get("command"), str):
                for m in TMP_REDIRECT_RE.finditer(inp["command"]):
                    self._file(d, m.group(1))

    def _file(self, d, raw):
        p = norm(raw)
        kind = classify(p, d.get("cwd") or self.cwd)
        if kind:
            self.add(d, kind, p, title=os.path.basename(p), path=p)

    def _tool_result(self, d):
        r = d.get("toolUseResult")
        if not isinstance(r, dict):
            return
        url = r.get("url")
        if isinstance(url, str) and url.startswith("https://claude.ai/"):
            path = r.get("path") if isinstance(r.get("path"), str) else ""
            self.add(d, "artifact", url, title=r.get("title") or os.path.basename(path) or url,
                     path=path, url=url)
            if path:
                self.links.append((norm(path), url))
            return
        out = r.get("stdout")
        if not isinstance(out, str):
            return
        use = None
        for c in (d.get("message") or {}).get("content") or []:
            if isinstance(c, dict) and c.get("type") == "tool_result":
                use = self.tools.get(c.get("tool_use_id"))
        cmd = (use[1].get("command") or "") if use and use[0] == "Bash" else ""
        committed = bool(GIT_COMMIT_RE.search(cmd))
        if not (committed or ("] " in out and CHANGED_RE.search(out))):
            return
        cwd = d.get("cwd") or self.cwd
        found = [(m.group(2), m.group(3).strip()) for m in COMMIT_RE.finditer(out)]
        if not found and committed and not r.get("interrupted"):
            found = quiet_commit(cwd, out, d.get("timestamp") or "")
        _, web = git_facts(cwd)
        for short, subject in found:
            sha = full_sha(cwd, short) or short
            # Seven characters, however many git printed: one commit, one row.
            self.add(d, "commit", short[:7], title=subject, sha=sha,
                     url=("%s/commit/%s" % (web, sha)) if web else "")

    def scratchpad(self):
        """Every file in this session's scratchpad, dated by birth time."""
        if self.subagent or not self.session:
            return
        proj = os.path.basename(os.path.dirname(self.path))
        root = os.path.join(SCRATCH_BASE, proj, self.session, "scratchpad")
        if not os.path.isdir(root):
            return
        root = norm(root)
        n = 0
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(x for x in dirnames if x not in SKIP_DIRS)
            for fn in sorted(filenames):
                if n >= SCRATCH_CAP:
                    return
                p = os.path.join(dirpath, fn)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                n += 1
                kind = "image" if os.path.splitext(fn)[1].lower() in IMAGE_EXT else "temp"
                ts = iso(birth(st))
                d = {"cwd": self.cwd, "timestamp": ts, "sessionId": self.session,
                     "gitBranch": self.branch}
                self.add(d, kind, p, title=os.path.relpath(p, root), path=p)
                self.rows[-1]["updated_at"] = iso(st.st_mtime)

    def finish(self):
        for r in self.rows:
            if r["prompt"] is None:
                r["prompt"] = self.prompt_at(r.pop("_ts")) if r["_ts"] else ""
            r.pop("_ts", None)


def scan_transcript(path, offset):
    """Read complete lines from offset; return (Scan, new offset)."""
    sc = Scan(path, offset)
    end = offset
    with open(path, "rb") as fh:
        fh.seek(offset)
        data = fh.read()
    cut = data.rfind(b"\n")
    if cut < 0:
        return sc, offset
    end = offset + cut + 1
    for raw in data[:cut].split(b"\n"):
        if not raw.strip():
            continue
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        sc.line(d)
    return sc, end


def transcripts():
    """Every session transcript and its subagents' transcripts."""
    out = []
    try:
        projects = os.listdir(PROJECTS)
    except OSError:
        return out
    for proj in projects:
        pd = os.path.join(PROJECTS, proj)
        try:
            names = os.listdir(pd)
        except OSError:
            continue
        for n in names:
            p = os.path.join(pd, n)
            if n.endswith(".jsonl"):
                out.append(p)
            elif os.path.isdir(os.path.join(p, "subagents")):
                sub = os.path.join(p, "subagents")
                try:
                    out.extend(os.path.join(sub, s) for s in os.listdir(sub)
                               if s.endswith(".jsonl"))
                except OSError:
                    pass
    return sorted(out)


def write_rows(db, rows):
    for r in rows:
        if r.get("ws") and r.get("locator"):
            db.execute(UPSERT, {k: r.get(k) or "" for k in FIELDS})


def reconcile(db, links):
    """An Artifact publish names the file it sent: that file's own rows gain
    the URL (how a Publish from the page lands even if its run's stdout was
    lost)."""
    for path, url in links:
        db.execute("UPDATE artifacts SET url = ? WHERE kind <> 'artifact' AND url = '' "
                   "AND (path = ? OR locator = ? OR was_path = ?)", (url, path, path, path))


def index_transcript(db, path):
    """One transcript, if its size or mtime moved since its cursor."""
    try:
        st = os.stat(path)
    except OSError:
        return 0
    cur = db.execute("SELECT offset, size, mtime FROM cursors WHERE transcript = ?",
                     (path,)).fetchone()
    offset = 0
    if cur:
        if cur["size"] == st.st_size and cur["mtime"] == st.st_mtime:
            return 0
        offset = cur["offset"] if cur["offset"] <= st.st_size else 0
    try:
        sc, end = scan_transcript(path, offset)
        sc.scratchpad()
        sc.finish()
    except OSError:
        return 0
    db.execute("BEGIN IMMEDIATE")
    try:
        write_rows(db, sc.rows)
        reconcile(db, sc.links)
        db.execute("INSERT INTO cursors(transcript, offset, size, mtime) VALUES (?,?,?,?) "
                   "ON CONFLICT(transcript) DO UPDATE SET offset = excluded.offset, "
                   "size = excluded.size, mtime = excluded.mtime",
                   (path, end, st.st_size, st.st_mtime))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return len(sc.rows)


def _load(path):
    try:
        with open(path) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def _ms_iso(ms):
    try:
        return iso(float(ms) / 1000.0)
    except (TypeError, ValueError):
        return ""


def _heading(md):
    try:
        with open(md) as fh:
            for line in fh:
                if line.startswith("# "):
                    return line[2:].strip()
    except OSError:
        pass
    return ""


def store_rows():
    """Plan, review and ask rows from their own stores, keyed by root or cwd."""
    rows = []

    def row(**kw):
        r = dict.fromkeys(FIELDS, "")
        r.update(kw)
        r["repo"] = git_facts(r["ws"])[0] if r["ws"] else ""
        rows.append(r)

    try:
        names = sorted(os.listdir(DP_STATE))
    except OSError:
        names = []
    for n in names:
        if not n.endswith(".json"):
            continue
        d = _load(os.path.join(DP_STATE, n))
        if not d or not isinstance(d.get("root"), str):
            continue
        try:
            slug = d.get("slug") or n[:-5]
            log = d.get("log") if isinstance(d.get("log"), list) else []
            ats = [e.get("at") for e in log if isinstance(e, dict) and e.get("at")]
            md = os.path.join(PLANS, slug + ".md")
            row(ws=d["root"], kind="plan", locator=slug,
                title=_heading(md) or slug, path=md if os.path.exists(md) else "",
                created_at=_ms_iso(min(ats)) if ats else "",
                updated_at=_ms_iso(max(ats)) if ats else "",
                session_id=d.get("session") or "", source="deep-plan")
        except Exception:
            continue
    rdir = os.path.join(PLANS, "reviews")
    try:
        names = sorted(os.listdir(rdir))
    except OSError:
        names = []
    for n in names:
        if not n.endswith(".json") or n.count(".") > 1:
            continue                      # .rows.json, .seen.json, .incoming.json
        if n.startswith("wake-"):
            continue                      # a commit the Wake itself opened in lookout
        d = _load(os.path.join(rdir, n))
        src = (d or {}).get("source")
        if not (isinstance(src, dict) and isinstance(src.get("root"), str)):
            continue
        rid = n[:-5]
        html = os.path.join(rdir, rid + ".html")
        row(ws=src["root"], kind="review", locator=rid, title=d.get("title") or rid,
            path=html if os.path.exists(html) else "",
            created_at=d.get("createdAt") or "", updated_at=d.get("updatedAt") or "",
            branch=src.get("branch") or "", source="lookout")
    adir = os.path.join(PLANS, "asks")
    try:
        names = sorted(os.listdir(adir))
    except OSError:
        names = []
    for n in names:
        if not n.endswith(".json") or n.count(".") > 1:
            continue
        d = _load(os.path.join(adir, n))
        if not d or not isinstance(d.get("cwd"), str):
            continue
        aid = n[:-5]
        html = os.path.join(adir, aid + ".html")
        q = d.get("question") if isinstance(d.get("question"), str) else ""
        head = d.get("header") if isinstance(d.get("header"), str) else ""
        row(ws=d["cwd"], kind="ask", locator=aid,
            title=(head + ": " + q) if head and q else (q or head or aid),
            path=html if os.path.exists(html) else "",
            created_at=d.get("created") or "", updated_at=d.get("created") or "",
            source="ask")
    return rows


class Busy(Exception):
    pass


def _lock():
    os.makedirs(CREW_HOME, mode=0o700, exist_ok=True)
    fh = open(LOCK, "a")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        # The holder may have read this turn's transcript before its last
        # lines landed: ask it to go round once more instead of waiting.
        try:
            open(AGAIN, "a").close()
        except OSError:
            pass
        raise Busy()
    return fh


def index(wait=False):
    """Rescan every transcript whose size or mtime moved, then the stores.
    Another run holding the lock means this one has nothing to add: it
    leaves a marker and exits at once, and the holder goes round again
    (wait=True blocks instead, for backfill)."""
    if wait:
        os.makedirs(CREW_HOME, mode=0o700, exist_ok=True)
        lk = open(LOCK, "a")
        fcntl.flock(lk, fcntl.LOCK_EX)
    else:
        lk = _lock()
    try:
        n = _index_once()
        for _ in range(3):
            if not os.path.exists(AGAIN):
                break
            try:
                os.unlink(AGAIN)
            except OSError:
                pass
            n += _index_once()
        return n
    finally:
        lk.close()


def _index_once():
    _git_cache.clear()
    Scan._timelines.clear()
    db = connect()
    try:
        n = 0
        for path in transcripts():
            try:
                n += index_transcript(db, path)
            except sqlite3.DatabaseError:
                raise
            except Exception:
                continue
        rows = store_rows()
        db.execute("BEGIN IMMEDIATE")
        try:
            write_rows(db, rows)
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise
        return n + len(rows)
    finally:
        db.close()


def backfill():
    """Forget every cursor and index everything. Rows are upserted, so a
    second backfill changes nothing it already knew."""
    db = connect()
    db.execute("DELETE FROM cursors")
    db.close()
    return index(wait=True)


# ---------------------------------------------------------------- read side


def fts_query(q):
    """User text to an FTS5 query: each word a quoted prefix term, all
    required. Quotes inside a word are doubled, so nothing is syntax."""
    words = [w for w in re.split(r"\s+", q or "") if w]
    return " ".join('"%s"*' % w.replace('"', '""') for w in words)


def _dict(r):
    return {k: r[k] for k in r.keys()}


def search(q="", ws=None, kind=None, limit=500):
    """Rows newest first. q is matched over title, path, URL and prompt."""
    db = connect()
    try:
        where, args = [], []
        if ws:
            where.append("a.ws = ?")
            args.append(ws)
        if kind:
            where.append("a.kind = ?")
            args.append(kind)
        fq = fts_query(q)
        if fq:
            sql = ("SELECT a.* FROM artifacts_fts f JOIN artifacts a ON a.id = f.rowid "
                   "WHERE artifacts_fts MATCH ?")
            args.insert(0, fq)
            if where:
                sql += " AND " + " AND ".join(where)
        else:
            sql = "SELECT a.* FROM artifacts a" + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY a.created_at DESC, a.id DESC LIMIT ?"
        args.append(int(limit))
        return [_dict(r) for r in db.execute(sql, args)]
    finally:
        db.close()


def workspaces():
    db = connect()
    try:
        return [_dict(r) for r in db.execute(
            "SELECT ws, COUNT(*) AS n, MAX(created_at) AS last FROM artifacts "
            "GROUP BY ws ORDER BY last DESC")]
    finally:
        db.close()


def row(rid):
    db = connect()
    try:
        r = db.execute("SELECT * FROM artifacts WHERE id = ?", (int(rid),)).fetchone()
        return _dict(r) if r else None
    finally:
        db.close()


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "index":
        try:
            print(index())
        except Busy:
            print("busy: another index run holds the lock")
        return 0
    if cmd == "backfill":
        print(backfill())
        return 0
    sys.stderr.write("usage: artifacts.py index|backfill\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
