#!/usr/bin/env python3
"""hooks_probe — crew's Claude Code hooks, options, merge_settings and the
status line, against fakecmux in a throwaway HOME. No app, no network.

The hooks run from a copy of the crew tree. In that copy every tool a hook
spawns (crew-sync, crew-feed, crew-color, crew-listen, crew-artifacts,
cachefacts.py, asked.py, judgments.py) is a stub that appends its argv to a
spawn log, so a detached spawn is asserted by name rather than run for real.
`cmux` on PATH and $CREW_CMUX are both fakecmux.

What is asserted, per event (crew-hook.sh) and tool:

  - the guard: outside cmux, CREW_DISABLED, or the disabled file, nothing runs;
  - session: options rendered first (with CLAUDE_PLUGIN_ROOT), the session
    marker (never under CREW_ADOPT), workspace and tab names from the branch's
    ticket, a colour only when there is none, phase:working (seamux: an
    idle pane and a history line instead), crew-listen unless listen.off or
    a live pid;
  - pretool: no marker means no cmux call; a marker is released to auto,
    except for AskUserQuestion; an outstanding turn-end ask takes phase back;
  - ask / answered / notification: lane, phase, question marker, banner text,
    crew-feed publish;
  - task: progress fraction and label, the checklist, the in-flight pill;
  - stop: stop_hook_active is a no-op; review lane only on unreviewed work;
    the five feed tokens and phase cleared in one write (none when unchanged);
    the turn banner; throttled crew-sync; cachefacts --stop's stdout reaching
    Claude and --sleep detached; crew-artifacts index; asked.sh only with
    TypeSafe available;
  - end: lane released, status cleared, phase dropped;
  - asked.sh: a judgment of "asked" sets the lane, phase, marker and banner;
    "not asked" only records the ranking; no judgment, or a transcript that
    grew, does nothing;
  - options.py, merge_settings.py and statusline.py: their files and lines;
  - two panes in one workspace (seamux only, skipped without CREW_IMPL):
    each pane's own state file, and a workspace that is their roll-up, so
    one Claude's stop, prompt or end never clears another's ask.

With CREW_IMPL=rust (crew/tools/crew_impl.py) the same cases run each
piece seamux registers as Rust: `seamux <tool>` for the three tools, and
crew/hooks/seamux-hook.sh and seamux-asked.sh once seamux registers
crew-hook and asked-hook. Anything unregistered runs as today's script, so
the probe passes at every step of the port; CREW_IMPL=rust-strict refuses
an unregistered piece instead.

    python3 crew/tools/hooks_probe.py      exit 0 when all hold
"""
import calendar
import colorsys
import datetime
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SRC = os.environ.get("PROBE_CREW_SRC") or os.path.join(REPO, "crew")
FAKE = os.path.join(HERE, "fakecmux.py")
sys.path.insert(0, HERE)
import crew_impl  # noqa: E402

RUST = bool(crew_impl.mode())
BASH = shutil.which("bash") or "/bin/bash"
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


T = os.path.realpath(tempfile.mkdtemp(prefix="hooks-probe-"))
HOME = os.path.join(T, "home")
CACHE = os.path.join(HOME, ".cache")
STATE = os.path.join(CACHE, "cmux-crew")
HISTORY = os.path.join(HOME, ".claude", "crew", "history")
LIVE = os.path.join(T, "live")
SPAWN = os.path.join(T, "spawn.log")
BIN = os.path.join(T, "bin")
NOCC = os.path.join(T, "bin-nocc")
for d in (HOME, LIVE, BIN, NOCC):
    os.makedirs(d)

# --- the crew tree, with stubs where a hook spawns something ----------------------
CREW = os.path.join(T, "crew")
shutil.copytree(SRC, CREW, ignore=shutil.ignore_patterns("node_modules", "__pycache__", "*.pyc"))

STUB = r'''#!/usr/bin/env python3
import os, sys
name = os.path.basename(sys.argv[0])
with open(os.environ["PROBE_SPAWN_LOG"], "a") as fh:
    fh.write(" ".join([name] + sys.argv[1:]) + "\n")
if name == "crew-color" and sys.argv[1:2] == ["assign"]:
    print("#1565C0")
elif name == "asked.py":
    sys.stdin.read()
    if sys.argv[1:2] == ["available"]:
        sys.exit(int(os.environ.get("PROBE_ASKED_AVAILABLE", "1")))
    out = os.environ.get("PROBE_ASKED_OUT", "")
    if out:
        sys.stdout.write(out + "\n")
    sys.exit(int(os.environ.get("PROBE_ASKED_RC", "2")))
elif name == "judgments.py":
    with open(os.environ["PROBE_SPAWN_LOG"], "a") as fh:
        fh.write("judgments.py stdin " + sys.stdin.read() + "\n")
elif name == "cachefacts.py" and sys.argv[1:2] == ["--stop"]:
    sys.stdout.write(os.environ.get("PROBE_CACHEFACTS_OUT", ""))
'''


def put_exe(path, text):
    with open(path, "w") as fh:
        fh.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


for rel in ("bin/crew-sync", "bin/crew-feed", "bin/crew-color", "bin/crew-listen",
            "bin/crew-artifacts", "bin/crew-code", "bin/crew-sandbox", "hooks/cachefacts.py", "hooks/asked.py", "board/judgments.py"):
    put_exe(os.path.join(CREW, rel), STUB)

