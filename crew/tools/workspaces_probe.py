#!/usr/bin/env python3
"""workspaces_probe — crew/hooks/workspaces.py and its callers, against
fakecmux, a throwaway git origin and throwaway transcripts. No app, no network,
no real cache: XDG_CACHE_HOME and every other path point into a temp dir.

What is asserted:

  - the transcript index reads title, last prompt and Claude's last words,
    and an unchanged transcript is not re-read;
  - the live list joins every window, and a cmux that does not answer is
    None, never an empty machine;
  - lifecycle is running, idle, none or unknown; an agent waiting on a prompt
    is mid-turn, and a "running" record whose pid is gone is not;
  - archive refuses a mid-turn or unknown agent, force-closes an idle one and
    remembers it, and puts the old record back when the close fails;
  - restore reopens the cwd with its title, color and `claude --resume`, and
    forget drops a record; two writers at once keep both records;
  - the finder has one row per directory in its state (live, archived, past,
    gone), and its fuzzy scorer orders by score, then state, then recency;
  - merged() is true for a landed branch, false for an unlanded one and for
    main; dormant_days() reads integrations.json and defaults to 5;
  - the board's archive chip (triage.py's crew:archive) archives in the hook,
    refuses a mid-turn agent with a banner, and on a slow cmux hands the
    archive to a terminal instead of overrunning the hook's 10s;
  - crew-sweep finds orphaned, merged and dormant workspaces machine-wide,
    leaves out mid-turn, planned and fresh ones, orders by Jev (a mock) or by
    merged-then-idle without it, caches by transcript size, and its wizard
    takes one key a card; sweep_dormant_days renders through options.py;
  - the plan guard: archive and close refuse a workspace `deep-plan protects`
    (a fake here, through CREW_DEEP_PLAN), naming the plan and the family;
    --family-ok is refused without a terminal, and on one asks a y/N naming
    the family and logs the yes; a deep-plan that errs or answers nonsense is
    a refusal, and no deep-plan at all is no guard, said once. The board chip
    refuses with a banner on either path, crew-sweep holds a protected card
    back even when merged, and crew-reclaim makes it a blocker;
  - crew-reclaim reports the mid-turn guard on a dry run and changes nothing,
    refuses a mid-turn agent, stops before deleting when the close fails, and
    refuses to close its own terminal's workspace, and otherwise force-closes
    and removes the worktree.

    python3 crew/tools/workspaces_probe.py      exit 0 when all hold
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CREW = os.path.join(REPO, "crew")
FAKE = os.path.join(HERE, "fakecmux.py")
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


def git(cwd, *argv):
    return subprocess.run(["git", "-C", cwd] + list(argv), capture_output=True, text=True,
                          check=True).stdout.strip()


T = os.path.realpath(tempfile.mkdtemp(prefix="workspaces-probe-"))
FAKE_DIR = os.path.join(T, "cmux")
os.makedirs(FAKE_DIR)
ENV = dict(os.environ, CREW_CMUX=FAKE, FAKE_CMUX_DIR=FAKE_DIR,
           XDG_CACHE_HOME=os.path.join(T, "cache"),
           CREW_CLAUDE_PROJECTS=os.path.join(T, "projects"),
           CREW_INTEGRATIONS=os.path.join(T, "integrations.json"),
           GIT_CONFIG_GLOBAL=os.path.join(T, "gitconfig"), GIT_CONFIG_NOSYSTEM="1")
FAKE_PS = os.path.join(T, "ps")
with open(FAKE_PS, "w") as fh:
    # Foreground leaders per tty: a shell, an idle claude, and a dev server.
    fh.write('#!/bin/sh\ncase "$4" in\n'
             '  ttys-shell) echo " 10 10 10 -zsh" ;;\n'
             '  ttys-agent) echo " 11 11 30 -zsh"; echo " 30 30 30 /opt/bin/claude"; echo " 31 30 30 node" ;;\n'
             '  ttys-busy) echo " 12 12 40 -zsh"; echo " 40 40 40 npm" ;;\nesac\n')
os.chmod(FAKE_PS, 0o755)
ENV["CREW_PS"] = FAKE_PS
# deep-plan, answered from a table: {root: verdict | "error" | "garbage"}. A
# directory at or inside a root gets its verdict; anything else is unprotected.
# Every call is logged, so a check can tell whether a close path asked.
DP_TABLE = os.path.join(T, "protects.json")
DP_LOG = os.path.join(T, "protects.log")
FAKE_DP = os.path.join(T, "deep-plan")
with open(FAKE_DP, "w") as fh:
    fh.write("#!%s\n" % sys.executable + r'''import json, os, sys
TABLE, LOG = %r, %r
if sys.argv[1:2] != ["protects"] or "--json" not in sys.argv:
    sys.exit(2)
here = os.path.realpath(sys.argv[2])
open(LOG, "a").write(here + "\n")
if os.environ.get("FAKE_DP_DELAY"):
    import time
    time.sleep(float(os.environ["FAKE_DP_DELAY"]))
table = json.load(open(TABLE)) if os.path.exists(TABLE) else {}
for root, v in table.items():
    r = os.path.realpath(root)
    if here == r or here.startswith(r.rstrip("/") + "/"):
        if v == "error":
            sys.stderr.write("deep-plan: the state directory is unreadable\n")
            sys.exit(1)
        print("not json" if v == "garbage" else json.dumps(v))
        sys.exit(0)
print(json.dumps({"protected": False}))
''' % (DP_TABLE, DP_LOG))
os.chmod(FAKE_DP, 0o755)
ENV["CREW_DEEP_PLAN"] = FAKE_DP
os.environ.update(ENV)
with open(ENV["GIT_CONFIG_GLOBAL"], "w") as fh:
    fh.write("[user]\n\tname = probe\n\temail = probe@example.com\n[init]\n\tdefaultBranch = main\n")

sys.path.insert(0, os.path.join(CREW, "hooks"))
import workspaces as W  # noqa: E402  (after the env, which it reads at import)

import crew_impl  # noqa: E402  (beside this probe)


class RustW:
    """workspaces.py's in-process API, answered by `seamux workspaces` under
    CREW_IMPL=rust, so the sections below test the Rust with no edits. Each
    call is one subprocess, through the Rust-only JSON subcommands where the
    Python CLI has no verb. Constants (INDEX, ARCHIVE, CMUX) stay the module's
    and can be reassigned as the probe does; ARCHIVE reaches the Rust through
    CREW_WORKSPACES_ARCHIVE. _update(fn) runs fn on a copy here and sends the
    resulting sets and pops to the Rust, which applies them under its lock."""

    def __init__(self, py):
        self.__dict__["_py"] = py
        self.__dict__["ARCHIVE"] = py.ARCHIVE

    def __getattr__(self, name):
        return getattr(self._py, name)

    def __setattr__(self, name, value):
        self.__dict__[name] = value

    def _run(self, *args, stdin=None):
        env = crew_impl.env(os.environ)
        env["CREW_WORKSPACES_ARCHIVE"] = self.ARCHIVE
        return subprocess.run(crew_impl.argv("workspaces", W_PY) + list(args), input=stdin,
                              env=env, capture_output=True, text=True, timeout=60)

    def _json(self, *args):
        return json.loads(self._run(*args).stdout or "null")

    def build_index(self, force=False):
        d = self._json("index", *(["--force"] if force else []))
        return d["rows"], d["seen"]

    def scan(self, path):
        return self._json("scan", path)

    def live_workspaces(self):
        return self._json("live")

    def busy(self, ws):
        return self._json("busy", ws)

    def lifecycle(self, handle):
        return self._run("lifecycle", handle).stdout.strip()

    def _said(self, *args):
        r = self._run(*args)
        return r.returncode == 0, (r.stdout if r.returncode == 0 else r.stderr).strip()

    def archive(self, handle, family_ok=False):
        return self._said("archive", handle, *(["--family-ok"] if family_ok else []))

    def close(self, handle, family_ok=False):
        return self._said("close", handle, *(["--family-ok"] if family_ok else []))

    def protects(self, cwd):
        return self._json("protects", cwd)

    def restore(self, cwd):
        return self._said("restore", cwd)

    def forget(self, cwd):
        return self._run("forget", cwd).returncode == 0

    def merged(self, cwd):
        return self._run("merged", cwd).returncode == 0

    def dormant_days(self):
        return int(self._run("dormant-days").stdout.strip())

    def load_archive(self):
        return self._json("load-archive")

    def _update(self, fn):
        recs = self.load_archive()
        before = json.loads(json.dumps(recs))
        out = fn(recs)
        ops = {"set": {k: v for k, v in recs.items() if before.get(k) != v},
               "pop": [k for k in before if k not in recs]}
        self._run("update-archive", stdin=json.dumps(ops))
        return out


W_PY = os.path.join(CREW, "hooks", "workspaces.py")
if crew_impl.is_rust("workspaces"):
    W = RustW(W)


def put_rows(rows):
    json.dump(rows, open(os.path.join(FAKE_DIR, "workspaces.json"), "w"))


def rows():
    return json.load(open(os.path.join(FAKE_DIR, "workspaces.json")))


def put_sessions(recs):
    json.dump({"sessions": recs}, open(os.path.join(FAKE_DIR, "sessions.json"), "w"))


def log():
    p = os.path.join(FAKE_DIR, "cmux.log")
    return open(p).read() if os.path.exists(p) else ""


def ws(i, cwd, **kw):
    return dict({"id": i, "ref": "workspace:%s" % i[-1], "title": i, "current_directory": cwd,
                 "custom_color": "#123456", "description": ""}, **kw)


def sess(i, sid, life="idle", pid=True, active=True, at=1.0):
    return {"workspace_id": i, "session_id": sid, "agent_lifecycle": life,
            "stored_pid_exists": pid, "active_for_workspace": active, "updated_at_unix": at,
            "agent": "claude"}


def verdict(root, plan="kid", family="fam", phase="implementing"):
    """What `deep-plan protects --json` says of live work: a plan with
    increment 1 open, and a child of a family that is not done."""
    why = "plan %s is %s with increment 1 not done" % (plan, phase)
    if family:
        why += "; %s is a workstream of the %s family, which is not done" % (plan, family)
    return {"protected": True, "plan": plan, "root": root, "phase": phase, "open": [1],
            "family": {"parent": family, "role": "child", "live": True} if family else None,
            "why": why}


def protect(table):
    json.dump(table, open(DP_TABLE, "w"))
    open(DP_LOG, "w").close()


def asked():
    return open(DP_LOG).read().split() if os.path.exists(DP_LOG) else []


def family_log():
    p = os.path.join(T, "cache", "cmux-crew", "family-ok.log")
    return [json.loads(ln) for ln in open(p)] if os.path.exists(p) else []


def on_tty(argv, answers, env=None, cwd=None, timeout=90):
    """Run argv on a pseudo-terminal, typing answers[i] at the i-th [y/N].
    -> (exit code, what showed, colours stripped)."""
    import pty
    import re
    import select
    m, sl = pty.openpty()
    p = subprocess.Popen(argv, stdin=sl, stdout=sl, stderr=sl, env=env or os.environ, cwd=cwd,
                         close_fds=True)
    os.close(sl)
    out, sent, t0 = b"", 0, time.time()
    while time.time() - t0 < timeout:
        r, _, _ = select.select([m], [], [], 0.2)
        if r:
            try:
                chunk = os.read(m, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                break
            out += chunk
        while sent < len(answers) and out.count(b"[y/N]") > sent:
            os.write(m, (answers[sent] + "\n").encode())
            sent += 1
        if not r and p.poll() is not None:
            break
    else:
        p.kill()
    p.wait()
    os.close(m)
    return p.returncode, re.sub(r"\033\[[0-9;]*m", "", out.decode(errors="replace"))


# --- the transcript index ---------------------------------------------------------
print("transcript index")
proj = os.path.join(T, "projects", "-tmp-a")
os.makedirs(proj)
tx = os.path.join(proj, "11111111-aaaa.jsonl")
with open(tx, "w") as fh:
    for rec in ({"type": "user", "cwd": "/tmp/a", "gitBranch": "dev/a", "timestamp": "t0",
                 "message": {"content": "build the thing"}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "first words"}]}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "it is done"}]}},
                {"type": "last-prompt", "lastPrompt": "ship it"},
                {"type": "ai-title", "aiTitle": "Build the thing"}):
        fh.write(json.dumps(rec) + "\n")
rows_, seen = W.build_index()
s = rows_[0] if rows_ else {}
check("a transcript yields its cwd, branch, title, last prompt and last words",
      seen == 1 and s.get("cwd") == "/tmp/a" and s.get("branch") == "dev/a"
      and s.get("title") == "Build the thing" and s.get("last") == "ship it"
      and s.get("said") == "it is done", json.dumps(s))
cached = json.load(open(W.INDEX))
cached[tx]["title"] = "from the cache"
json.dump(cached, open(W.INDEX, "w"))
check("an unchanged transcript comes from the cache", W.build_index()[0][0]["title"] == "from the cache")
cached[tx]["v"] = 1
json.dump(cached, open(W.INDEX, "w"))
check("a summary from an older scan() is re-read", W.build_index()[0][0]["title"] == "Build the thing")
mid = os.path.join(proj, "22222222-bbbb.jsonl")
with open(mid, "w") as fh:
    fh.write(json.dumps({"type": "user", "cwd": "/tmp/b", "message": {"content": "go"}}) + "\n")
    fh.write(json.dumps({"type": "assistant", "message": {"content": "early words"}}) + "\n")
    pad = json.dumps({"type": "progress", "pad": "x" * 1000}) + "\n"
    fh.write(pad * 100)                       # ~100 KB: past the head, inside head+tail
    fh.write(json.dumps({"type": "assistant", "message": {"content": "the real last words"}}) + "\n")
side = os.path.join(proj, "11111111-aaaa", "subagents")
os.makedirs(side)
with open(os.path.join(side, "agent-x.jsonl"), "w") as fh:
    fh.write(json.dumps({"type": "user", "cwd": "/tmp/a", "message": {"content": "sidechain"}}) + "\n")
check("a subagent's sidechain transcript is not indexed as a session",
      all("subagents" not in r["path"] for r in W.build_index()[0]))
check("a transcript between the head and head+tail sizes yields its real last words",
      (W.scan(mid) or {}).get("said") == "the real last words", json.dumps(W.scan(mid)))

# --- live list and lifecycle ------------------------------------------------------
print("live list and lifecycle")
A, B = os.path.join(T, "a"), os.path.join(T, "b")
os.makedirs(A)
os.makedirs(B)
put_rows([ws("ws-1", A), ws("ws-2", B)])
put_sessions([])
live = W.live_workspaces()
check("the live list reads every window", [w["cwd"] for w in live or []] == [A, B], json.dumps(live))
os.environ["CREW_CMUX"] = W.CMUX = "/usr/bin/false"
check("a cmux that does not answer is None, not an empty list", W.live_workspaces() is None)
check("…and lifecycle is unknown", W.lifecycle("ws-1") == "unknown")
put_sessions([])
check("…even for a ref that no session record could match", W.lifecycle("workspace:9") == "unknown")
os.environ["CREW_CMUX"] = W.CMUX = FAKE
put_sessions([sess("ws-1", "s-run", "running")])
check("a running record is mid-turn", W.lifecycle("ws-1") == "running")
check("…found by ref too", W.lifecycle("workspace:1") == "running")
put_sessions([sess("ws-1", "s-dead", "running", pid=False)])
check("a running record whose pid is gone is not mid-turn", W.lifecycle("ws-1") == "idle")
check("a workspace with no record has no agent", W.lifecycle("ws-2") == "none")
put_sessions([sess("ws-1", "s-ask", "needsInput")])
check("an agent waiting on a permission prompt is mid-turn", W.lifecycle("ws-1") == "running")
check("sessions list is read with --all", "sessions list --json --all" in log())
put_sessions([{"workspaceId": "ws-1", "sessionId": "s-moved", "lifecycle": "running"}])
check("camelCase field names still read", W.lifecycle("ws-1") == "running")
os.remove(os.path.join(FAKE_DIR, "sessions.json"))
with open(os.path.join(FAKE_DIR, "sessions.json"), "w") as fh:
    fh.write("not json")
put_rows([ws("ws-1", A, claude="Idle"), ws("ws-2", B)])
check("an unreadable sessions list falls back to sidebar-state", W.lifecycle("ws-1") == "idle")

# --- archive, restore, forget -----------------------------------------------------
print("archive store")
put_rows([ws("ws-1", A, process=True, title="alpha"), ws("ws-2", B, process=True)])
put_sessions([sess("ws-1", "s-old", active=False, at=1), sess("ws-1", "s-new", at=2),
              dict(sess("ws-1", "s-codex", active=False, at=3), agent="codex"),
              sess("ws-2", "s-b", "running")])
ok, msg = W.archive("ws-2")
check("archive refuses a mid-turn agent", not ok and "mid-turn" in msg and len(rows()) == 2, msg)
check("…and writes no record", B not in W.load_archive())
ok, msg = W.archive("ws-1")
rec = W.load_archive().get(A) or {}
check("archive closes an idle workspace with --force", ok and [w["id"] for w in rows()] == ["ws-2"]
      and "workspace close ws-1 --force" in log(), msg)
check("…and remembers title, color and the active session first",
      rec.get("title") == "alpha" and rec.get("color") == "#123456"
      and rec.get("session_id") == "s-new" and rec.get("sessions") == ["s-new", "s-old"]
      and rec.get("workspace_id") == "ws-1", json.dumps(rec))
check("…and only Claude's sessions, since restore runs `claude --resume`", "s-codex" not in rec.get("sessions", []))
check("the file carries its version", json.load(open(W.ARCHIVE)).get("version") == 1)
put_rows([ws("ws-3", A, title="alpha-2")])
put_sessions([sess("ws-3", "s-3")])
W.archive("ws-3")
rec = W.load_archive().get(A) or {}
check("a second archive on the same cwd takes the label and keeps the first one's sessions",
      rec.get("title") == "alpha-2" and rec.get("sessions") == ["s-3", "s-new", "s-old"], json.dumps(rec))
W._update(lambda r: r.__setitem__(A, dict(r[A], title="alpha", session_id="s-new",
                                            sessions=["s-new", "s-old"])))
json.dump({"version": 1, "records": ["not", "a", "dict"]}, open(W.ARCHIVE + ".bad", "w"))
_saved, W.ARCHIVE = W.ARCHIVE, W.ARCHIVE + ".bad"
try:
    check("an archive file whose records are not a map reads as empty", W.load_archive() == {})
except Exception as e:
    check("an archive file whose records are not a map reads as empty", False, repr(e))
W.ARCHIVE = _saved

put_rows([ws("ws-2", B, close_fails=True)])
put_sessions([])
W._update(lambda r: r.__setitem__(B, {"cwd": B, "title": "older"}))
ok, msg = W.archive("ws-2")
check("a close that fails is reported", not ok and "did not close" in msg, msg)
check("…and the record from before is put back", W.load_archive().get(B, {}).get("title") == "older")
W.forget(B)
put_rows([ws("ws-2", B, close_fails=True)])
W.archive("ws-2")
check("…or none, when there was none", B not in W.load_archive())

put_rows([])
open(os.path.join(FAKE_DIR, "cmux.log"), "w").close()
ok, msg = W.restore(A)
new = rows()[0] if rows() else {}
check("restore opens the cwd with the title and `claude --resume`",
      ok and new.get("current_directory") == A and new.get("title") == "alpha"
      and new.get("command") == "claude --resume s-new", json.dumps(new))
check("…sets the color back", new.get("custom_color") == "#123456")
check("…and drops the record", A not in W.load_archive())
check("restore of a cwd with no record refuses", not W.restore(A)[0])
W._update(lambda r: r.__setitem__(os.path.join(T, "gone"), {"cwd": os.path.join(T, "gone")}))
ok, msg = W.restore(os.path.join(T, "gone"))
check("restore of a cwd that is gone refuses", not ok and "no longer exists" in msg, msg)
check("forget drops a record", W.forget(os.path.join(T, "gone"))
      and os.path.join(T, "gone") not in W.load_archive())
check("forget of nothing says so", not W.forget(os.path.join(T, "gone")))

if isinstance(W, RustW):
    # The Rust's own read-modify-write, eight processes at once.
    writers = [subprocess.Popen(crew_impl.argv("workspaces", W_PY) + ["update-archive"],
                                stdin=subprocess.PIPE, env=crew_impl.env(os.environ), text=True)
               for i in range(8)]
    for i, p in enumerate(writers):
        p.stdin.write(json.dumps({"set": {"/w/%d" % i: {"cwd": "/w/%d" % i}}}))
        p.stdin.close()
    for p in writers:
        p.wait()
else:
    writers = [subprocess.Popen([sys.executable, "-c",
                                 "import sys; sys.path.insert(0, %r); import workspaces as W; "
                                 "W._update(lambda r: r.__setitem__('/w/%d', {'cwd': '/w/%d'}))"
                                 % (os.path.join(CREW, "hooks"), i, i)], env=os.environ)
               for i in range(8)]
    for p in writers:
        p.wait()
check("eight writers at once keep all eight records",
      all("/w/%d" % i in W.load_archive() for i in range(8)))

# --- git: merged, dormant days ----------------------------------------------------
print("merged and dormant days")
origin = os.path.join(T, "origin.git")
subprocess.run(["git", "init", "-q", "--bare", origin], check=True)
main = os.path.join(T, "repo")
subprocess.run(["git", "clone", "-q", origin, main], check=True, capture_output=True)
open(os.path.join(main, "f"), "w").write("1\n")
git(main, "add", "f")
git(main, "commit", "-qm", "one")
git(main, "push", "-q", "origin", "HEAD:main")
git(main, "remote", "set-head", "origin", "main")
landed = os.path.join(T, "repo.worktrees", "landed")
open_ = os.path.join(T, "repo.worktrees", "open")
git(main, "worktree", "add", "-q", "-b", "dev/landed", landed)
open(os.path.join(landed, "g"), "w").write("2\n")
git(landed, "add", "g")
git(landed, "commit", "-qm", "two")
git(landed, "push", "-q", "origin", "HEAD:main")
git(main, "fetch", "-q")
git(main, "worktree", "add", "-q", "-b", "dev/open", open_)
open(os.path.join(open_, "h"), "w").write("3\n")
git(open_, "add", "h")
git(open_, "commit", "-qm", "three")
check("a landed branch is merged", W.merged(landed))
check("an unlanded branch is not", not W.merged(open_))
check("main is never merged", not W.merged(main))
fresh = os.path.join(T, "repo.worktrees", "fresh")
git(main, "worktree", "add", "-q", "-b", "dev/fresh", fresh, "origin/main")
check("a branch cut a moment ago, with no work of its own, is not merged", not W.merged(fresh))
check("dormant days defaults to 5", W.dormant_days() == 5)
json.dump({"sweep": {"dormant_days": 9}}, open(ENV["CREW_INTEGRATIONS"], "w"))
check("dormant days reads integrations.json", W.dormant_days() == 9)
json.dump({"sweep": {"dormant_days": 0}}, open(ENV["CREW_INTEGRATIONS"], "w"))
check("dormant days is at least 1", W.dormant_days() == 1)

# --- the finder: crew-resume's rows and scorer ------------------------------------
print("finder")
import importlib.machinery  # noqa: E402
import importlib.util  # noqa: E402
_l = importlib.machinery.SourceFileLoader("crew_resume", os.path.join(CREW, "bin", "crew-resume"))
R = importlib.util.module_from_spec(importlib.util.spec_from_loader("crew_resume", _l))
_l.exec_module(R)

S = lambda i, cwd, t, mtime, branch="": {"id": i, "path": "/p/" + i, "cwd": cwd, "title": t,
                                         "prompt": "", "branch": branch, "mtime": mtime}
here = {"/r/live", "/r/arch", "/r/past", "/r/both"}
rows_ = R.build_rows(
    [S("1", "/r/live", "older talk", 10), S("2", "/r/live", "newest talk", 20),
     S("3", "/r/past", "past talk", 30, "dev/past-work"), S("4", "/r/gone", "gone talk", 40),
     S("5", "/r/both", "both", 5)],
    [{"id": "w1", "ref": "workspace:1", "cwd": "/r/live", "title": "live-one"},
     {"id": "w2", "ref": "workspace:2", "cwd": "/r/both", "title": "both"}],
    {"/r/arch": {"cwd": "/r/arch", "title": "arch-one", "archived_at": 50},
     "/r/both": {"cwd": "/r/both", "title": "stale", "archived_at": 1}},
    isdir=lambda p: p in here)
by = {r["cwd"]: r for r in rows_}
check("one row per workspace directory, however many sessions it has",
      len(rows_) == 5 and len(by["/r/live"]["sessions"]) == 2, json.dumps(sorted(by)))
check("a row's states: live, archived, past and gone",
      [by[c]["state"] for c in ("/r/live", "/r/arch", "/r/past", "/r/gone")]
      == ["live", "archived", "past", "gone"])
check("live beats a leftover archive record on the same directory", by["/r/both"]["state"] == "live")
check("a row carries its latest session's title and the workspace's own name",
      by["/r/live"]["latest"] == "newest talk" and by["/r/live"]["title"] == "live-one"
      and by["/r/arch"]["title"] == "arch-one")

check("an abbreviation matches as a subsequence", R.fuzzy("dkorg", "dock-organization") is not None)
check("letters that are not there in order do not", R.fuzzy("xq", "dock-organization") is None
      and R.fuzzy("od", "do") is None)
check("consecutive letters outscore scattered ones",
      R.fuzzy("dock", "dock-organization") > R.fuzzy("dock", "d-o-c-k"))
check("a word start outscores a mid-word hit", R.fuzzy("o", "dock-org") > R.fuzzy("o", "docko"))
check("the best alignment wins, not the first letter found",
      R.fuzzy("org", "xo-organization") == R.fuzzy("org", "organization"))
row = lambda t, st="past", when=0, cwd=None: {"title": t, "cwd": cwd or "/r/" + t, "branch": "",
                                             "latest": "", "state": st, "when": when}
check("terms match in any order, each on its own", R.score(["org", "dock"], row("dock-organization")))
check("a match across the seam of two fields is no match",
      R.score(["kx"], dict(row("dock"), latest="xylophone")) is None)
check("the latest session's title matches a term as written",
      R.score(["phone"], dict(row("dock"), latest="xylophone")) is not None)
check("…but not a scattered subsequence of it", R.score(["xlpn"], dict(row("dock"), latest="xylophone")) is None)
check("…and the full path does not match scattered letters either",
      R.score(["hmc"], row("dock", cwd="/home/someone/code/dock")) is None)
check("a session id prefix finds its row",
      R.score(["8f3a2b"], dict(row("dock"), sessions=[{"id": "8f3a2b11-0000"}])) is not None)
got = [r["title"] for r in R.order([row("dorg-z", "gone"), row("dock-organization", "past"),
                                    row("dorg", "live", 1), row("dorg", "archived", 9)], ["dorg"])]
check("order: score first, then state, then recency",
      got[:2] == ["dorg", "dorg"] and got[-1] == "dock-organization", str(got))
same = R.order([row("a", "past", 1), row("b", "past", 9), row("c", "live", 0)], [])
check("with no query: state, then recency", [r["title"] for r in same] == ["c", "b", "a"])

put_rows([ws("ws-s", A, tty="ttys-shell"), ws("ws-a", B, tty="ttys-agent"),
          ws("ws-b", os.path.join(T, "gone"), tty="ttys-busy", title="busy")])
check("a terminal at its prompt, or an idle agent, is not busy",
      W.busy("ws-s") == [] and W.busy("ws-a") == [])
check("a foreground job that is neither is", W.busy("ws-b") == ["npm"])
ok, msg = W.archive("ws-b")
check("archive refuses a workspace with a job running, naming it",
      not ok and "npm is running" in msg and len(rows()) == 3, msg)

# --- the plan guard: deep-plan protects --------------------------------------------
print("plan guard")
F = os.path.join(T, "f")
os.makedirs(os.path.join(F, "deep"))
WS_CLI = crew_impl.argv("workspaces", W_PY, sys.executable)
WENV = crew_impl.env(os.environ)


def guarded():
    put_rows([ws("ws-f", F, process=True, title="kid")])
    put_sessions([sess("ws-f", "s-f", "idle")])
    W.forget(F)
    open(os.path.join(FAKE_DIR, "cmux.log"), "w").close()


guarded()
protect({})
check("deep-plan's no is not protected", W.protects(F)["protected"] is False and asked() == [os.path.realpath(F)])
protect({F: verdict(F)})
p_ = W.protects(os.path.join(F, "deep"))
check("…and its yes is, inside the root too, with the plan and the family",
      p_["protected"] and p_["plan"] == "kid" and p_["family"] == "fam", json.dumps(p_))
ok, msg = W.archive("ws-f")
check("archive refuses a workspace deep-plan protects, naming the plan and the family",
      not ok and "kid holds live work" in msg and "plan kid is implementing" in msg
      and "the fam family" in msg, msg)
check("…and closes nothing and remembers nothing",
      len(rows()) == 1 and "workspace close" not in log() and F not in W.load_archive(), log())
ok, msg = W.close("ws-f")
check("close refuses it too", not ok and "the fam family" in msg and len(rows()) == 1
      and "workspace close" not in log(), msg)
r = subprocess.run(WS_CLI + ["archive", "ws-f", "--family-ok"], env=WENV, capture_output=True,
                   text=True, stdin=subprocess.DEVNULL, timeout=60)
check("--family-ok without a terminal is refused", r.returncode == 1
      and "--family-ok needs a person at a terminal" in r.stderr and len(rows()) == 1, r.stderr)
rc, out = on_tty(WS_CLI + ["archive", "ws-f", "--family-ok"], ["n"], env=WENV)
check("--family-ok at a terminal asks a y/N that names the family",
      "Close kid anyway? The fam family is not done. [y/N]" in out, out)
check("…and a no keeps it open", rc == 1 and "kept — nothing was closed" in out and len(rows()) == 1
      and not family_log(), out)
rc, out = on_tty(WS_CLI + ["archive", "ws-f", "--family-ok"], ["y"], env=WENV)
lg = (family_log() or [{}])[-1]
check("…and a yes archives it, and logs who said so about what",
      rc == 0 and not rows() and F in W.load_archive() and lg.get("cwd") == F
      and lg.get("family") == "fam" and lg.get("plan") == "kid" and "fam family" in lg.get("why", ""),
      out + json.dumps(lg))
guarded()
protect({F: verdict(F, plan="solo", family=None)})
rc, out = on_tty(WS_CLI + ["close", "ws-f", "--family-ok"], ["n"], env=WENV)
check("a plan with no family is named instead", "Plan solo is live there. [y/N]" in out
      and len(rows()) == 1, out)
protect({F: "error"})
ok, msg = W.archive("ws-f")
check("a deep-plan that fails is a refusal, with its error",
      not ok and "could not ask deep-plan" in msg and "unreadable" in msg and len(rows()) == 1, msg)
protect({F: "garbage"})
ok, msg = W.archive("ws-f")
check("…and so is one that answers nonsense", not ok and "could not read" in msg and len(rows()) == 1, msg)
protect({})
_dp = os.environ["CREW_DEEP_PLAN"]
os.environ["CREW_DEEP_PLAN"] = os.path.join(T, "no-deep-plan")
if not isinstance(W, RustW):
    r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, %r); import workspaces as W; "
                        "print(W.protects(%r)['protected'], W.protects(%r)['protected'])"
                        % (os.path.join(CREW, "hooks"), F, A)], capture_output=True, text=True)
    check("no deep-plan installed is no guard, said once",
          r.stdout.split() == ["False", "False"] and r.stderr.count("deep-plan is not installed") == 1,
          r.stdout + r.stderr)
ok, msg = W.archive("ws-f")
check("…so archive goes ahead without it", ok and not rows(), msg)
os.environ["CREW_DEEP_PLAN"] = _dp

# --- the board's archive chip: triage.py's crew:archive ---------------------------
print("board archive chip (triage.py)")
import time  # noqa: E402
TRIAGE = os.path.join(CREW, "hooks", "triage.py")


def tap(ws_id, delay=None, **extra):
    """One crew:archive notification through the hook, as cmux would send it."""
    env = dict(os.environ, CMUX_CLAUDE_HOOK_CMUX_BIN=FAKE, HOME=T, **extra)
    env.pop("FAKE_CMUX_DELAY", None)
    if delay:
        env["FAKE_CMUX_DELAY"] = str(delay)
    policy = {"notification": {"subtitle": "crew:archive", "body": "x", "workspaceId": ws_id},
              "effects": {"desktop": True, "sound": True, "record": True}}
    open(os.path.join(FAKE_DIR, "cmux.log"), "w").close()
    t0 = time.monotonic()
    r = subprocess.run(crew_impl.argv("triage", TRIAGE, sys.executable), input=json.dumps(policy),
                       env=crew_impl.env(env), capture_output=True, text=True, timeout=30)
    return r, time.monotonic() - t0


C = os.path.join(T, "c")
os.makedirs(C)
put_rows([ws("ws-c", C, process=True, title="chip")])
put_sessions([sess("ws-c", "s-c", "idle")])
r, took = tap("ws-c")
out = json.loads(r.stdout or "{}")
check("a tap archives the row's workspace in the hook",
      not rows() and (W.load_archive().get(C) or {}).get("session_id") == "s-c", r.stderr)
check("…and the notification is swallowed: it is an RPC, not a message",
      not any((out.get("effects") or {}).values()), r.stdout)
check("…and says nothing when it worked", "notify" not in log())
before_close = log().split("workspace close")[0].splitlines()
check("…listing the workspaces once before the close: the hook's own list is reused",
      sum(l.startswith("list-windows") for l in before_close) == 1, log())
put_rows([ws("ws-c", C, process=True, title="chip")])
put_sessions([sess("ws-c", "s-c", "running")])
W.forget(C)
r, took = tap("ws-c")
check("a tap on a mid-turn workspace refuses with a banner, and closes nothing",
      len(rows()) == 1 and "notify --title crew --subtitle archive" in log() and "mid-turn" in log()
      and C not in W.load_archive(), log())
put_sessions([sess("ws-c", "s-c", "idle")])
r, took = tap("ws-c")
r, took = tap("ws-c")
check("a second tap on a row that already went is silent", "notify" not in log() and not rows(), log())
put_rows([ws("ws-c", C, process=True, title="chip")])
W.forget(C)
protect({C: verdict(C)})
r, took = tap("ws-c")
check("a tap on a workspace deep-plan protects refuses, the banner naming the plan and the family",
      len(rows()) == 1 and "notify --title crew --subtitle archive" in log() and "plan kid" in log()
      and "the fam family" in log() and "workspace close" not in log() and C not in W.load_archive(), log())
check("…and the chip never passes the override: nothing asks a y/N", "[y/N]" not in log() + r.stderr, r.stderr)
put_rows([ws("ws-c", C, process=True, title="chip"), ws("ws-h", A, selected=True)])
r, took = tap("ws-c", delay=1.0)
check("…and on a cmux slow enough for a terminal, it refuses in the hook instead of handing it off",
      "new-pane" not in log() and "the fam family" in log() and len(rows()) == 2, log())
protect({})
put_rows([ws("ws-c", C, process=True, title="chip"), ws("ws-h", A, selected=True)])
r, took = tap("ws-c", FAKE_DP_DELAY="3", CREW_ARCHIVE_BUDGET="4")
check("a deep-plan slow to answer counts against the hook's budget: the archive goes to a terminal",
      took < 10 and "new-pane --type terminal" in log() and "workspace close" not in log(),
      "%.1fs\n%s" % (took, log()))
put_rows([ws("ws-c", C, process=True, title="chip")])
put_rows([ws("ws-c", C, process=True, title="chip")])
W.forget(C)
r, took = tap("ws-c", delay=0.4)
check("with cmux at 0.4s a call, the archive still happens in the hook, inside 10s",
      not rows() and took < 10 and "new-pane" not in log(), "%.1fs\n%s" % (took, log()))
put_rows([ws("ws-c", C, process=True, title="chip"), ws("ws-h", A, selected=True)])
W.forget(C)
r, took = tap("ws-c", delay=1.0)
check("with cmux at 1s a call, it goes to a terminal elsewhere instead, inside 10s",
      took < 10 and "new-pane --type terminal --direction down --workspace ws-h" in log()
      and ("workspaces archive ws-c" if crew_impl.is_rust("triage") else "workspaces.py archive ws-c")
      in log() and "workspace close" not in log(),
      "%.1fs\n%s" % (took, log()))

# The page names a row id and a verb; the server resolves the rest from the
# targets file the collector writes. The id has to survive that trip, or the
# notification reaches triage.py with no workspace on it.
# Black-box: the collector writes the table, a real server takes the tap, and
# the notification it posts is read back from fakecmux.
import socket  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402


def board_tool(name):
    """The argv that runs one board tool: the one place this probe names it,
    through the CREW_IMPL helper like the rest of this probe."""
    return crew_impl.argv(name, os.path.join(CREW, "board", name))


IHOME = os.path.join(T, "intent-home")
IENV = crew_impl.env(dict(ENV, HOME=IHOME))
subprocess.run(board_tool("crew-board") + ["write-targets"], env=IENV, check=True, text=True,
               input=json.dumps({"rows": [{"id": "UUID-1", "ref": "workspace:1", "name": "chip", "cwd": C}]}))
_s = socket.socket()
_s.bind(("127.0.0.1", 0))
IENV["CREW_INTENT_PORT"] = str(_s.getsockname()[1])
_s.close()
_istate = os.path.join(IHOME, ".cache", "cmux-crew")
_srv = subprocess.Popen(board_tool("crew-board-intent"), env=IENV,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
posted, tapped = [], None
try:
    for _ in range(200):
        try:
            _port = open(os.path.join(_istate, "board-intent.port")).read().strip()
            _tok = open(os.path.join(_istate, "board-intent.token")).read().strip()
            urllib.request.urlopen("http://127.0.0.1:%s/health" % _port, timeout=1).read()
            break
        except (OSError, ValueError):
            time.sleep(0.1)
    open(os.path.join(FAKE_DIR, "cmux.jsonl"), "w").close()
    tapped = json.loads(urllib.request.urlopen("http://127.0.0.1:%s/do?a=archive&r=UUID-1&t=%s" % (
        _port, urllib.parse.quote(_tok)), timeout=30).read())
    for line in open(os.path.join(FAKE_DIR, "cmux.jsonl")):
        a = json.loads(line)
        if a[:2] == ["rpc", "notification.create"]:
            p = json.loads(a[2])
            posted.append((p.get("subtitle"), p.get("workspace_id")))
except Exception as exc:  # a server that never came up is a failed check, not a crash
    tapped = {"error": str(exc)}
finally:
    _srv.kill()
check("an archive tap reaches triage.py naming the row's workspace",
      (tapped or {}).get("ok") and posted == [("crew:archive", "UUID-1")], "%s %s" % (tapped, posted))

# --- crew-sweep ---------------------------------------------------------------------
print("crew-sweep")
import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402
SWEEP = os.path.join(CREW, "bin", "crew-sweep")
OLD = time.time() - 30 * 86400


def old_tree(name, branch):
    path = os.path.join(T, "repo.worktrees", name)
    git(main, "worktree", "add", "-q", "-b", branch, path, "origin/main")
    open(os.path.join(path, name), "w").write(name + "\n")
    git(path, "add", name)
    stamp = "@%d +0000" % OLD
    subprocess.run(["git", "-C", path, "commit", "-qm", name], check=True,
                   env=dict(os.environ, GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp))
    return path


def transcript(cwd, sid, said, mtime):
    d = os.path.join(T, "projects", cwd.replace("/", "-"))
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, sid + ".jsonl")
    with open(p, "w") as fh:
        fh.write(json.dumps({"type": "user", "cwd": cwd, "message": {"content": "do " + sid}}) + "\n")
        fh.write(json.dumps({"type": "assistant", "message": {"content": said}}) + "\n")
    os.utime(p, (mtime, mtime))
    return p


stale = old_tree("stale", "dev/stale")            # dormant, quiet in cmux
spike = old_tree("spike", "dev/spike")            # dormant, not open anywhere
planned = old_tree("planned", "dev/planned")      # dormant but a plan is open
busy_ = old_tree("busy", "dev/busy")              # dormant but mid-turn
transcript(stale, "s-stale", "Done: the endpoint is in and tested.", OLD)
transcript(spike, "s-spike", "That approach will not work here.", OLD + 86400)
kid = os.path.join(T, "repo.worktrees", "kid")  # merged, and a live family's child
git(main, "worktree", "add", "-q", "-b", "dev/kid", kid, "origin/main")
open(os.path.join(kid, "kid"), "w").write("kid\n")
git(kid, "add", "kid")
git(kid, "commit", "-qm", "kid")
git(kid, "push", "-q", "origin", "HEAD:main")
git(main, "fetch", "-q")
protect({planned: verdict(planned, "p", family=None), kid: verdict(kid)})
for i in range(8):
    W.forget("/w/%d" % i)                       # the concurrency test's records
gone_rec = os.path.join(T, "repo.worktrees", "removed")
W._update(lambda r: r.__setitem__(gone_rec, {"cwd": gone_rec, "title": "removed", "archived_at": OLD}))
os.makedirs(os.path.join(stale, "sub"))
plain_dir = os.path.join(T, "not-a-repo")
os.makedirs(plain_dir)
put_rows([ws("ws-m", main, title="main"), ws("ws-st", os.path.join(stale, "sub"), title="stale"),
          ws("ws-bz", busy_, title="busy"), ws("ws-op", open_, title="open"),
          ws("ws-pl", plain_dir, title="plain"), ws("ws-k", kid, title="kid")])
put_sessions([sess("ws-bz", "s-bz", "running"), sess("ws-st", "s-stale", "idle")])
SENV = dict(os.environ, XDG_CONFIG_HOME=os.path.join(T, "config"))
SENV.pop("TYPESAFE_API_KEY", None)


def sweep(*argv, stdin="", **env):
    r = subprocess.run(crew_impl.argv("crew-sweep", SWEEP, sys.executable) + list(argv),
                       env=crew_impl.env(dict(SENV, **env)), input=stdin,
                       capture_output=True, text=True, timeout=120)
    return r


r = sweep("--json")
q = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
names = [os.path.basename(c["cwd"]) for c in q.get("queue", [])]
check("the sweep finds the orphaned record, the merged worktree and the dormant ones",
      names[:2] == ["removed", "landed"] and set(names) == {"removed", "landed", "stale", "spike"},
      r.stderr + str(names))
check("…and leaves out a mid-turn workspace, an open plan, fresh work and the primary checkout",
      not {"busy", "planned", "fresh", "open", "repo"} & set(names))
check("a workspace in a worktree's subdirectory is that worktree's one card, and it is open",
      names.count("stale") == 1 and "sub" not in names
      and next((c for c in q.get("queue", []) if c["cwd"] == stale), {}).get("ws") == "ws-st")
check("a directory with no activity on record is not called dormant", "not-a-repo" not in names)
check("with TypeSafe off: orphaned and merged first, then the longest idle",
      q.get("typesafe") is False and names == ["removed", "landed", "stale", "spike"], str(names))
by = {os.path.basename(c["cwd"]): c for c in q.get("queue", [])}
check("each card offers only the keys that apply",
      by.get("removed", {}).get("keys") == ["f", "s", "q"]
      and by.get("stale", {}).get("keys") == ["r", "a", "s", "o", "q"]
      and by.get("spike", {}).get("keys") == ["r", "s", "q"], json.dumps({k: v["keys"] for k, v in by.items()}))
held = {os.path.basename(c["cwd"]): c for c in q.get("held", [])}
check("a merged worktree deep-plan protects is held back like a dormant one, not offered",
      "kid" not in names and set(held) == {"kid", "planned"}
      and "the fam family" in held["kid"]["why"] and held["kid"]["reason"] == "merged", json.dumps(q.get("held")))
check("…and deep-plan is asked only about the cards that would be offered",
      os.path.realpath(kid) in asked() and os.path.realpath(busy_) not in asked()
      and os.path.realpath(open_) not in asked(), str(asked()))
r = sweep("--json", "--family-ok")
qf = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
byf = {os.path.basename(c["cwd"]): c for c in qf.get("queue", [])}
check("--family-ok offers them, each with deep-plan's reason",
      "the fam family" in byf.get("kid", {}).get("protected", "") and "planned" in byf
      and not qf.get("held"), r.stderr + json.dumps(list(byf)))
r = sweep(stdin="q")
check("the wizard says what it held back, and how to see it",
      "2 held back by live plan or family work — --family-ok offers them" in r.stdout
      and " held: kid, planned" in r.stdout,
      r.stdout[-300:])
protect({planned: verdict(planned, "p", family=None), kid: "error"})
q = json.loads(sweep("--json").stdout or "{}")
check("a deep-plan that fails holds the card back too, saying so",
      "could not ask deep-plan" in next((c["why"] for c in q.get("held", []) if c["cwd"] == kid), ""),
      json.dumps(q.get("held")))
protect({planned: verdict(planned, "p", family=None), kid: verdict(kid)})
json.dump({"sweep": {"dormant_days": 60}}, open(ENV["CREW_INTEGRATIONS"], "w"))
names60 = [os.path.basename(c["cwd"]) for c in json.loads(sweep("--json").stdout)["queue"]]
check("dormant_days moves the line", names60 == ["removed", "landed"], str(names60))
json.dump({}, open(ENV["CREW_INTEGRATIONS"], "w"))

ASKED = []


class Jev(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ASKED.append(body)
        t = body["state"]["workspace_title"]
        f, a = {"stale": (0.9, 0.1), "spike": (0.1, 0.95), "landed": (0.3, 0.2)}.get(t, (0.5, 0.5))
        out = json.dumps({"answers": {"finished": {"noul": f}, "abandoned": {"noul": a}}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), Jev)
threading.Thread(target=srv.serve_forever, daemon=True).start()
JEV = dict(TYPESAFE_API_KEY="k", TYPESAFE_BASE_URL="http://127.0.0.1:%d" % srv.server_port)
r = sweep("--json", **JEV)
q = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
names = [os.path.basename(c["cwd"]) for c in q.get("queue", [])]
check("with Jev: by the higher of finished and abandoned, the orphan ahead of anything judged",
      names == ["removed", "spike", "stale", "landed"], r.stderr + str(names))
check("…asking both questions per judged card, with the title, prompt and facts",
      len(ASKED) == 3 and all(set(b["questions"]) == {"finished", "abandoned"} for b in ASKED)
      and all({"last_message", "last_prompt", "workspace_title", "branch", "pr_state",
               "idle_days", "plan_phase"} <= set(b["state"]) for b in ASKED), json.dumps(ASKED[:1]))
cache = json.load(open(os.path.join(T, "cache", "cmux-crew", "sweep-judgments.json")))
check("…and caching each answer with its transcript size",
      cache.get(stale, {}).get("finished") == 0.9 and "transcript_size" in cache.get(stale, {}))
ASKED.clear()
sweep("--json", **JEV)
check("a second sweep with nothing new asks nothing", ASKED == [], str(len(ASKED)))
with open(os.path.join(T, "projects", stale.replace("/", "-"), "s-stale.jsonl"), "a") as fh:
    fh.write(json.dumps({"type": "assistant", "message": {"content": "one more thing"}}) + "\n")
os.utime(os.path.join(T, "projects", stale.replace("/", "-"), "s-stale.jsonl"), (OLD, OLD))
sweep("--json", **JEV)
check("…and a transcript that grew is asked about again",
      [b["state"]["workspace_title"] for b in ASKED] == ["stale"], str(ASKED))
srv.shutdown()
r = sweep("--json", TYPESAFE_API_KEY="k", TYPESAFE_BASE_URL="http://127.0.0.1:9")
check("a TypeSafe that does not answer still sweeps, on the cached and fallback order",
      r.returncode == 0 and len(json.loads(r.stdout)["queue"]) == 4, r.stderr)

r = sweep(stdin="fq")
import re  # noqa: E402
plain = [re.sub(r"\033\[[0-9;]*m", "", ln) for ln in r.stdout.splitlines()]
check("the wizard shows one card, takes a key, and moves on",
      any(ln.startswith(" 1/4") for ln in plain) and any(ln.startswith(" 2/4") for ln in plain)
      and not any(ln.startswith(" 3/4") for ln in plain), r.stdout)
check("…f forgets the orphaned record", gone_rec not in W.load_archive())
check("…every card line fits an 80-column pane", all(len(ln) <= 80 for ln in plain),
      max(plain, key=len))
check("…and it says what it did", any("swept: 1 forgot" in ln for ln in plain), r.stdout[-200:])
r = sweep(stdin="rq")
check("r down a pipe does not reach crew-reclaim, which would not ask",
      "needs a terminal" in r.stdout and os.path.isdir(landed), r.stdout[-300:])
_l = importlib.machinery.SourceFileLoader("sw", SWEEP)
SW = importlib.util.module_from_spec(importlib.util.spec_from_loader("sw", _l))
_l.exec_module(SW)
line = SW.card({"cwd": stale, "title": "t", "branch": "dev/" + "x" * 200, "idle_days": 3.0, "pr": None,
                "pr_state": "", "merged": False, "plan": "", "ws": {"id": "w"}, "rec": None,
                "reason": "dormant", "said": "y" * 300, "last": "", "linked": True}, 1, 9, 60)
check("a cut card line is measured on what shows and still ends its colour",
      all(len(SW._plain(ln)) <= 60 and ln.endswith(SW.RESET) for ln in line), str([len(SW._plain(x)) for x in line]))
r = sweep(stdin="saq")                          # skip landed, archive stale, quit
check("a archives a live card's workspace, and remembers it",
      "ws-st" not in [w["id"] for w in rows()] and os.path.join(stale, "sub") in W.load_archive()
      and "swept: 1 skipped, 1 archived" in r.stdout, r.stdout[-400:])

OPTS = os.path.join(CREW, "hooks", "options.py")
out_ = os.path.join(T, "opts.json")
json.dump({"typesafe": {"enabled": True}}, open(out_, "w"))
subprocess.run([sys.executable, OPTS, "--out", out_], env=dict(os.environ, CLAUDE_PLUGIN_OPTION_SWEEP_DORMANT_DAYS="9"))
got = json.load(open(out_))
check("the sweep_dormant_days option renders to sweep.dormant_days, keeping other keys",
      got.get("sweep") == {"dormant_days": 9} and got.get("typesafe") == {"enabled": True}, json.dumps(got))
subprocess.run([sys.executable, OPTS, "--out", out_], env=dict(os.environ, CLAUDE_PLUGIN_OPTION_SWEEP_DORMANT_DAYS=""))
check("…and a blank one drops it, for crew-sweep's default", "sweep" not in json.load(open(out_)))
r = subprocess.run([sys.executable, OPTS, "--out", out_], capture_output=True,
                   env=dict(os.environ, CLAUDE_PLUGIN_OPTION_SWEEP_DORMANT_DAYS="1e999"))
check("…and one too large to be a number is ignored, not a crash", r.returncode == 0 and not r.stderr, r.stderr)

# --- crew-reclaim's close guard ---------------------------------------------------
print("crew-reclaim")
RECLAIM = os.path.join(CREW, "bin", "crew-reclaim")


def renv():
    # workspaces through the implementation under test: the Python unless
    # CREW_IMPL says rust, never whatever seamux this machine has installed.
    return dict(os.environ, SEAMUX_BIN=(crew_impl.seamux_bin() if crew_impl.is_rust("workspaces")
                                        else os.path.join(T, "no-seamux")))


def reclaim(*argv):
    r = subprocess.run(["bash", RECLAIM] + list(argv), cwd=T, env=renv(), capture_output=True,
                       text=True, stdin=subprocess.DEVNULL, timeout=120)
    return r.returncode, r.stdout + r.stderr


put_rows([ws("ws-l", landed, process=True, title="landed")])
put_sessions([sess("ws-l", "s-l", "idle")])
rc, out = reclaim("--dry-run", "ws-l")
check("a dry run reports the idle agent as closed with the workspace",
      rc == 0 and "idle — it is closed with the workspace" in out, out)
check("…and changes nothing", os.path.isdir(landed) and len(rows()) == 1)


def reclaim_json(*argv):
    rc, out = reclaim("--json", *argv)
    try:
        return rc, json.loads(out), out
    except ValueError:
        return rc, None, out


rc, rep_, out = reclaim_json("ws-l")
check("--json reports a clear worktree as one object: checks, no blockers, what it would remove",
      rc == 0 and rep_ is not None and rep_["blockers"] == 0 and rep_["worktree"] == os.path.realpath(landed)
      and rep_["workspace"]["id"] == "ws-l" and rep_["workspace"]["name"].startswith("landed")
      and any(c["kind"] == "pass" and "closed with the workspace" in c["text"] for c in rep_["checks"])
      and [r["what"] for r in rep_["remove"]] == ["worktree", "branch", "workspace"], out)
check("…and changes nothing either", os.path.isdir(landed) and len(rows()) == 1)
put_sessions([sess("ws-l", "s-l", "running")])
rc, rep_, out = reclaim_json("ws-l")
check("--json with a blocker: exit 1, the failed check named, nothing to remove",
      rc == 1 and rep_ is not None and rep_["blockers"] >= 1 and rep_["remove"] == []
      and any(c["kind"] == "fail" and "mid-turn" in c["text"] for c in rep_["checks"]), out)
rc, out = reclaim("--yes", "ws-l")
check("a mid-turn agent is a blocker", rc == 1 and "mid-turn" in out and os.path.isdir(landed), out)
put_rows([ws("ws-l", landed, process=True, close_fails=True, title="landed")])
put_sessions([sess("ws-l", "s-l", "idle")])
rc, out = reclaim("--yes", "ws-l")
check("a close that fails stops it before anything is removed",
      rc == 1 and "nothing was removed" in out and os.path.isdir(landed), out)
put_rows([ws("ws-l", landed, process=True, title="landed")])
os.environ["CMUX_WORKSPACE_ID"] = "ws-l"
rc, out = reclaim("--yes", "ws-l")
check("it refuses to close the workspace its own terminal is in",
      rc == 1 and "the workspace it would close" in out and os.path.isdir(landed), out)
os.environ["CMUX_WORKSPACE_ID"] = "ws-elsewhere"
protect({landed: verdict(landed)})
rc, out = reclaim("--yes", "ws-l")
check("a worktree deep-plan protects is a blocker, even with --yes, naming the plan and the family",
      rc == 1 and "plan kid is implementing" in out and "the fam family" in out
      and "crew-reclaim --family-ok" in out and os.path.isdir(landed) and len(rows()) == 1, out)
rc, rep_, out = reclaim_json("ws-l")
check("--json carries a check's hint: the plan blocker says how to get past it",
      rc == 1 and rep_ is not None and rep_["plan"] and "the fam family" in rep_["plan"]
      and any(c["kind"] == "fail" and c["hint"] and "--family-ok" in c["hint"] for c in rep_["checks"]), out)
rc, out = reclaim("--yes", "--family-ok", "ws-l")
check("…and --family-ok without a terminal is still one", rc == 1
      and "--family-ok needs a person at a terminal" in out and os.path.isdir(landed), out)
rc, out = on_tty(["bash", RECLAIM, "--yes", "--family-ok", "ws-l"], ["n"], env=renv(), cwd=T)
check("…at a terminal, --yes does not answer the family's y/N, and a no removes nothing",
      rc != 0 and "The fam family is not done. [y/N]" in out and "nothing was removed" in out
      and os.path.isdir(landed) and len(rows()) == 1, out)
put_rows([])
rc, out = on_tty(["bash", RECLAIM, "--family-ok", landed], ["y", "n"], env=renv(), cwd=T)
check("…and with no workspace to close, reclaim asks it itself",
      rc == 130 and "Reclaim %s anyway? The fam family is not done. [y/N]" % landed in out
      and "kept — nothing was changed" in out and os.path.isdir(landed), out)
put_rows([ws("ws-k", kid, process=True, title="kid")])
put_sessions([sess("ws-k", "s-k", "idle")])
protect({kid: verdict(kid)})
rc, out = on_tty(["bash", RECLAIM, "--yes", "--family-ok", "ws-k"], ["y"], env=renv(), cwd=T)
lg = (family_log() or [{}])[-1]
check("…and a yes there closes and reclaims it, logged",
      rc == 0 and not os.path.isdir(kid) and not rows() and lg.get("cwd") == kid
      and lg.get("family") == "fam", out + json.dumps(lg))
protect({})
put_rows([ws("ws-l", landed, process=True, title="landed")])
put_sessions([sess("ws-l", "s-l", "idle")])
rc, out = reclaim("--yes", "ws-l")
check("an idle agent is force-closed and the worktree removed",
      rc == 0 and "workspace close ws-l --force" in log() and not rows() and not os.path.isdir(landed), out)

bad = results.count(False)
print(f"\nworkspaces probe: {len(results) - bad} passed, {bad} failed")
subprocess.run(["rm", "-rf", T])
sys.exit(1 if bad else 0)
