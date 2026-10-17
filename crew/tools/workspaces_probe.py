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
  - merged() is true for a landed branch, false for an unlanded one and for
    main; dormant_days() reads integrations.json and defaults to 5;
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
os.environ.update(ENV)
with open(ENV["GIT_CONFIG_GLOBAL"], "w") as fh:
    fh.write("[user]\n\tname = probe\n\temail = probe@example.com\n[init]\n\tdefaultBranch = main\n")

sys.path.insert(0, os.path.join(CREW, "hooks"))
import workspaces as W  # noqa: E402  (after the env, which it reads at import)


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

# --- crew-reclaim's close guard ---------------------------------------------------
print("crew-reclaim")
RECLAIM = os.path.join(CREW, "bin", "crew-reclaim")


def reclaim(*argv):
    r = subprocess.run(["bash", RECLAIM] + list(argv), cwd=T, env=os.environ, capture_output=True,
                       text=True, stdin=subprocess.DEVNULL, timeout=120)
    return r.returncode, r.stdout + r.stderr


put_rows([ws("ws-l", landed, process=True, title="landed")])
put_sessions([sess("ws-l", "s-l", "idle")])
rc, out = reclaim("--dry-run", "ws-l")
check("a dry run reports the idle agent as closed with the workspace",
      rc == 0 and "idle — it is closed with the workspace" in out, out)
check("…and changes nothing", os.path.isdir(landed) and len(rows()) == 1)
put_sessions([sess("ws-l", "s-l", "running")])
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
rc, out = reclaim("--yes", "ws-l")
check("an idle agent is force-closed and the worktree removed",
      rc == 0 and "workspace close ws-l --force" in log() and not rows() and not os.path.isdir(landed), out)

bad = results.count(False)
print(f"\nworkspaces probe: {len(results) - bad} passed, {bad} failed")
subprocess.run(["rm", "-rf", T])
sys.exit(1 if bad else 0)