put_exe(os.path.join(BIN, "cmux"), f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" "$@"\n')
put_exe(os.path.join(NOCC, "cmux"), f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" "$@"\n')
put_exe(os.path.join(BIN, "ccusage"), f'''#!{sys.executable}
import os, sys
with open(os.environ["PROBE_SPAWN_LOG"], "a") as fh:
    fh.write(" ".join(["ccusage"] + sys.argv[1:]) + "\\n")
sys.stdout.write(open(os.environ["PROBE_CCUSAGE_" + sys.argv[1].upper()]).read())
''')
for d in (BIN, NOCC):
    os.symlink(sys.executable, os.path.join(d, "python3"))
    if crew_impl.seamux_bin():
        # The shims exec `seamux` from PATH: make it the one crew_impl runs.
        os.symlink(os.path.abspath(crew_impl.seamux_bin()), os.path.join(d, "seamux"))
if crew_impl.seamux_bin():
    # ...and from ~/.local/bin, where install.sh links it and the shims look.
    os.makedirs(os.path.join(HOME, ".local", "bin"))
    os.symlink(os.path.abspath(crew_impl.seamux_bin()), os.path.join(HOME, ".local", "bin", "seamux"))

GIT = shutil.which("git")
SYS_PATH = os.pathsep.join(p for p in ("/usr/bin", "/bin", "/usr/sbin", "/sbin",
                                       os.path.dirname(GIT)) if p)


def git(cwd, *argv):
    return subprocess.run([GIT, "-C", cwd] + list(argv), capture_output=True, text=True,
                          check=True).stdout.strip()


# A clone on a ticket branch that tracks its upstream, so "ahead" is countable.
ORIGIN = os.path.join(T, "origin.git")
subprocess.run([GIT, "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
WT = os.path.join(T, "repo")
subprocess.run([GIT, "clone", "-q", ORIGIN, WT], check=True, capture_output=True)
for k, v in (("user.email", "probe@example.invalid"), ("user.name", "probe"),
             ("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")):
    git(WT, "config", k, v)
open(os.path.join(WT, "a.txt"), "w").write("a\n")
git(WT, "add", "a.txt")
git(WT, "commit", "-qm", "a")
git(WT, "push", "-q", "origin", "HEAD:main")
BRANCH = "dev/thing-proj-123"
LABEL = "PROJ-123 · thing"
git(WT, "checkout", "-qb", BRANCH)
git(WT, "push", "-q", "-u", "origin", BRANCH)
MAIN_WT = os.path.join(T, "plain")
subprocess.run([GIT, "clone", "-q", ORIGIN, MAIN_WT], check=True, capture_output=True)

TRANSCRIPT = os.path.join(T, "t.jsonl")
open(TRANSCRIPT, "w").write('{"type":"user"}\n')
SIZE = str(os.path.getsize(TRANSCRIPT))

# --- running things -----------------------------------------------------------------
FAKE_DIR = os.path.join(T, "cmux")
os.makedirs(FAKE_DIR)
DB = os.path.join(FAKE_DIR, "workspaces.json")
CLOG = os.path.join(FAKE_DIR, "cmux.log")


def row(desc="", color="", title="thing", ws="ws-1"):
    return {"id": ws, "ref": "workspace:1", "title": title, "current_directory": WT,
            "custom_color": color, "description": desc}


def reset(rows=None, state=True):
    """A fresh fake cmux, spawn log and (by default) crew state."""
    json.dump(rows if rows is not None else [row()], open(DB, "w"))
    open(CLOG, "w").close()
    open(SPAWN, "w").close()
    if state:
        shutil.rmtree(STATE, ignore_errors=True)
        os.makedirs(STATE)
        # Throttled by default: a fresh stamp means no crew-sync spawn.
        open(os.path.join(STATE, "sync-stamp"), "w").write(str(int(time.time())))
        open(os.path.join(STATE, "listen.off"), "w").close()


def env_for(ws="ws-1", path=BIN, **extra):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CMUX_", "CLAUDE_PLUGIN_", "CREW_", "TYPESAFE", "PROBE_",
                                "XDG_"))}
    env.update(HOME=HOME, XDG_CACHE_HOME=CACHE, FAKE_CMUX_DIR=FAKE_DIR,
               CREW_CMUX=os.path.join(path, "cmux"), PROBE_SPAWN_LOG=SPAWN,
               CREW_LIVE=LIVE, PATH=path + os.pathsep + SYS_PATH)
    if RUST:
        # What crew_impl.env adds, with CREW_HOME on the copy under test.
        # SEAMUX_TOOLS_BY_PATH: seamux spawns crew tools from the copy, by
        # path, so the stubs below see them as they see the bash's spawns.
        env.update(CREW_IMPL=crew_impl.mode(), CREW_CMUX_TRANSPORT="cli", CREW_HOME=CREW,
                   SEAMUX_TOOLS_BY_PATH="1")
    if ws:
        env["CMUX_WORKSPACE_ID"] = ws
    env.update({k: v for k, v in extra.items() if v is not None})
    return env


def shim(tool, rust_sh, bash_sh):
    """The shim seamux's `tool` stands behind once it is registered, else today's."""
    if crew_impl.is_rust(tool):
        return rust_sh
    if crew_impl.mode() == "rust-strict":
        raise crew_impl.NotPorted("CREW_IMPL=rust-strict: seamux does not register %r" % tool)
    return bash_sh


def hook_argv(event):
    return [BASH, os.path.join(CREW, "hooks", shim("crew-hook", "seamux-hook.sh", "crew-hook.sh")), event]


def asked_argv(size):
    return [BASH, os.path.join(CREW, "hooks", shim("asked-hook", "seamux-asked.sh", "asked.sh")), size]


def tool_argv(name, *argv):
    """A crew tool by its Python basename: the script in the copy, or `seamux`."""
    rel = {"options": "hooks/options.py", "merge_settings": "claude/merge_settings.py",
           "statusline": "claude/statusline.py", "triage": "hooks/triage.py"}[name]
    return crew_impl.argv(name, os.path.join(CREW, rel), sys.executable) + list(argv)


def payload(**kw):
    p = {"session_id": "s-1", "cwd": WT, "transcript_path": TRANSCRIPT}
    p.update(kw)
    return json.dumps(p)


def run(argv, stdin="", env=None, settle=True):
    r = subprocess.run(argv, input=stdin, env=env or env_for(), capture_output=True, text=True,
                       timeout=30, cwd=T)
    if settle:
        quiet()
    return r


def hook(event, stdin=None, **env):
    return run(hook_argv(event), payload() if stdin is None else stdin, env_for(**env))


def quiet():
    """Wait until the detached spawns stop writing, so an absence means absence."""
    last, steady = None, 0
    for _ in range(60):
        now = (os.path.getsize(SPAWN), os.path.getsize(CLOG))
        steady = steady + 1 if now == last else 0
        if steady >= 4:
            return
        last = now
        time.sleep(0.05)


def wait_for(pred, timeout=8.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


def log():
    return open(CLOG).read().splitlines()


def spawns():
    return open(SPAWN).read().splitlines()


def desc(ws="ws-1"):
    return next((w.get("description") for w in json.load(open(DB)) if w["id"] == ws), None)


def color(ws="ws-1"):
    return next((w.get("custom_color") for w in json.load(open(DB)) if w["id"] == ws), None)


def marker(name):
    return os.path.exists(os.path.join(STATE, name))


def touch(name):
    open(os.path.join(STATE, name), "w").close()


if RUST:
    print("CREW_IMPL=%s: as seamux: %s" % (crew_impl.mode(), ", ".join(
        t for t in ("crew-hook", "asked-hook", "options", "merge_settings", "statusline", "triage")
        if crew_impl.is_rust(t)) or "nothing yet"))

# --- the guard ------------------------------------------------------------------------
print("guard")
reset()
r = hook("session", ws=None)
check("outside cmux (no CMUX_WORKSPACE_ID) a hook does nothing",
      r.returncode == 0 and not r.stdout and not log() and not marker("session-s-1"), log())
r = hook("session", CREW_DISABLED="1")
check("CREW_DISABLED makes it a no-op", r.returncode == 0 and not log(), log())
touch("disabled")
r = hook("stop")
check("…and so does the disabled file", r.returncode == 0 and not log() and not spawns(), log())

# The seamux shims without a seamux: every event a no-op, whichever way the run goes.
if os.path.exists(os.path.join(CREW, "hooks", "seamux-hook.sh")):
    reset()
    touch("lane-ws-1")
    quiet_all = True
    for ev in ("session", "pretool", "ask", "answered", "task", "notification", "stop", "end"):
        r = run([BASH, os.path.join(CREW, "hooks", "seamux-hook.sh"), ev], payload(),
                env_for(SEAMUX_BIN=os.path.join(T, "no-seamux"), CLAUDE_PLUGIN_ROOT=CREW))
        quiet_all = quiet_all and r.returncode == 0 and not r.stdout and not r.stderr
    r = run([BASH, os.path.join(CREW, "hooks", "seamux-asked.sh"), "1"], payload(),
            env_for(SEAMUX_BIN=os.path.join(T, "no-seamux")))
    check("without seamux, the shims are no-ops: exit 0, nothing printed, nothing sent",
          quiet_all and r.returncode == 0 and not r.stdout and not log() and not spawns()
          and marker("lane-ws-1"), log() + spawns())

# --- session ---------------------------------------------------------------------------
print("session")
reset([row(desc="ci:green")])
r = hook("session")
L = log()
check("session exits 0 and prints nothing (SessionStart stdout reaches the model)",
      r.returncode == 0 and r.stdout == "", r.stdout + r.stderr)
check("the session marker is written", marker("session-s-1"))
check("the workspace is named for the branch's ticket", f"rename-workspace {LABEL}" in L, L)
check("the tab is named dir · branch", f"rename-tab repo · {BRANCH}" in L, L)
check("a blank colour is filled from crew-color assign",
      f"crew-color assign {WT}" in spawns()
      and "workspace-action --action set-color --color #1565C0" in L and color() == "#1565C0",
      "\n".join(L + spawns()))
if RUST:
    # seamux: a new session is idle until its first prompt (the frozen bash
    # still says working).
    pane = json.load(open(os.path.join(STATE, "pane-ws-1.json")))
    check("a new session's pane is idle and no phase is published",
          pane.get("state") == "idle" and pane.get("session") == "s-1" and desc() == "ci:green"
          and not any("set-description" in l for l in L), f"{pane} {desc()} {L}")
    check("…and its idle start is a history line", any(
        json.loads(l).get("state") == "idle" and json.loads(l).get("detail") == "session"
        for f in os.listdir(HISTORY) for l in open(os.path.join(HISTORY, f))), os.listdir(HISTORY))
    check("names, then colour, in that order",
          [l.split()[0] for l in L if l.split()[0] in ("rename-workspace", "rename-tab", "sidebar-state")]
          == ["rename-workspace", "rename-tab", "sidebar-state"], L)
else:
    check("phase:working is merged into the description, keeping other tokens",
          desc() == "ci:green phase:working", desc())
    check("names, then colour, then phase, in that order",
          [l.split()[0] for l in L if l.split()[0] in ("rename-workspace", "rename-tab", "sidebar-state")]
          == ["rename-workspace", "rename-tab", "sidebar-state"]
          and L.index(next(l for l in L if l.startswith("sidebar-state")))
          < L.index(next(l for l in L if "set-description" in l)), L)
check("listen.off keeps crew-listen from starting", not any(s.startswith("crew-listen") for s in spawns()))

reset([row(color="#922B21")])
hook("session")
check("a colour already set is left alone",
      not any("set-color" in l for l in log()) and not any("crew-color" in s for s in spawns())
      and color() == "#922B21", "\n".join(log()))

reset()
hook("session", CREW_ADOPT="1")
check("CREW_ADOPT replays the session without leaving the marker",
      not marker("session-s-1") and f"rename-workspace {LABEL}" in log())

reset()
os.remove(os.path.join(STATE, "listen.off"))
hook("session")
check("without listen.off, crew-listen is started", wait_for(lambda: "crew-listen" in spawns()), spawns())
reset()
os.remove(os.path.join(STATE, "listen.off"))
open(os.path.join(STATE, "listen.pid"), "w").write(str(os.getpid()))
hook("session")
check("…but not when listen.pid names a live process", "crew-listen" not in spawns(), spawns())

reset()
hook("session", stdin=payload(cwd=MAIN_WT))
check("on main there is no ticket: the workspace takes the directory's name",
      "rename-workspace plain" in log() and "rename-tab plain · main" in log(), log())

reset()
hook("session", CLAUDE_PLUGIN_ROOT=CREW, CLAUDE_PLUGIN_OPTION_JIRA_SITE="acme.atlassian.net")
got = json.load(open(os.path.join(LIVE, "integrations.json"))) if os.path.exists(
    os.path.join(LIVE, "integrations.json")) else {}
check("with CLAUDE_PLUGIN_ROOT, the plugin's options are rendered at session start",
      got.get("jira") == {"enabled": True, "site": "acme.atlassian.net"}, json.dumps(got))
os.remove(os.path.join(LIVE, "integrations.json"))

# --- pretool ----------------------------------------------------------------------------
print("pretool")
reset()
r = hook("pretool", stdin=payload(tool_name="Bash"))
check("no lane marker: no cmux call at all", r.returncode == 0 and not log(), log())
touch("lane-ws-1")
hook("pretool", stdin=payload(tool_name="Bash"))
check("a lane marker is released back to auto", not marker("lane-ws-1")
      and log() == ["workspace status set auto"], log())
touch("lane-ws-1")
open(CLOG, "w").close()
hook("pretool", stdin=payload(tool_name="AskUserQuestion"))
check("…except on AskUserQuestion, which is no resumed work", marker("lane-ws-1") and not log(), log())
reset([row(desc="phase:waiting ci:green")])
touch("lane-ws-1")
touch("asked-ws-1")
hook("pretool", stdin=payload(tool_name="Edit"))
check("an outstanding turn-end ask is answered: phase back to working",
      not marker("asked-ws-1") and desc() == "ci:green phase:working", f"{desc()} {log()}")
reset()
touch("lane-ws-1")
touch("disabled")
hook("pretool", stdin=payload(tool_name="Bash"))
check("the disabled file holds even on the hot path", marker("lane-ws-1") and not log(), log())

# --- ask / answered / notification ----------------------------------------------------
print("ask, answered, notification")
reset([row(desc="ci:green")])
hook("ask", stdin=payload(tool_name="AskUserQuestion",
                          tool_input={"questions": [{"question": "Which of the two?"}]}))
L = log()
check("ask marks the question and pins needs-attention",
      marker("question-ws-1") and marker("lane-ws-1") and "workspace status set needs-attention" in L, L)
check("…publishes phase:waiting", desc() == "ci:green phase:waiting", desc())
check("…and raises a blocked banner with the question",
      f"notify --title {LABEL} --subtitle crew:blocked --body Which of the two?" in L, L)
reset()
hook("ask", stdin=payload(tool_name="AskUserQuestion", tool_input={"questions": []}))
check("an ask with no question text still says something",
      f"notify --title {LABEL} --subtitle crew:blocked --body Claude asked you a question" in log(),
      log())

reset([row(desc="phase:waiting")])
touch("question-ws-1")
touch("lane-ws-1")
hook("answered", stdin=payload(tool_name="AskUserQuestion"))
check("answered clears the question, releases the lane and resumes the phase",
      not marker("question-ws-1") and not marker("lane-ws-1")
      and "workspace status set auto" in log() and desc() == "phase:working", f"{desc()} {log()}")
reset([row(desc="phase:waiting")])
hook("answered", stdin=payload(tool_name="AskUserQuestion"))
check("…and with no lane override there is nothing to release",
      not any(l.startswith("workspace status") for l in log()), log())

reset()
hook("notification", stdin=payload(message="Claude needs your permission to use Bash"))
L = log()
check("notification pins needs-attention and publishes phase:waiting",
      "workspace status set needs-attention" in L and marker("lane-ws-1")
      and desc() == "phase:waiting", f"{desc()} {L}")
check("…publishes the pending ask through crew-feed",
      wait_for(lambda: "crew-feed publish ws-1" in spawns()), spawns())
check("…and banners the message",
      f"notify --title {LABEL} --subtitle crew:blocked --body Claude needs your permission to use Bash"
      in L, L)
reset()
hook("notification", stdin=payload())
check("a notification with no message says Claude needs attention",
      f"notify --title {LABEL} --subtitle crew:blocked --body Claude needs attention" in log(), log())

# --- task -------------------------------------------------------------------------------
print("task")
TASKS = os.path.join(HOME, ".claude", "tasks", "s-1")
os.makedirs(TASKS)
for n, t in ((1, {"subject": "Do A", "status": "completed"}),
             (2, {"subject": "Do B", "activeForm": "Doing B", "status": "in_progress"}),
             (10, {"subject": "Do C", "status": "pending"})):
    json.dump(dict(t, id=str(n)), open(os.path.join(TASKS, f"{n}.json"), "w"))
open(os.path.join(TASKS, "junk.json"), "w").write("{not json")
reset()
hook("task", stdin=payload(tool_name="TaskUpdate"))
L = log()
check("the progress bar is done/total with the task in flight",
      "set-progress 0.3333 --label 1/3 · Doing B" in L, L)
todo = next((l for l in L if l.startswith("todo set ")), "")
check("the checklist is set in one call, in numeric file order",
      json.loads(todo[len("todo set "):] or "[]") == [
          {"text": "Do A", "state": "completed"}, {"text": "Do B", "state": "in-progress"},
          {"text": "Do C", "state": "pending"}], todo)
check("the pill names the in-flight task",
      "set-status claude Doing B --icon list.bullet --color #4C8DFF" in L, L)
check("…and the phase is working", desc() == "phase:working", desc())
reset()
hook("task", stdin=payload(session_id="s-none", tool_name="TodoWrite"))
check("no tasks directory: only the phase", not any(l.startswith(("set-progress", "todo"))
                                                    for l in log()) and desc() == "phase:working",
      log())

# --- stop -------------------------------------------------------------------------------
print("stop")
reset([row(desc="ci:green phase:working feed:ask feedby:me feedgate:x feedreq:y feedws:z")])
r = hook("stop", stdin=payload(stop_hook_active=True))
check("a re-entered Stop (stop_hook_active) does nothing", not log() and not spawns(), log())

r = hook("stop")
L = log()
check("a clean tree releases rather than pinning review",
      not any(l.startswith("workspace status") for l in L), L)
check("the claude status is cleared", "clear-status claude" in L, L)
check("phase and the five feed tokens are dropped in one write, others kept",
      desc() == "ci:green" and sum("set-description" in l for l in L) == 1, f"{desc()} {L}")
check("the turn banner names the branch",
      f"notify --title {LABEL} --subtitle crew:turn --body Turn complete — {BRANCH}" in L, L)
PLAIN = os.path.join(T, "plain-dir")
os.makedirs(PLAIN, exist_ok=True)
reset([row()])
hook("stop", stdin=payload(cwd=PLAIN))
check("outside a repo the banner has no branch, titled with the directory",
      "notify --title plain-dir --subtitle crew:turn --body Turn complete" in log(), log())
reset([row(desc="ci:green phase:working feed:x")])
hook("stop")
check("cachefacts --stop runs with transcript, session and label",
      f"cachefacts.py --stop {TRANSCRIPT} s-1 {LABEL}" in spawns(), spawns())
check("…and --sleep is detached with session first",
      wait_for(lambda: f"cachefacts.py --sleep s-1 {TRANSCRIPT} {LABEL}" in spawns()), spawns())
check("the artifact index is kicked", wait_for(lambda: "crew-artifacts index" in spawns()), spawns())
check("a fresh sync stamp holds crew-sync back", "crew-sync" not in spawns(), spawns())
open(os.path.join(STATE, "sync-stamp"), "w").close()
hook("stop")
check("an empty sync stamp counts as 0 and syncs", wait_for(lambda: "crew-sync" in spawns()), spawns())
check("TypeSafe unavailable: no asked.sh judgment",
      "asked.py available" in spawns() and not any(s.startswith("asked.py judge") for s in spawns()),
      spawns())
check("Stop prints nothing when cachefacts has nothing to say", r.stdout == "", r.stdout)

reset([row(desc="ci:green")])
open(CLOG, "w").close()
hook("stop")
check("nothing to clear is nothing to write", not any("description" in l for l in log()), log())

reset()
r = hook("stop", PROBE_CACHEFACTS_OUT='{"systemMessage":"cache broke"}')
check("cachefacts' systemMessage is the hook's stdout", r.stdout == '{"systemMessage":"cache broke"}',
      r.stdout)

reset()
os.remove(os.path.join(STATE, "sync-stamp"))
hook("stop")
check("with no stamp, crew-sync is spawned and the stamp written",
      wait_for(lambda: "crew-sync" in spawns()) and marker("sync-stamp"), spawns())
reset()
open(os.path.join(STATE, "sync-stamp"), "w").write(str(int(time.time()) - 500))
hook("stop", CREW_SYNC_INTERVAL="120")
check("…and so with a stamp older than CREW_SYNC_INTERVAL", wait_for(lambda: "crew-sync" in spawns()),
      spawns())

reset()
open(os.path.join(WT, "dirty.txt"), "w").write("x\n")
hook("stop")
check("a dirty tree pins the review lane", "workspace status set review" in log() and marker("lane-ws-1"),
      log())
os.remove(os.path.join(WT, "dirty.txt"))
open(os.path.join(WT, "b.txt"), "w").write("b\n")
git(WT, "add", "b.txt")
git(WT, "commit", "-qm", "b")
reset()
hook("stop")
check("so does a commit the upstream has not seen", "workspace status set review" in log(), log())
git(WT, "push", "-q")
reset()
touch("lane-ws-1")
hook("stop")
check("pushed and clean again: an outstanding lane is released",
      "workspace status set auto" in log() and not marker("lane-ws-1"), log())

reset([row(desc="phase:working")])
touch("asked-ws-1")
hook("stop", PROBE_ASKED_AVAILABLE="0", PROBE_ASKED_RC="0",
     PROBE_ASKED_OUT='0.910\nWhich of the two?\n{"stuck": 0.1}')
check("TypeSafe available: asked.sh judges the turn in the background",
      wait_for(lambda: marker("asked-ws-1") and any("--subtitle crew:blocked" in l for l in log())),
      "\n".join(spawns() + log()))
check("…and publishes phase:waiting once the judgment lands",
      wait_for(lambda: desc() == "phase:waiting"), desc())
check("…with the payload handed over in a file",
      open(os.path.join(STATE, "asked-payload-ws-1")).read() == payload())

# --- asked.sh -------------------------------------------------------------------------
print("asked.sh")


def asked(rc, out, size=SIZE):
    return run(asked_argv(size), payload(),
               env_for(PROBE_ASKED_RC=str(rc), PROBE_ASKED_OUT=out))


reset([row(desc="phase:working")])
asked(0, '0.910\nWhich of the two?\n{"stuck": 0.1, "urgency": 2.0}')
L = log()
check("asked: needs-attention, phase:waiting, the marker and a banner with the question",
      "workspace status set needs-attention" in L and desc() == "phase:waiting"
      and marker("asked-ws-1") and marker("lane-ws-1")
      and f"notify --title {LABEL} --subtitle crew:blocked --body Which of the two?" in L, L)
check("…and the ranking extras are recorded for the board, keyed by cwd",
      f"judgments.py --record {WT} {SIZE} 0.910" in spawns()
      and 'judgments.py stdin {"stuck": 0.1, "urgency": 2.0}' in spawns(), spawns())
logged = open(os.path.join(STATE, "asked.log")).read()
check("…and the judgment is logged with the workspace and p",
      "ws-1 p=0.910 extras={\"stuck\": 0.1, \"urgency\": 2.0}" in logged, logged)

reset([row(desc="phase:working")])
asked(1, '0.120\nDone.\n{"stuck": 0.0}')
check("not asked: the ranking is recorded and nothing else moves",
      any(s.startswith("judgments.py --record") for s in spawns())
      and not log() and desc() == "phase:working" and not marker("asked-ws-1"),
      "\n".join(spawns() + log()))
reset()
asked(2, "")
check("no judgment: nothing at all", not log() and spawns() == ["asked.py judge"], spawns())
reset()
asked(0, '0.910\nWhich?\n{}', size="1")
check("a transcript that grew since the stop makes the judgment stale",
      not log() and not any(s.startswith("judgments") for s in spawns()), log())
reset()
asked(0, '0.910\n\n')
check("asked with no banner line says Claude is waiting on you",
      f"notify --title {LABEL} --subtitle crew:blocked --body Claude is waiting on you" in log(), log())

# --- end -------------------------------------------------------------------------------
print("end")
reset([row(desc="ci:green phase:working")])
touch("lane-ws-1")
hook("end")
check("end releases the lane, clears the status and drops the phase",
      "workspace status set auto" in log() and "clear-status claude" in log()
      and desc() == "ci:green" and not marker("lane-ws-1"), f"{desc()} {log()}")

# --- two panes in one workspace (seamux only) --------------------------------------
# Each pane writes its own pane-<surface>.json and the workspace is their
# roll-up. The bash keys everything by workspace and stays frozen, so these
# cases run only under CREW_IMPL=rust.
if RUST:
    print("two panes in one workspace")

    def pane_state(s):
        f = os.path.join(STATE, f"pane-{s}.json")
        return json.load(open(f)).get("state") if os.path.exists(f) else None

    ASK = payload(tool_name="AskUserQuestion", tool_input={"questions": [{"question": "Which of the two?"}]})
    reset([row(desc="ci:green")])
    hook("prompt", CMUX_SURFACE_ID="SA")
    hook("ask", stdin=ASK, CMUX_SURFACE_ID="SB")
    open(CLOG, "w").close()
    hook("stop", CMUX_SURFACE_ID="SA")
    L = log()
    q = json.load(open(os.path.join(STATE, "question-ws-1.json"))) if marker("question-ws-1.json") else {}
    check("A's turn ending leaves B's ask: its question, the waiting phase and the lane",
          marker("question-ws-1") and q.get("surface") == "SB" and desc() == "ci:green phase:waiting"
          and marker("lane-ws-1") and not any(l == "workspace status set auto" for l in L),
          f"{desc()} {q} {L}")
    check("…and only A's pane went idle", pane_state("SA") == "idle" and pane_state("SB") == "needs_input",
          f"{pane_state('SA')} {pane_state('SB')}")
    check("…nor did it clear the workspace's claude status while B waits",
          "clear-status claude" not in L, L)
    check("B holds the pretool marker, A does not", marker("hold-SB") and not marker("hold-SA"))

    open(CLOG, "w").close()
    r = hook("pretool", stdin=payload(tool_name="Bash"), CMUX_SURFACE_ID="SA")
    check("A's tool use while B waits starts no binary and calls no cmux",
          r.returncode == 0 and not log() and pane_state("SA") == "idle", log())

    hook("answered", stdin=payload(tool_name="AskUserQuestion"), CMUX_SURFACE_ID="SB")
    check("B answered: the question goes, the lane is released, the phase is working",
          not marker("question-ws-1") and not marker("question-ws-1.json") and not marker("lane-ws-1")
          and "workspace status set auto" in log() and desc() == "ci:green phase:working",
          f"{desc()} {log()}")

    open(CLOG, "w").close()
    hook("end", CMUX_SURFACE_ID="SA")
    check("A's session ending while B works keeps phase:working and B's claude status",
          desc() == "ci:green phase:working" and "clear-status claude" not in log()
          and pane_state("SA") == "ended", f"{desc()} {log()}")
    hook("end", CMUX_SURFACE_ID="SB")
    check("the last pane ending drops the phase and clears the status",
          desc() == "ci:green" and "clear-status claude" in log(), f"{desc()} {log()}")

    # A turn-end ask in B survives A's prompt; B's own tool use takes it back.
    reset([row(desc="phase:working")])
    hook("prompt", CMUX_SURFACE_ID="SA")
    hook("prompt", CMUX_SURFACE_ID="SB")
    run(asked_argv(SIZE), payload(), env_for(PROBE_ASKED_RC="0", PROBE_ASKED_OUT='0.910\nShip it?\n{}',
                                             CMUX_SURFACE_ID="SB"))
    hook("prompt", CMUX_SURFACE_ID="SA")
    check("A's prompt leaves B's turn-end ask and the waiting phase",
          marker("asked-ws-1") and open(os.path.join(STATE, "asked-ws-1")).read() == "Ship it?"
          and desc() == "phase:waiting" and marker("lane-ws-1"), f"{desc()} {log()}")
    open(CLOG, "w").close()
    hook("pretool", stdin=payload(tool_name="Edit"), CMUX_SURFACE_ID="SB")
    check("B's next tool use takes its ask back: marker, hold and lane go, phase working",
          not marker("asked-ws-1") and not marker("hold-SB") and not marker("lane-ws-1")
          and desc() == "phase:working" and pane_state("SB") == "working", f"{desc()} {log()}")

    # A permission wait in one pane, a review lane left by the other.
    reset([row()])
    hook("prompt", CMUX_SURFACE_ID="SA")
    hook("notification", stdin=payload(message="Claude needs your permission to use Bash"),
         CMUX_SURFACE_ID="SB")
    open(os.path.join(WT, "dirty.txt"), "w").write("x\n")
    open(CLOG, "w").close()
    hook("stop", CMUX_SURFACE_ID="SA")
    check("a review left by A waits behind B's permission prompt",
          "workspace status set review" not in log() and marker("lane-ws-1") and desc() == "phase:waiting",
          f"{desc()} {log()}")
    open(CLOG, "w").close()
    hook("pretool", stdin=payload(tool_name="Bash"), CMUX_SURFACE_ID="SB")
    check("B approved and at work: the lane is released, the phase working",
          "workspace status set auto" in log() and desc() == "phase:working", f"{desc()} {log()}")
    hook("stop", CMUX_SURFACE_ID="SB")
    check("…and once nobody works, A's review lane is pinned",
          "workspace status set review" in log() and marker("lane-ws-1") and desc() == "", f"{desc()} {log()}")
    os.remove(os.path.join(WT, "dirty.txt"))

    # A compaction fires SessionStart mid-turn: the pane keeps working.
    reset([row()])
    hook("prompt", CMUX_SURFACE_ID="SA")
    hook("session", stdin=payload(source="compact"), CMUX_SURFACE_ID="SA")
    check("a compaction's SessionStart leaves the pane working and phase:working",
          pane_state("SA") == "working" and desc() == "phase:working", f"{pane_state('SA')} {desc()}")
else:
    print("two panes in one workspace: skipped (seamux only; run with CREW_IMPL=rust)")

# --- options ---------------------------------------------------------------------------
print("options")
OUT = os.path.join(T, "integrations.json")


def options(*argv, **env):
    return run(tool_argv("options", *argv), "", env_for(**env), settle=False)


json.dump({"typesafe": {"enabled": True}, "jira": {"enabled": True, "site": "old"}}, open(OUT, "w"))
before = open(OUT).read()
r = options("--out", OUT, CLAUDE_PLUGIN_OPTION_JIRA_SITE="")
check("defaults on a file options never wrote change nothing", open(OUT).read() == before
      and r.returncode == 0)
r = options("--out", OUT, CLAUDE_PLUGIN_OPTION_JIRA_SITE="acme.atlassian.net",
            CLAUDE_PLUGIN_OPTION_GITHUB_ISSUES="true", CLAUDE_PLUGIN_OPTION_OBSERVABILITY_STACK="datadog")
got = json.load(open(OUT))
check("set options render jira, github_issues and observability, keeping other keys",
      got.get("jira") == {"enabled": True, "site": "acme.atlassian.net"}
      and got.get("github_issues") == {"enabled": True}
      and got.get("observability", {}).get("stack") == "datadog"
      and got.get("typesafe") == {"enabled": True}
      and got.get("managedBy") == "crew plugin options (crew/hooks/options.py)", json.dumps(got))
check("…written as two-space JSON with a trailing newline",
      open(OUT).read() == json.dumps(got, indent=2) + "\n")
m = os.stat(OUT).st_mtime_ns
time.sleep(0.02)
options("--out", OUT, CLAUDE_PLUGIN_OPTION_JIRA_SITE="acme.atlassian.net",
        CLAUDE_PLUGIN_OPTION_GITHUB_ISSUES="true", CLAUDE_PLUGIN_OPTION_OBSERVABILITY_STACK="datadog")
check("unchanged options leave the file untouched", os.stat(OUT).st_mtime_ns == m)
options("--out", OUT, CLAUDE_PLUGIN_OPTION_JIRA_SITE="", CLAUDE_PLUGIN_OPTION_GITHUB_ISSUES="no",
        CLAUDE_PLUGIN_OPTION_OBSERVABILITY_STACK="none")
got = json.load(open(OUT))
check("once managed, cleared options turn the integrations off",
      not {"jira", "github_issues", "observability"} & set(got) and got.get("typesafe"), json.dumps(got))
SETTINGS = os.path.join(T, "settings.json")
json.dump({"pluginConfigs": {"crew@seamux": {"options": {"main_repo": "/x/main",
                                                         "jira_site": "s.example"}}}},
          open(SETTINGS, "w"))
r = options("--from-settings", SETTINGS, "--get", "main_repo")
check("--from-settings --get main_repo prints the option", r.stdout == "/x/main\n", r.stdout)
r = options("--from-settings", SETTINGS, "--get", "nope")
check("…and an unset one prints nothing", r.stdout == "" and r.returncode == 0, r.stdout)
options("--from-settings", SETTINGS, "--out", OUT)
check("--from-settings renders from pluginConfigs", json.load(open(OUT)).get("jira", {}).get("site")
      == "s.example")
r = options("--bogus")
check("an unknown flag is usage on stderr, exit 2", r.returncode == 2 and r.stderr.strip()
      and not r.stdout, r.stderr)
open(OUT, "w").write("{broken")
r = options("--out", OUT, CLAUDE_PLUGIN_OPTION_JIRA_SITE="x")
check("an unreadable file is left as is, exit 0", r.returncode == 0 and open(OUT).read() == "{broken"
      and r.stderr == f"crew options: cannot read {OUT}: Expecting property name enclosed in double quotes: line 1 column 2 (char 1); left as is\n", r.stderr)

os.remove(OUT)
for days, want in (("9.7", 9), ("0", 1), ("-4", 1), ("1_2", 12), ("1e20", 10 ** 20), ("\u0663", 3)):
    r = options("--out", OUT, CLAUDE_PLUGIN_OPTION_SWEEP_DORMANT_DAYS=days)
    got = json.load(open(OUT))
    check(f"sweep_dormant_days {days!r} renders as {want}", got.get("sweep") == {"dormant_days": want}
          and r.returncode == 0, open(OUT).read())
r = options("--out", OUT, CLAUDE_PLUGIN_OPTION_SWEEP_DORMANT_DAYS="1e999")
check("…one too large to be a whole number drops the key, exit 0 and quiet",
      "sweep" not in json.load(open(OUT)) and r.returncode == 0 and not r.stderr, r.stderr)
r = options("--out", OUT, CLAUDE_PLUGIN_OPTION_GITHUB_ISSUES=" YES ")
check("github_issues takes yes/on/1/true in any case and spacing",
      json.load(open(OUT)).get("github_issues") == {"enabled": True})
json.dump({"pluginConfigs": {"other@x": {"options": {"jira_site": "no"}},
                             "crew@local": {"options": {"jira_site": True, "github_issues": 1,
                                                        "sweep_dormant_days": 7.9, "main_repo": False}}}},
          open(SETTINGS, "w"))
options("--from-settings", SETTINGS, "--out", OUT)
got = json.load(open(OUT))
check("settings values that are not strings read as Python's str() of them",
      got.get("jira") == {"enabled": True, "site": "True"} and got.get("github_issues") == {"enabled": True}
      and got.get("sweep") == {"dormant_days": 7}, json.dumps(got))
r = options("--from-settings", SETTINGS, "--get", "main_repo")
check("--get prints a non-string option the way Python prints it", r.stdout == "False\n", r.stdout)
open(SETTINGS, "w").write("[1]")
r = options("--from-settings", SETTINGS, "--get", "main_repo")
check("a settings file that is not an object is a crash, exit 1", r.returncode == 1 and not r.stdout, r.stderr)

# --- merge_settings --------------------------------------------------------------------
print("merge_settings")
STATUSLINE = os.path.join(CREW, "claude", "statusline.py")
CMD = f"python3 {STATUSLINE}"
S = os.path.join(HOME, ".claude", "settings.json")


def merge(*argv):
    return run(tool_argv("merge_settings", "--settings", S, *argv), "", env_for(), settle=False)


def baks():
    d = os.path.dirname(S)
    return sorted(f for f in os.listdir(d) if ".bak" in f) if os.path.isdir(d) else []


r = merge("--dry-run")
check("--dry-run on no file reports and writes nothing",
      r.stdout == ("  statusLine -> crew's statusline.py\n"
                   "  agentPushNotifEnabled -> true (phone push via Remote Control)\n"
                   "  inputNeededNotifEnabled -> true (phone push via Remote Control)\n"
                   "\n--dry-run: nothing written\n") and not os.path.exists(S), r.stdout)
r = merge()
got = json.load(open(S))
check("with no settings file: the status line and both push flags, no backup",
      got == {"statusLine": {"type": "command", "command": CMD},
              "agentPushNotifEnabled": True, "inputNeededNotifEnabled": True}
      and not baks() and r.stdout.endswith(f"wrote {S}\nNew Claude sessions pick these up; "
                                            "existing ones do not.\n"), r.stdout)
check("…as two-space JSON with a trailing newline", open(S).read() == json.dumps(got, indent=2) + "\n")
r = merge()
check("a second run finds everything set and writes nothing",
      r.stdout == ("  already set: statusLine\n  already set: agentPushNotifEnabled\n"
                   "  already set: inputNeededNotifEnabled\n") and not baks(), r.stdout)
json.dump({"statusLine": {"type": "command", "command": "ccusage statusline"},
           "agentPushNotifEnabled": False}, open(S, "w"))
r = merge()
got = json.load(open(S))
check("someone else's status line and an explicit false are left alone",
      got["statusLine"]["command"] == "ccusage statusline" and got["agentPushNotifEnabled"] is False
      and got["inputNeededNotifEnabled"] is True and "LEFT ALONE" in r.stdout, r.stdout)
check("…and the file is backed up before the write",
      len(baks()) == 1 and baks()[0].startswith("settings.json.pre-crew-dock."), baks())
for b in baks():
    os.remove(os.path.join(os.path.dirname(S), b))
json.dump({"statusLine": {"type": "command", "command": f"python3 {HOME}/.claude/statusline.py",
                          "padding": 1}}, open(S, "w"))
r = merge()
got = json.load(open(S))
check("the old installer's status line is repointed, keeping its other keys",
      got["statusLine"] == {"type": "command", "command": CMD, "padding": 1}
      and "repointed from the old copy" in r.stdout, r.stdout)
for b in baks():
    os.remove(os.path.join(os.path.dirname(S), b))
r = merge("--remove")
got = json.load(open(S))
check("--remove takes out our status line and keeps the push flags",
      "statusLine" not in got and got.get("agentPushNotifEnabled") is True
      and "  removed: statusLine\n" in r.stdout
      and baks() and baks()[0].startswith("settings.json.pre-uninstall."), r.stdout)
r = merge("--remove")
check("…and a second --remove finds nothing of ours",
      r.stdout == f"  nothing of ours found in {S}\n", r.stdout)
for b in baks():
    os.remove(os.path.join(os.path.dirname(S), b))
KEEP = ('{\n  "big": 123456789012345678901234567890,\n  "n": NaN,\n  "f": 1e400,\n'
        '  "x": 0.1,\n  "u": "\\u00e9"\n}\n')
open(S, "w").write(KEEP)
merge()
check("numbers JSON's 64 bits cannot hold come back as Python wrote them",
      open(S).read().startswith('{\n  "big": 123456789012345678901234567890,\n  "n": NaN,\n'
                                '  "f": Infinity,\n  "x": 0.1,\n  "u": "\\u00e9",\n'), open(S).read())
# After the cutover deletes statusline.py: the Python has nothing to point at,
# seamux points the status line at itself (its ~/.local/bin link).
for b in baks():
    os.remove(os.path.join(os.path.dirname(S), b))
os.remove(S)
os.rename(STATUSLINE, STATUSLINE + ".away")
r = merge()
if crew_impl.is_rust("merge_settings"):
    SEAMUX_CMD = os.path.join(HOME, ".local", "bin", "seamux") + " statusline"
    check("with statusline.py gone, seamux points the status line at `seamux statusline`",
          json.load(open(S)).get("statusLine") == {"type": "command", "command": SEAMUX_CMD}, r.stdout)
    r = merge("--remove")
    check("…and counts that one as crew's own", "  removed: statusLine\n" in r.stdout, r.stdout)
else:
    check("with statusline.py gone, the Python skips the status line",
          f"  SKIPPED: no {STATUSLINE}\n" in r.stdout and "statusLine" not in json.load(open(S)), r.stdout)
os.rename(STATUSLINE + ".away", STATUSLINE)
for b in baks():
    os.remove(os.path.join(os.path.dirname(S), b))
open(S, "w").write("{nope")
r = merge()
check("unparseable settings: exit 1, nothing printed, the file untouched",
      r.returncode == 1 and not r.stdout and open(S).read() == "{nope" and not baks(), r.stdout + r.stderr)

# --- statusline ------------------------------------------------------------------------
print("statusline")
FIX = os.path.join(T, "ccusage")
os.makedirs(FIX)
BLOCKS = os.path.join(FIX, "blocks.json")
MONTHLY = os.path.join(FIX, "monthly.json")
COLORS = os.path.join(HOME, ".claude", "cache", "cmux-colors.json")


def blocks(*bs):
    json.dump({"blocks": list(bs)}, open(BLOCKS, "w"))


def statusline(stdin="{}", ws=None, path=BIN, **env):
    return run(tool_argv("statusline"), stdin,
               env_for(ws=ws, path=path, PROBE_CCUSAGE_BLOCKS=BLOCKS, PROBE_CCUSAGE_MONTHLY=MONTHLY,
                       **env), settle=False)


def tint(hexcolor, text):
    r_, g_, b_ = (int(hexcolor[i:i + 2], 16) for i in (1, 3, 5))
    h, l, s = colorsys.rgb_to_hls(r_ / 255, g_ / 255, b_ / 255)
    r_, g_, b_ = (int(c * 255) for c in colorsys.hls_to_rgb(h, max(l, 0.62), max(s, 0.45)))
    return f"\033[38;2;{r_};{g_};{b_}m{text}\033[0m"


reset([row(color="#196F3D", title="thing")])
WINDOW = "⏱ 42% of 5h window (420k/1.0M) · 2h 10m left · ↗ 78% by reset"
blocks({"isGap": False, "totalTokens": 1_000_000},
       {"isGap": True, "totalTokens": 9_000_000},
       {"isActive": True, "totalTokens": 420_000,
        "projection": {"remainingMinutes": 130, "totalTokens": 780_000}})
r = statusline()
check("outside cmux: the window line alone", r.stdout == WINDOW + "\n", repr(r.stdout))
check("…asking ccusage for blocks", "ccusage blocks --json" in spawns(), spawns())
r = statusline(ws="ws-1")
check("in cmux: the workspace's colour bar and title lead, lifted for dark terminals",
      r.stdout == tint("#196F3D", "▊") + " " + tint("#196F3D", "thing") + "  " + WINDOW + "\n",
      repr(r.stdout))
cache = json.load(open(COLORS))
check("…and the colour is cached per workspace", cache.get("ws-1", {}).get("color") == "#196F3D"
      and cache["ws-1"].get("title") == "thing", json.dumps(cache))
open(CLOG, "w").close()
statusline(ws="ws-1")
check("a cached colour costs no cmux call", not log(), log())
cache["ws-1"]["at"] = 0
json.dump(cache, open(COLORS, "w"))
statusline(ws="ws-1")
check("a stale one is refreshed", "workspace list --json" in log(), log())
reset([row(color="", title="thing")])
os.remove(COLORS)
r = statusline(ws="ws-1")
check("no colour: no lead", r.stdout == WINDOW + "\n", repr(r.stdout))
r = statusline(CREW_BLOCK_BUDGET="2000000")
check("CREW_BLOCK_BUDGET overrides the largest block", r.stdout.startswith(
    "⏱ 21% of 5h window (420k/2.0M) · 2h 10m left · ↗ 39% by reset"), r.stdout)
blocks({"totalTokens": 1_000_000}, {"isActive": True, "totalTokens": 5_000,
                                    "projection": {"remainingMinutes": 45, "totalTokens": 5_000}})
r = statusline()
check("under an hour left, minutes only, and no projection when it is not above use",
      r.stdout == "⏱ 0% of 5h window (5k/1.0M) · 45m left\n", repr(r.stdout))
blocks({"totalTokens": 1_500_000})
r = statusline()
check("no active block: the window is quiet", r.stdout == "⏱ window quiet · budget 1.5M\n", r.stdout)
blocks()
r = statusline()
check("no blocks at all: no usage history", r.stdout == "⏱ no usage history yet\n", r.stdout)
r = statusline(path=NOCC)
check("no ccusage: says how to get it", r.stdout == "ccusage not installed — npm i -g ccusage\n",
      r.stdout)
open(BLOCKS, "w").write("not json")
r = statusline()
check("unparseable ccusage output names the error", r.stdout == "ccusage: JSONDecodeError\n",
      r.stdout)

now = datetime.datetime.now()
days = calendar.monthrange(now.year, now.month)[1]
json.dump({"monthly": [{"period": now.strftime("%Y-%m"), "totalCost": 1288.4,
                        "modelBreakdowns": [{"missingPricing": True}]}]}, open(MONTHLY, "w"))
r = statusline(CREW_BILLING="usage", CREW_MONTH_BUDGET="3000")
proj = 1288.4 / now.day * days
want = "💰 $1,288+ of $3,000 (43%)"
if now.day > 1 and proj > 1288.4:
    want += f" · {'↗' if proj > 3000 else '→'} {('$%s' % format(proj, ',.0f')) if proj >= 1000 else ('$%.0f' % proj if proj >= 100 else '$%.2f' % proj)} by {now.strftime('%b')} {days}"
check("usage billing: month-to-date against the budget, a floor mark, and the pace",
      r.stdout == want + "\n", f"{r.stdout!r} != {want!r}")
check("…asking ccusage for monthly", "ccusage monthly --json" in spawns(), spawns())
r = statusline(CREW_BILLING="usage")
check("no budget: the figure alone", r.stdout.startswith("💰 $1,288+ this month"), r.stdout)
os.makedirs(os.path.join(HOME, ".config", "cmux", "crew-local"))
json.dump({"billing": "usage", "monthBudget": 5000},
          open(os.path.join(HOME, ".config", "cmux", "crew-local", "config.json"), "w"))
r = statusline()
check("crew-local config.json selects usage billing and the budget",
      r.stdout.startswith("💰 $1,288+ of $5,000 (26%)"), r.stdout)
os.remove(os.path.join(HOME, ".config", "cmux", "crew-local", "config.json"))
json.dump({"monthly": []}, open(MONTHLY, "w"))
r = statusline(CREW_BILLING="usage")
check("nothing billed this month", r.stdout == "💰 nothing billed this month yet\n", r.stdout)

blocks({"totalTokens": 1_500_000})
QUIET = "⏱ window quiet · budget 1.5M"
r = statusline(json.dumps({"session_id": "s-9", "context_window": {"current_usage": {
    "cache_creation_input_tokens": 50_000, "cache_read_input_tokens": 1_000}}}))
check("a cache break in the live payload is named", r.stdout == QUIET + " · 🧊 broke: 50k re-cached\n",
      r.stdout)
FACTS = os.path.join(CACHE, "cmux-crew", "cache-facts")
os.makedirs(FACTS, exist_ok=True)
json.dump({"ttl": 3600, "lastRequestAt": time.time() - 60}, open(os.path.join(FACTS, "s-9.json"), "w"))
r = statusline(json.dumps({"session_id": "s-9"}))
check("warm cache: minutes left", r.stdout in (QUIET + " · 🧊 59m\n", QUIET + " · 🧊 58m\n"), r.stdout)
json.dump({"ttl": 300, "lastRequestAt": time.time() - 250}, open(os.path.join(FACTS, "s-9.json"), "w"))
r = statusline(json.dumps({"session_id": "s-9"}))
check("nearly stale: seconds", r.stdout.startswith(QUIET + " · 🧊 stale in ") and r.stdout.endswith("s\n"),
      r.stdout)
json.dump({"ttl": 300, "lastRequestAt": time.time() - 900}, open(os.path.join(FACTS, "s-9.json"), "w"))
r = statusline(json.dumps({"session_id": "s-9"}))
check("past the TTL: cold", r.stdout == QUIET + " · 🧊 cache cold\n", r.stdout)
r = statusline("not json")
check("an unreadable payload drops the cache segment only", r.stdout == QUIET + "\n", r.stdout)

# Odd values meet Python's rules where Python meets them: `x or 0` first, the
# TypeError only at arithmetic, max() keeping a NaN that comes first.
blocks({"totalTokens": 100}, {"isActive": True, "totalTokens": {},
                              "projection": {"totalTokens": [], "remainingMinutes": -5}})
r = statusline()
check("empty containers count as 0, and a negative minute count prints as is",
      r.stdout == "⏱ 0% of 5h window (0/100) · -5m left\n", r.stdout)
blocks({"totalTokens": 1_500_000})
r = statusline(json.dumps({"context_window": {"current_usage": {
    "cache_creation_input_tokens": 5, "cache_read_input_tokens": "x"}}}))
check("a string the break test never reaches is no error", r.stdout == QUIET + "\n"
      and r.returncode == 0, r.stdout + r.stderr)
open(BLOCKS, "w").write('{"blocks": [{"totalTokens": NaN}]}')
r = statusline()
check("a NaN budget fails as the Python fails: exit 1, no line", r.returncode == 1 and not r.stdout,
      r.stdout)
open(BLOCKS, "w").write('{"blocks": [{"totalTokens": 5}, {"totalTokens": NaN}]}')
r = statusline()
check("…but a NaN after a number never wins max()", r.stdout == "⏱ window quiet · budget 5\n", r.stdout)
open(BLOCKS, "w").write('{"blocks": [{"isActive": true, "totalTokens": 123456789012345678901234567890}]}')
r = statusline()
check("an integer past 64 bits divides as Python's does",
      r.stdout == "⏱ 100% of 5h window (123456789012345685803008.0M/123456789012345685803008.0M)\n",
      r.stdout)

# --- triage (cmux's notification hook) --------------------------------------------------
print("triage")
TLOG = os.path.join(STATE, "triage.log")


def triage(policy, ws_rows=None, raw=None, **env):
    if ws_rows is not None:
        reset(ws_rows)
    else:
        open(CLOG, "w").close()
        open(SPAWN, "w").close()
    stdin = raw if raw is not None else json.dumps(policy)
    return run(tool_argv("triage"), stdin, env_for(ws=None, **env))


def note(sub, ws="ws-1", key="workspaceId", **effects):
    return {"notification": {"title": "t", "subtitle": sub, "body": "b", key: ws},
            "effects": effects or {"desktop": True, "sound": True, "record": True, "markUnread": True}}


def tlog():
    return open(TLOG).read() if os.path.exists(TLOG) else ""


p = {"notification": {"title": "Claude", "subtitle": "other", "body": "é"},
     "effects": {"desktop": True, "sound": True}}
r = triage(p, [row()])
check("a notification without a crew marker is printed back as cmux proposed it",
      r.stdout == json.dumps(p) and r.returncode == 0 and not log(), r.stdout)
p = note("crew:turn")
r = triage(p)
want = json.loads(json.dumps(p))
want["effects"].update(desktop=False, sound=False)
check("crew:turn keeps the sidebar but loses the banner and the sound", r.stdout == json.dumps(want),
      r.stdout)
for raw in ("not json", "[1, 2]", '{"notification": 5}', "{\r\n"):
    r = triage(None, raw=raw)
    check(f"input it cannot read is echoed unchanged: {raw!r}",
          r.stdout == raw.replace("\r\n", "\n") and r.returncode == 0, repr(r.stdout))
r = triage(note("crew:sync-now"))
check("crew:sync-now fires crew-sync and switches every effect off",
      wait_for(lambda: "crew-sync" in spawns()) and r.stdout == json.dumps(dict(
          note("crew:sync-now"), effects={"desktop": False, "sound": False, "record": False,
                                          "markUnread": False})), r.stdout)
check("…and logs the fire to triage.log", "fire: " in tlog() and "crew-sync" in tlog(), tlog())
triage(note("crew:feed-allow"))
check("crew:feed-allow replies once through crew-feed",
      wait_for(lambda: "crew-feed reply once ws-1" in spawns()), spawns())
triage(note("crew:feed-deny", key="workspace_id"))
check("crew:feed-deny replies deny, reading the workspace_id spelling too",
      wait_for(lambda: "crew-feed reply deny ws-1" in spawns()), spawns())
triage(note("crew:code"), [row()])
check("crew:code opens the row's resolved directory",
      wait_for(lambda: f"crew-code {WT}" in spawns()) and "sidebar-state --workspace ws-1" in log(),
      spawns())
triage(note("crew:code", ws="ws-x"), [row()])
check("…and hands over the id when it has no directory",
      wait_for(lambda: "crew-code --workspace ws-x" in spawns()), spawns())
triage(note("crew:sandbox-up"), [row()])
check("crew:sandbox-up builds around the resolved directory",
      wait_for(lambda: f"crew-sandbox up {WT}" in spawns()), spawns())
triage(note("crew:sandbox-down", ws="ws-x"), [row()])
check("crew:sandbox-down without one names the workspace",
      wait_for(lambda: "crew-sandbox --workspace ws-x down" in spawns()), spawns())
host = dict(row(ws="ws-2", title="host"), selected=True)
r = triage(note("crew:reclaim"), [row(), host])
reclaim = os.path.join(CREW, "bin", "crew-reclaim")
check("crew:reclaim opens a terminal in another workspace, runs the dry run there and keeps it",
      "new-pane --type terminal --direction down --workspace ws-2 --focus true" in log()
      and f'respawn-pane --surface surface:900 --command {reclaim} ws-1; exec "${{SHELL:-/bin/zsh}}" -l'
      in log() and "rename-tab --surface surface:900 reclaim" in log() and not spawns(), log())
r = triage(note("crew:reclaim"), [row()])
check("…and with nowhere else to put it, says how to run it, never running it",
      f"notify --title crew --subtitle reclaim --body could not open a terminal — run: crew-reclaim {WT}"
      in log() and "respawn-pane" not in log(), log())
triage(note("crew:plan-go"), [row()])
check("crew:plan-go runs deep-plan's go in a login shell, then crew-sync",
      wait_for(lambda: "crew-sync" in spawns()) and "fire: /bin/sh -lc PATH=" in tlog(), tlog())
triage(note("crew:plan-go", ws="ws-x"), [row()])
check("…and with no directory to name, drops it and says so",
      "plan-go DROPPED: no cwd (ws='ws-x')" in tlog() and not spawns(), tlog())
r = triage(note("crew:archive", ws=""), [row()])
check("crew:archive with no workspace archives nothing", "archive : no workspace" in tlog()
      and "workspace close" not in log(), tlog())
bad = b'{"notification": {"subtitle": "crew:turn", "body": "\xff"}, "effects": {"sound": true}}'
r = subprocess.run(tool_argv("triage"), input=bad, env=env_for(ws=None, LC_ALL="C", LANG="C"),
                   capture_output=True, timeout=30)
check("bytes that are not UTF-8 still get cmux's policy back", r.returncode == 0 and r.stdout
      and b"crew:turn" in r.stdout, r.stdout)
triage(dict(note("crew:feed-allow"), notification={"subtitle": "crew:feed-allow", "workspaceId": 5}))
check("a workspace id that is not a string fails the fire, logged, and runs nothing",
      "fire FAILED:" in tlog() and "not int" in tlog() and not wait_for(lambda: spawns(), 1.0), tlog())
r = triage(dict(note("crew:reclaim"), notification={"subtitle": "crew:reclaim", "workspaceId": 5}), [row()])
check("…and a reclaim for one echoes the input, opening nothing",
      json.loads(r.stdout)["effects"]["desktop"] is True and "new-pane" not in log(), r.stdout)
r = triage(note("crew:turn"), CREW_ARCHIVE_BUDGET="soon")
check("a CREW_ARCHIVE_BUDGET that is not a number fails before reading anything",
      r.returncode == 1 and not r.stdout, r.stdout)

shutil.rmtree(T, ignore_errors=True)
n = len(results)
print(f"\n{sum(results)}/{n} hold" + ("" if all(results) else " — FAILURES above"))
sys.exit(0 if all(results) else 1)
