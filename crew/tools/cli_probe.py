#!/usr/bin/env python3
"""cli_probe — the ten crew CLIs port-cli ports, run from outside, against a
fake cmux in a throwaway HOME. No app, no network, no real config.

Deep cases for the six no other probe runs black-box:

  - crew-plugin-root: a directory marketplace's folder, an installPath, the
    fallback when the folder is gone, an unknown name, no argument;
  - crew-frame: --status, --color, the same colour twice (no second reload),
    a bad hex, --off, following the selected workspace and a named one,
    CREW_FRAME=0, a cmux.json without the key; comments always survive;
  - crew-listen: --once (reconciled, not due, disabled), and the stream: a
    selection pushes the board and the frame with its id, a structural event
    reconciles once and the next is throttled, an event crew emits itself is
    ignored, the cursor is kept, a second listener steps aside;
  - crew-feed: publish (live, stale, truncated, guard-blocked), show, clear,
    and reply (sent, unknown mode, window closed), each audited;
  - crew-digest: commits by branch, merged / red / approved PRs from gh,
    sessions waiting, reclaimable worktrees, --notify, --paragraph, and every
    section going quiet when its source is missing;
  - crew-resume --rows-json: one row per directory, states, scope, the query's
    order, a session id prefix.

And a smoke case each for the four whose deeper probes live elsewhere
(family_sync_probe, board_probe, workspaces_probe): crew-sync --dry-run,
crew-color assign/show/peek, crew-overlay, crew-sweep --json.

Tools that call a sibling (listen, digest) run from a copied crew tree whose
siblings are stubs logging their argv, so nothing real is started.

    python3 crew/tools/cli_probe.py                exit 0 when all hold
    CREW_IMPL=rust python3 crew/tools/cli_probe.py the same, against seamux
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CREW = os.path.join(REPO, "crew")
FAKE = os.path.join(HERE, "fakecmux.py")
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


# --- which implementation runs ----------------------------------------------------
# The one place a tool becomes a command. With CREW_IMPL=rust a tool that seamux
# registers runs as `seamux <tool>`, told where crew lives (CREW_HOME) and to reach
# cmux through the CLI, so fakecmux still answers; anything else runs the Python.
# crew_impl (the family's shared helper) decides; this only adds the crew tree.
sys.path.insert(0, HERE)
import crew_impl  # noqa: E402

if crew_impl.mode() and not crew_impl.seamux_bin():
    # Running the Python here would pass and prove nothing about the Rust.
    sys.exit(f"cli_probe: CREW_IMPL={crew_impl.mode()} but no seamux binary "
             "(SEAMUX_BIN, app/target/debug/seamux or PATH)")


def _cmd(tool, args, env, crew_home):
    try:
        argv = crew_impl.argv(tool, os.path.join(crew_home, "bin", tool), sys.executable)
    except crew_impl.NotPorted as e:
        sys.exit(f"cli_probe: {e}")
    if crew_impl.is_rust(tool):
        env = crew_impl.env(dict(env, CREW_HOME=crew_home))
        if crew_home != CREW:
            # A stub tree: siblings another crate ports must still run from it,
            # by path, so the stubs log the call (crew-hooks honors the same).
            env["SEAMUX_TOOLS_BY_PATH"] = "1"
    return argv + list(args), env


def run(tool, *args, env, crew_home=CREW, stdin=None, timeout=60, cwd=None):
    argv, env = _cmd(tool, args, env, crew_home)
    return subprocess.run(argv, env=env, input=stdin, capture_output=True, text=True,
                          timeout=timeout, cwd=cwd)


def spawn(tool, *args, env, crew_home=CREW):
    argv, env = _cmd(tool, args, env, crew_home)
    return subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True)


# --- the throwaway machine ------------------------------------------------------------

# realpath: on macOS the temp dir sits behind /var -> /private/var, and git
# reports worktrees by their real path, so a symlinked T reads as two checkouts.
T = os.path.realpath(tempfile.mkdtemp(prefix="cli-probe-"))
HOME = os.path.join(T, "home")
CACHE = os.path.join(T, "cache")
FAKE_DIR = os.path.join(T, "fake")
STUBS = os.path.join(T, "stubs.log")
PATHBIN = os.path.join(T, "pathbin")
for d in (HOME, CACHE, FAKE_DIR, PATHBIN):
    os.makedirs(d)

# Nothing on PATH answers for gh, acli or sbx unless a case puts a stub there:
# a real one would reach the network.
ENV = {k: v for k, v in os.environ.items() if not k.startswith(("CMUX_", "CREW_", "CLAUDE_"))}
ENV.update(HOME=HOME, XDG_CACHE_HOME=CACHE, FAKE_CMUX_DIR=FAKE_DIR, CREW_CMUX=FAKE,
           CREW_SBX=os.path.join(T, "no-sbx"), CLAUDE_CONFIG_DIR=os.path.join(HOME, ".claude"),
           PATH=PATHBIN + os.pathsep + "/usr/bin:/bin:/usr/sbin:/sbin",
           GIT_CONFIG_GLOBAL=os.path.join(T, "gitconfig"), GIT_CONFIG_NOSYSTEM="1")
for tool in ("gh", "acli", "sbx", "cmux"):
    with open(os.path.join(PATHBIN, tool), "w") as fh:
        fh.write("#!/bin/sh\nexit 1\n")
    os.chmod(os.path.join(PATHBIN, tool), 0o755)
with open(ENV["GIT_CONFIG_GLOBAL"], "w") as fh:
    fh.write("[user]\n\tname = Probe\n\temail = probe@example.invalid\n"
             "[init]\n\tdefaultBranch = master\n")


def git(cwd, *argv, **kw):
    return subprocess.run(["git", "-C", cwd, *argv], env=dict(ENV, **kw), check=True,
                          capture_output=True, text=True).stdout


def put_rows(rows):
    json.dump(rows, open(os.path.join(FAKE_DIR, "workspaces.json"), "w"))


def rows():
    return json.load(open(os.path.join(FAKE_DIR, "workspaces.json")))


def cmux_log():
    p = os.path.join(FAKE_DIR, "cmux.log")
    return open(p).read().splitlines() if os.path.exists(p) else []


def clear_log():
    for p in (os.path.join(FAKE_DIR, "cmux.log"), STUBS):
        if os.path.exists(p):
            os.remove(p)


def stub_calls():
    return [json.loads(l) for l in open(STUBS)] if os.path.exists(STUBS) else []


def ws(i, cwd, **kw):
    return dict({"id": i, "ref": "workspace:" + i, "title": os.path.basename(cwd),
                 "current_directory": cwd, "custom_color": "", "description": ""}, **kw)


# A crew tree for the tools that call siblings: the tool under test is the real
# file, every sibling a stub that logs its argv and answers what it is asked.
STUB = """#!/usr/bin/env python3
import json, os, sys
name = %r
with open(%r, "a") as fh:
    fh.write(json.dumps([name] + sys.argv[1:]) + "\\n")
if name == "crew-board-intent" and "--status" in sys.argv:
    print('{"running": true}')
if name == "crew-board" and sys.argv[1:2] == ["state"]:
    p = %r
    print(open(p).read() if os.path.exists(p) else "{}")
"""
NEWS = os.path.join(T, "news.json")
STUB_HOME = os.path.join(T, "crew")
for sub in ("bin", "board"):
    os.makedirs(os.path.join(STUB_HOME, sub))
for rel in ("bin/crew-sync", "bin/crew-frame", "bin/crew-plugin-root",
            "board/crew-board", "board/crew-board-intent"):
    p = os.path.join(STUB_HOME, rel)
    with open(p, "w") as fh:
        fh.write(STUB % (os.path.basename(rel), STUBS, NEWS))
    os.chmod(p, 0o755)
for tool in ("crew-listen", "crew-digest"):
    shutil.copy2(os.path.join(CREW, "bin", tool), os.path.join(STUB_HOME, "bin", tool))
shutil.copy2(os.path.join(CREW, "bin", "crew-cmux-bin"), os.path.join(STUB_HOME, "bin", "crew-cmux-bin"))


# --- crew-plugin-root ---------------------------------------------------------------
print("crew-plugin-root")
CFG = ENV["CLAUDE_CONFIG_DIR"]
os.makedirs(os.path.join(CFG, "plugins"))
MKT = os.path.join(T, "market")
os.makedirs(os.path.join(MKT, ".claude-plugin"))
os.makedirs(os.path.join(MKT, "crew"))
json.dump({"plugins": [{"name": "crew", "source": "./crew"},
                       {"name": "moved", "source": "./not-here"}]},
          open(os.path.join(MKT, ".claude-plugin", "marketplace.json"), "w"))
SNAP = os.path.join(T, "plugin-cache")
for name in ("crew", "moved", "remote"):
    os.makedirs(os.path.join(SNAP, name))
json.dump({"plugins": {
    "crew@seamux": [{"installPath": os.path.join(SNAP, "crew")}],
    "moved@seamux": [{"installPath": os.path.join(SNAP, "moved")}],
    "remote@hub": [{"installPath": os.path.join(T, "gone")},
                   {"installPath": os.path.join(SNAP, "remote")}]}},
    open(os.path.join(CFG, "plugins", "installed_plugins.json"), "w"))
json.dump({"seamux": {"source": {"source": "directory", "path": MKT}, "installLocation": MKT},
           "hub": {"source": {"source": "github", "repo": "o/r"}}},
          open(os.path.join(CFG, "plugins", "known_marketplaces.json"), "w"))

r = run("crew-plugin-root", "crew", env=ENV)
check("a directory marketplace's plugin is read from the folder, not the cache",
      r.returncode == 0 and r.stdout == os.path.join(MKT, "crew") + "\n", r.stdout + r.stderr)
r = run("crew-plugin-root", "moved", env=ENV)
check("…and falls back to installPath when the folder has no such source",
      r.returncode == 0 and r.stdout.strip() == os.path.join(SNAP, "moved"), r.stdout + r.stderr)
r = run("crew-plugin-root", "remote", env=ENV)
check("any other marketplace: the first installPath that exists",
      r.returncode == 0 and r.stdout.strip() == os.path.join(SNAP, "remote"), r.stdout + r.stderr)
r = run("crew-plugin-root", "nobody", env=ENV)
check("an unknown plugin prints nothing and exits 1", r.returncode == 1 and r.stdout == "",
      repr((r.returncode, r.stdout)))
r = run("crew-plugin-root", env=ENV)
check("no argument is a usage error (exit 2, on stderr)",
      r.returncode == 2 and r.stdout == "" and "crew-plugin-root <plugin-name>" in r.stderr, r.stderr)


# --- crew-frame ---------------------------------------------------------------------
print("crew-frame")
CMUX_JSON = os.path.join(HOME, ".config", "cmux", "cmux.json")
os.makedirs(os.path.dirname(CMUX_JSON))
FRAME_SRC = """{
  // rendered by crew apply -- keep this comment
  "app": { "theme": "dark" },  /* and this one */
  "activePaneBorderColor": null,
  "url": "https://example.invalid/a//b"
}
"""
open(CMUX_JSON, "w").write(FRAME_SRC)
put_rows([ws("ws-a", "/r/a", custom_color="#1565C0"),
          ws("ws-b", "/r/b", custom_color="#7D6608", selected=True)])
clear_log()


def reloads():
    return sum(1 for l in cmux_log() if l == "reload-config")


r = run("crew-frame", "--status", env=ENV)
st = json.loads(r.stdout or "{}")
check("--status: the value set, the selected workspace's colour, the file",
      r.returncode == 0 and st == {"set": "null", "selected_workspace_color": "#7D6608", "config": CMUX_JSON},
      r.stdout + r.stderr)
r = run("crew-frame", "--color", "#1565C0", env=ENV)
body = open(CMUX_JSON).read()
check("--color writes the hex in place and reloads cmux once",
      r.returncode == 0 and '"activePaneBorderColor": "#1565C0"' in body and reloads() == 1,
      body + str(cmux_log()))
check("…and every comment and the https:// string survive the edit",
      body == FRAME_SRC.replace('"activePaneBorderColor": null', '"activePaneBorderColor": "#1565C0"'), body)
run("crew-frame", "--color", "#1565C0", env=ENV)
check("the same colour again touches nothing and does not reload", reloads() == 1, str(cmux_log()))
r = run("crew-frame", "--color", "blue", env=ENV)
check("a colour that is not #RRGGBB is refused (exit 2)",
      r.returncode == 2 and "--color needs #RRGGBB" in r.stderr and reloads() == 1, r.stderr)
r = run("crew-frame", "--off", env=ENV)
check("--off puts null back and reloads",
      r.returncode == 0 and '"activePaneBorderColor": null' in open(CMUX_JSON).read() and reloads() == 2)
r = run("crew-frame", env=ENV)
check("no flag follows the selected workspace's colour",
      r.returncode == 0 and '"#7D6608"' in open(CMUX_JSON).read() and reloads() == 3)
r = run("crew-frame", "--workspace", "ws-a", env=ENV)
check("--workspace takes that workspace's colour, not the selected one",
      r.returncode == 0 and '"#1565C0"' in open(CMUX_JSON).read() and reloads() == 4)
r = run("crew-frame", "--status", "--workspace", "", env=ENV)
check("an empty --workspace is no id: it follows the selection",
      r.returncode == 0 and json.loads(r.stdout or "{}").get("selected_workspace_color") == "#7D6608",
      r.stdout + r.stderr)
r = run("crew-frame", "--off", env=dict(ENV, CREW_FRAME="0"))
check("CREW_FRAME=0 turns it off entirely",
      r.returncode == 0 and '"#1565C0"' in open(CMUX_JSON).read() and reloads() == 4)
open(CMUX_JSON, "w").write('{ "app": {} }\n')
r = run("crew-frame", "--color", "#1565C0", env=ENV)
check("a cmux.json without the key: exit 1, says to run crew apply, writes nothing",
      r.returncode == 1 and "run: crew apply" in r.stderr and open(CMUX_JSON).read() == '{ "app": {} }\n',
      r.stderr)


# --- crew-listen ----------------------------------------------------------------------
print("crew-listen")
LSTATE = os.path.join(CACHE, "cmux-crew")
LENV = dict(ENV, CREW_SYNC_INTERVAL="3600", CREW_BOARD_TICK="0")
# The Python starts its siblings from its own folder (here the stub tree, which
# logs each call). seamux starts crew-sync and crew-frame as `seamux <tool>`,
# its own tools, so under Rust they are judged by what they do: a sync takes
# the run lock, and the frame paints the workspace it was given.
RUST_LISTEN = crew_impl.is_rust("crew-listen")
SYNC_LOCK = os.path.join(LSTATE, "sync.lock")


def waited(cond, secs=15):
    end = time.time() + secs
    while time.time() < end and not cond():
        time.sleep(0.2)
    return cond()


def sync_started():
    return ["crew-sync"] in stub_calls() or (RUST_LISTEN and os.path.exists(SYNC_LOCK))


if os.path.exists(SYNC_LOCK):
    os.remove(SYNC_LOCK)
clear_log()
r = run("crew-listen", "--once", env=LENV, crew_home=STUB_HOME)
calls = stub_calls()
check("--once with no stamp: prints reconciled and starts crew-sync"
      + ("" if RUST_LISTEN else " and a board push"),
      r.returncode == 0 and r.stdout.strip() == "reconciled"
      and os.path.exists(os.path.join(LSTATE, "sync-stamp")), r.stdout + r.stderr)
# The Rust listener no longer pushes the board: the Dock board is retired at
# the cutover, and /board follows the state over SSE. The Python, kept in the
# tree only for the probes until inc4, still pushes.
pushed = lambda c: any(x[:2] == ["crew-board", "push"] for x in c)  # noqa: E731
waited(lambda: sync_started() and (RUST_LISTEN or pushed(stub_calls())), 10)
time.sleep(0.5 if RUST_LISTEN else 0)
calls = stub_calls()
check("…the sync it starts is the sibling crew-sync, and the push is crew-board push"
      if not RUST_LISTEN else "…the sync it starts is the sibling crew-sync, and no board push (retired)",
      sync_started() and (pushed(calls) != RUST_LISTEN), str(calls))
r = run("crew-listen", "--once", env=LENV, crew_home=STUB_HOME)
check("--once again inside the throttle: not due", r.returncode == 0 and r.stdout.strip() == "not due",
      r.stdout + r.stderr)
open(os.path.join(LSTATE, "disabled"), "w").close()
r = run("crew-listen", "--once", env=LENV, crew_home=STUB_HOME)
check("--once while crew is off: disabled", r.stdout.strip() == "disabled", r.stdout)
os.remove(os.path.join(LSTATE, "disabled"))
os.remove(os.path.join(LSTATE, "sync-stamp"))

events = [{"seq": 1, "name": "workspace.selected", "workspace_id": "ws-a",
           "payload": {"workspace_id": "ws-b"}},
          {"seq": 2, "name": "sidebar.metadata.updated", "workspace_id": "ws-a"},
          {"seq": 3, "name": "workspace.created", "workspace_id": "ws-c"},
          {"seq": 4, "name": "workspace.renamed", "workspace_id": "ws-c"}]
with open(os.path.join(FAKE_DIR, "events.jsonl"), "w") as fh:
    fh.write("".join(json.dumps(e) + "\n" for e in events))
# ws-a is the selected one; the event names ws-b, whose colour the frame must take.
put_rows([ws("ws-a", "/r/a", custom_color="#1565C0", selected=True),
          ws("ws-b", "/r/b", custom_color="#7D6608")])
open(CMUX_JSON, "w").write(FRAME_SRC)
if os.path.exists(SYNC_LOCK):
    os.remove(SYNC_LOCK)
clear_log()
p = spawn("crew-listen", env=LENV, crew_home=STUB_HOME)
waited(sync_started)
time.sleep(1.0)
pid = open(os.path.join(LSTATE, "listen.pid")).read().strip() if os.path.exists(
    os.path.join(LSTATE, "listen.pid")) else ""
second = run("crew-listen", env=LENV, crew_home=STUB_HOME)
p.send_signal(__import__("signal").SIGINT)      # ^C, as a person stops it
try:
    _, err = p.communicate(timeout=10)
except subprocess.TimeoutExpired:
    p.kill()
    _, err = p.communicate()
calls = stub_calls()
ev_calls = [l for l in cmux_log() if l.startswith("events ")]
check("it follows the four structural events through cmux events, with the cursor",
      ev_calls and all(f"--name {n}" in ev_calls[0] for n in
                       ("workspace.created", "workspace.closed", "workspace.renamed", "workspace.selected"))
      and "--cursor-file " + os.path.join(LSTATE, "events.seq") in ev_calls[0]
      and "--reconnect" in ev_calls[0] and "sidebar.metadata.updated" not in ev_calls[0], str(ev_calls))
if RUST_LISTEN:
    check("at startup it makes sure the click server is up, and pushes no board (retired)",
          ["crew-board-intent", "--status"] in calls and not pushed(calls), str(calls))
else:
    check("at startup it pushes the board and makes sure the click server is up",
          ["crew-board", "push"] in calls and ["crew-board-intent", "--status"] in calls, str(calls))
    check("a selection pushes the board fast with the payload's workspace id",
          ["crew-board", "push", "--fast", "--selected", "ws-b"] in calls, str(calls))
check("…and repaints the frame for that same workspace",
      ["crew-frame", "--workspace", "ws-b"] in calls
      or (RUST_LISTEN and waited(lambda: '"activePaneBorderColor": "#7D6608"' in open(CMUX_JSON).read(), 10)),
      str(calls) + open(CMUX_JSON).read())
syncs = (err.count("reconcile <- ") if RUST_LISTEN else sum(1 for c in calls if c == ["crew-sync"]))
check("a structural event reconciles exactly once; the next is throttled",
      syncs == 1 and "workspace.renamed (no reconcile: throttled)" in err, err)
check("an event crew emits itself never reaches it",
      "sidebar.metadata.updated" not in err, err)
check("the cursor is kept: the last event's seq",
      open(os.path.join(LSTATE, "events.seq")).read().strip() == "4")
check("it holds a pidfile while running, and a second listener steps aside",
      pid == str(p.pid) and second.returncode == 0 and f"already running as pid {p.pid}" in second.stderr,
      f"pid={pid!r} p={p.pid} {second.stderr}")
# Not the exit code: ^C inside the stream returns 0, ^C in the retry sleep dies by
# the signal, and which one it lands in is timing.
check("…and on ^C clears the pidfile", not os.path.exists(os.path.join(LSTATE, "listen.pid")),
      f"rc={p.returncode}")


# --- crew-feed ------------------------------------------------------------------------
print("crew-feed")
GUARD = os.path.join(HOME, ".claude", "hooks", "cmux", "guard_bash.sh")
os.makedirs(os.path.dirname(GUARD))
with open(GUARD, "w") as fh:
    fh.write('#!/bin/bash\ngrep -q "rm -rf" && exit 2\nexit 0\n')
os.chmod(GUARD, 0o755)
os.makedirs(os.path.join(HOME, ".cmuxterm"))
json.dump({"activeSessionsByWorkspace": {"ws-f": {"sessionId": "s-f"}, "ws-g": {"sessionId": "s-g"}},
           "sessions": {"s-f": {"agentLifecycle": "needsInput", "pid": os.getpid(), "cwd": "/r/f"},
                        "s-g": {"agentLifecycle": "running", "pid": os.getpid(), "cwd": "/r/g"}}},
          open(os.path.join(HOME, ".cmuxterm", "claude-hook-sessions.json"), "w"))
now = datetime.now(timezone.utc)
iso = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%SZ")
AUDIT = os.path.join(CACHE, "cmux-crew", "feed-audit.jsonl")


def feed(*items):
    json.dump(list(items), open(os.path.join(FAKE_DIR, "feed.json"), "w"))


def ask(cmd, rid="r-1", age=5, status="pending", cwd="/r/f", kind="permissionRequest", **kw):
    return dict({"kind": kind, "cwd": cwd, "status": status, "request_id": rid,
                 "updated_at": iso(now - timedelta(seconds=age)), "tool_name": "Bash",
                 "tool_input": json.dumps({"command": cmd}), "workstream_id": "wsm-1"}, **kw)


def desc(wid):
    return next(w for w in rows() if w["id"] == wid)["description"]


def audits():
    return [json.loads(l) for l in open(AUDIT)] if os.path.exists(AUDIT) else []


put_rows([ws("ws-f", "/r/f", description="tag:keep feed:stale"), ws("ws-g", "/r/g")])
feed(ask("ls -la", age=900, rid="old"), ask("ls -la"), ask("echo hi", cwd="/r/elsewhere"))
r = run("crew-feed", "publish", "ws-f", env=ENV)
toks = desc("ws-f").split()
check("a live ask publishes feed:perm, its deadline, allow, its request and workstream",
      r.returncode == 0 and toks[0] == "tag:keep" and toks[1:3] == ["feed:perm", toks[2]]
      and toks[2].startswith("feedby:") and toks[3:] == ["feedgate:allow", "feedreq:r-1", "feedws:wsm-1"],
      str(toks))
check("…the deadline is the window's end, not now",
      abs(int(toks[2].split(":")[1]) - (time.time() + 115)) < 10, toks[2])
check("…its own old tokens are replaced and other tokens kept", "feed:stale" not in toks)
r = run("crew-feed", "show", "ws-f", env=ENV)
check("show says what it would publish, and why",
      r.returncode == 0 and "  kind      permissionRequest" in r.stdout and "  live      True" in r.stdout
      and "  text      Bash: ls -la" in r.stdout and "  allow     True" in r.stdout
      and "(window 120s)" in r.stdout, r.stdout)
feed(ask("ls -la", age=900))
run("crew-feed", "publish", "ws-f", env=ENV)
check("an ask past the window publishes feed:stale and nothing to tap",
      desc("ws-f").split() == ["tag:keep", "feed:stale", "feedws:wsm-1"], desc("ws-f"))
feed(ask("ls -la", status="expired"))
run("crew-feed", "publish", "ws-f", env=ENV)
check("…so does one Feed no longer calls pending", "feed:stale" in desc("ws-f").split())
feed(ask("x" * 120))
run("crew-feed", "publish", "ws-f", env=ENV)
check("an ask too long to read on a row is read-only", "feedgate:read" in desc("ws-f").split(), desc("ws-f"))
feed(ask("rm -rf /tmp/x"))
run("crew-feed", "publish", "ws-f", env=ENV)
r = run("crew-feed", "show", "ws-f", env=ENV)
check("an ask the bash guard would block is read-only, and show says so",
      "feedgate:read" in desc("ws-f").split() and "(guard_bash would block this command)" in r.stdout,
      r.stdout)
feed(ask("ls", cwd="/r/g"))
put_rows([ws("ws-f", "/r/f", description="tag:keep"), ws("ws-g", "/r/g")])
run("crew-feed", "publish", "ws-g", env=ENV)
check("an agent that is not waiting makes the ask stale", desc("ws-g") == "feed:stale feedws:wsm-1",
      desc("ws-g"))
r = run("crew-feed", "clear", "ws-g", env=ENV)
check("clear drops the feed tokens (and clears an empty description)",
      r.returncode == 0 and desc("ws-g") == ""
      and any(l.startswith("workspace-action --action clear-description") for l in cmux_log()))
feed()
r = run("crew-feed", "show", "ws-g", env=ENV)
check("show with no ask says so", r.stdout == "  no Feed ask for this workspace\n", r.stdout)

feed(ask("ls -la"))
clear_log()
r = run("crew-feed", "reply", "always", "ws-f", env=ENV)
check("reply with a mode the board never offers: exit 2, refused, audited",
      r.returncode == 2 and audits()[-1]["result"] == "refused" and audits()[-1]["why"] == "unknown mode",
      r.stderr)
r = run("crew-feed", "reply", "once", "ws-f", env=ENV)
sent = [l for l in cmux_log() if l.startswith("rpc feed.permission.reply")]
check("reply once on a live, allowed ask sends it through Feed",
      r.returncode == 0 and sent and json.loads(sent[0].split(" ", 2)[2]) == {"request_id": "r-1", "mode": "once"},
      str(cmux_log()))
check("…audits what was sent", audits()[-1]["result"] == "sent" and audits()[-1]["text"] == "Bash: ls -la"
      and audits()[-1]["response"] == {"ok": True}, str(audits()[-1:]))
check("…and clears its tokens", desc("ws-f") == "tag:keep", desc("ws-f"))
feed(ask("ls -la", age=900))
r = run("crew-feed", "reply", "once", "ws-f", env=ENV)
check("reply after the window closed: exit 1, refused, and the row goes stale",
      r.returncode == 1 and audits()[-1]["why"] == "window closed" and "feed:stale" in desc("ws-f"))
r = run("crew-feed", "show", env=ENV)
check("no workspace at all: exit 1", r.returncode == 1 and "crew-feed: no workspace" in r.stderr)


# --- crew-digest ----------------------------------------------------------------------
print("crew-digest")
ORIGIN = os.path.join(T, "origin.git")
MAIN = os.path.join(T, "mono")
subprocess.run(["git", "init", "-q", "--bare", ORIGIN], check=True, env=ENV)
subprocess.run(["git", "clone", "-q", ORIGIN, MAIN], check=True, env=ENV, capture_output=True)
open(os.path.join(MAIN, "a"), "w").write("a\n")
git(MAIN, "add", "a")
# Each commit a minute apart: git log orders by date, and a tie reorders the groups.
at = lambda m: {"GIT_AUTHOR_DATE": "@%d +0000" % (time.time() - 3 * 3600 + 60 * m),
                "GIT_COMMITTER_DATE": "@%d +0000" % (time.time() - 3 * 3600 + 60 * m)}
git(MAIN, "commit", "-qm", "base", **at(0))
git(MAIN, "push", "-q", "origin", "master")
SHIPPED = os.path.join(T, "mono.worktrees", "shipped")
WIP = os.path.join(T, "mono.worktrees", "wip")
git(MAIN, "worktree", "add", "-q", "-b", "dev/shipped", SHIPPED, "origin/master")
git(MAIN, "worktree", "add", "-q", "-b", "dev/wip", WIP, "origin/master")
for n in range(8):
    open(os.path.join(WIP, f"w{n}"), "w").write("w\n")
    git(WIP, "add", f"w{n}")
    git(WIP, "commit", "-qm", f"wip step {n}", **at(n + 1))
git(MAIN, "fetch", "-q")
json.dump({"sessions": {
    "s-wait": {"agentLifecycle": "needsInput", "cwd": "/r/waiting-one", "updatedAt": time.time() - 2 * 3600 - 300},
    "s-run": {"agentLifecycle": "running", "cwd": "/r/busy", "updatedAt": time.time()}}},
    open(os.path.join(HOME, ".cmuxterm", "claude-hook-sessions.json"), "w"))
GH = os.path.join(PATHBIN, "gh")
with open(GH, "w") as fh:
    fh.write("""#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if "merged" in a:
    print(json.dumps([{"number": 7, "title": "landed thing", "headRefName": "dev/x"}]))
elif "open" in a:
    print(json.dumps([
        {"number": 8, "title": "red one", "isDraft": False, "reviewDecision": "",
         "statusCheckRollup": [{"name": "unit", "conclusion": "FAILURE"}, {"context": "lint", "state": "ERROR"}]},
        {"number": 9, "title": "approved one", "isDraft": False, "reviewDecision": "APPROVED",
         "statusCheckRollup": [{"name": "unit", "conclusion": "SUCCESS"}]},
        {"number": 10, "title": "waiting one", "isDraft": False, "reviewDecision": "", "statusCheckRollup": []},
        {"number": 11, "title": "a draft", "isDraft": True, "reviewDecision": "", "statusCheckRollup": []}]))
""")
os.chmod(GH, 0o755)
json.dump({"news": {"hours": 5, "lede": "x", "items": [
    {"tier": "attend", "text": "{{api}} wants you"}, {"tier": "done", "text": "`ui` landed"}]}},
    open(NEWS, "w"))
DENV = dict(ENV, CREW_MONOLITH=MAIN)
clear_log()
r = run("crew-digest", "--hours", "24", "--notify", env=DENV, crew_home=STUB_HOME, timeout=120)
out = r.stdout
plain = __import__("re").sub(r"\033\[[0-9;]*m", "", out)
check("the window it reports on", r.returncode == 0 and "crew digest  the last 24h" in plain, plain[:300])
check("where things stand: the board's news, from crew-board state --fast --json",
      "where things stand  commits: last 5h" in plain and "● api wants you" in plain and "● ui landed" in plain
      and ["crew-board", "state", "--fast", "--json"] in stub_calls(), plain)
# %D names refs only on a branch's tip, so the commits below dev/wip's tip carry
# none and group as "(no ref)": what the Python does today, whatever its comment
# says, and so what a port must do.
check("commits grouped by the ref on each, busiest group first, six shown then a count",
      "✓ 9 commit(s)" in plain and plain.index("(no ref)") < plain.index("dev/wip") < plain.index("master")
      and "wip step 6" in plain and "… 1 more" in plain and "wip step 0" not in plain
      and plain.split("dev/wip")[1].split("master")[0].strip().endswith("wip step 7"), plain)
check("PRs from gh: merged, red with the failing checks, approved, and a count waiting",
      "⇢ merged  #7  landed thing" in plain and "✗ 1 PR(s) red" in plain and "unit, lint" in plain
      and "✓ 1 approved, ready to merge" in plain and "1 open PR(s) awaiting review" in plain, plain)
check("sessions waiting on you, with how long",
      "⏳ 1 session(s) waiting on you" in plain and "waiting-one" in plain and "2h 5m" in plain, plain)
check("worktrees merged into origin/master and clean are reclaimable; others are not",
      "♻ 1 worktree(s) shipped and reclaimable" in plain and "shipped" in plain.split("♻")[1]
      and "dev/shipped" in plain and "wip " not in plain.split("♻")[1], plain)
notes = [l for l in cmux_log() if l.startswith("notify ")]
check("--notify posts one line: commits, merged, reclaimable",
      notes == ["notify --title crew digest --subtitle crew:digest --body 9 commits · 1 merged · 1 reclaimable"],
      str(notes))
r = run("crew-digest", "--paragraph", env=DENV, crew_home=STUB_HOME)
check("--paragraph: only the news, as one plain sentence run",
      r.returncode == 0 and r.stdout == "api wants you ui landed\n", repr(r.stdout))
os.remove(NEWS)
os.remove(GH)
os.remove(os.path.join(HOME, ".cmuxterm", "claude-hook-sessions.json"))
r = run("crew-digest", "--paragraph", env=DENV, crew_home=STUB_HOME)
check("--paragraph with no news: exit 1, nothing printed", r.returncode == 1 and r.stdout == "")
r = run("crew-digest", "--hours", "24", env=dict(DENV, CREW_MONOLITH=os.path.join(T, "nowhere")),
        crew_home=STUB_HOME, timeout=120)
plain = __import__("re").sub(r"\033\[[0-9;]*m", "", r.stdout)
check("with every source missing, each section goes quiet and the run still succeeds",
      r.returncode == 0 and "no commits the last 24h" in plain and "where things stand" not in plain
      and "PR(s)" not in plain and "waiting on you" not in plain and "reclaimable" not in plain, plain)


# --- crew-resume --rows-json ------------------------------------------------------------
print("crew-resume --rows-json")
PROJ = os.path.join(HOME, ".claude", "projects")


def transcript(cwd, sid, prompt, mtime, branch=""):
    d = os.path.join(PROJ, cwd.replace("/", "-"))
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, sid + ".jsonl")
    with open(p, "w") as fh:
        fh.write(json.dumps({"type": "user", "cwd": cwd, "gitBranch": branch,
                             "message": {"content": prompt}}) + "\n")
    os.utime(p, (mtime, mtime))


LIVE, PAST, ARCH = os.path.join(T, "repo-live"), os.path.join(T, "repo-past"), os.path.join(T, "repo-arch")
for d in (LIVE, PAST, ARCH):
    os.makedirs(d)
GONE = os.path.join(T, "repo-gone")
base = time.time() - 86400
transcript(LIVE, "aaaa1111-live-old", "older talk", base)
transcript(LIVE, "aaaa2222-live-new", "newest talk", base + 100)
transcript(PAST, "bbbb1111-past", "dock organization work", base + 200, "dev/dock-org")
transcript(GONE, "cccc1111-gone", "gone talk", base + 300)
os.makedirs(os.path.join(CACHE, "cmux-crew"), exist_ok=True)
json.dump({"records": {ARCH: {"cwd": ARCH, "title": "arch-one", "archived_at": base + 50}}},
          open(os.path.join(CACHE, "cmux-crew", "archive.json"), "w"))
put_rows([ws("w-live", LIVE, title="live-one")])
r = run("crew-resume", "--rows-json", "--all", env=ENV, cwd=T)
got = json.loads(r.stdout or "{}")
got_all_live_known = got.get("live_known") is True
by = {x["cwd"]: x for x in got.get("rows", [])}
check("one row per directory, however many sessions it has",
      r.returncode == 0 and got.get("total") == 4 and len(by) == 4
      and by[LIVE]["sessions"] == ["aaaa2222-live-new", "aaaa1111-live-old"], r.stdout + r.stderr)
check("a row's state: live, archived, past, gone",
      [by[c]["state"] for c in (LIVE, ARCH, PAST, GONE)] == ["live", "archived", "past", "gone"])
check("a live row is named by its workspace, carries it, and its latest session",
      by[LIVE]["title"] == "live-one" and by[LIVE]["ws"] == "w-live" and by[LIVE]["latest"] == "newest talk")
check("with no query: state first, then recency",
      [x["state"] for x in got["rows"]] == ["live", "archived", "past", "gone"], str(got["rows"]))
r = run("crew-resume", "--rows-json", "--all", "dkorg", env=ENV, cwd=T)
got = json.loads(r.stdout or "{}")
check("a query keeps only what it matches: an abbreviation of the branch",
      [x["cwd"] for x in got["rows"]] == [PAST], r.stdout)
r = run("crew-resume", "--rows-json", "--all", "bbbb1111", env=ENV, cwd=T)
check("a session id prefix finds its row", [x["cwd"] for x in json.loads(r.stdout)["rows"]] == [PAST])
r = run("crew-resume", "--rows-json", "--all", "zzzq", env=ENV, cwd=T)
check("no match, no rows (the total still counts them all)",
      json.loads(r.stdout)["rows"] == [] and json.loads(r.stdout)["total"] == 4)
check("cmux answered, and the JSON says so", got_all_live_known)
r = run("crew-resume", "--rows-json", "--all", "--reindex", env=dict(ENV, CREW_CMUX="/usr/bin/false"), cwd=T)
got = json.loads(r.stdout or "{}")
check("--reindex keeps its progress line off stdout; a silent cmux is live_known false, live rows read past",
      got.get("live_known") is False and "indexed " in r.stderr
      and {x["cwd"]: x["state"] for x in got["rows"]}.get(LIVE) == "past", r.stdout[:300] + r.stderr)
r = run("crew-resume", "--rows-json", env=ENV, cwd=MAIN)
got = json.loads(r.stdout or "{}")
check("without --all the finder scopes to the repo it runs in",
      got.get("scope") == os.path.realpath(MAIN) or got.get("scope") == MAIN, str(got.get("scope")))


# --- smoke: the four with deeper probes elsewhere ------------------------------------------
print("smoke: crew-sync, crew-color, crew-overlay, crew-sweep")
put_rows([ws("ws-s", MAIN, title="mono")])
clear_log()
r = run("crew-sync", "--dry-run", env=dict(ENV, CREW_MONOLITH=MAIN), timeout=120)
writes = [l for l in cmux_log() if l.split(" ")[0] in
          ("workspace-action", "rename-workspace", "set-progress", "clear-progress", "todo",
           "clear-status", "notify") or l.startswith("workspace status set")]
check("crew-sync --dry-run reconciles a workspace and writes nothing to cmux",
      r.returncode == 0 and not writes and any(l.startswith("workspace list") for l in cmux_log()),
      f"rc={r.returncode} writes={writes} {r.stderr[-300:]}")

# A real sync: a worktree on a ticket branch, a live session mid-task. The
# exact cmux calls are the contract (fakecmux logs them, the board reads them).
SYNCWT = os.path.join(T, "syncwt")
git(MAIN, "worktree", "add", "-q", "-b", "dev/tidy-proj-3", SYNCWT)
os.makedirs(os.path.join(HOME, ".cmuxterm"), exist_ok=True)
json.dump({"activeSessionsByWorkspace": {"ws-y": {"sessionId": "SY"}},
           "sessions": {"SY": {"agentLifecycle": "running", "pid": os.getpid()}}},
          open(os.path.join(HOME, ".cmuxterm", "claude-hook-sessions.json"), "w"))
TASKS = os.path.join(HOME, ".claude", "tasks", "SY")
os.makedirs(TASKS)
for i, (st, subj) in enumerate([("completed", "a"), ("in_progress", "b")], 1):
    json.dump({"subject": subj, "status": st, "activeForm": "Doing " + subj}, open(os.path.join(TASKS, f"{i}.json"), "w"))
put_rows([ws("ws-y", SYNCWT, title="syncwt", has_custom_title=False)])
clear_log()
r = run("crew-sync", env=dict(ENV, CREW_GH_INTERVAL="0"), timeout=120)
log = cmux_log()
desc = next((l for l in log if l.startswith("workspace-action --action set-description")), "")
check("crew-sync renames a worktree after its ticket, publishes its plan, phase and stamp, and colours it",
      r.returncode == 0
      and "rename-workspace --workspace ws-y PROJ-3 · tidy" in log
      and "set-progress 0.5000 --label 1/2 · Doing b --workspace ws-y" in log
      and 'todo set [{"text":"a","state":"completed"},{"text":"b","state":"in-progress"}] --workspace ws-y' in log
      # gone:merged: the new branch has no commits of its own, so it is contained in origin's
      and desc.startswith("workspace-action --action set-description --description phase:working gone:merged synced:")
      and any(l.startswith("workspace-action --action set-color --color #") for l in log),
      f"rc={r.returncode}\n       " + "\n       ".join(log) + r.stderr[-300:])
check("…and reports each change",
      "  ws-y  name -> PROJ-3 · tidy\n  ws-y  progress -> 1/2 · Doing b\n" in r.stdout, r.stdout)

COLOR_ENV = dict(ENV, CREW_CMUX="/usr/bin/false")
r = run("crew-color", "peek", MAIN, env=COLOR_ENV)
check("crew-color peek allocates nothing", r.returncode == 0 and r.stdout == "")
r = run("crew-color", "assign", MAIN, env=COLOR_ENV)
hexv = r.stdout.strip()
check("crew-color assign gives a root a #RRGGBB", r.returncode == 0 and len(hexv) == 7 and hexv[0] == "#",
      r.stdout + r.stderr)
r2 = run("crew-color", "assign", MAIN, env=COLOR_ENV)
check("…the same one every time", r2.stdout.strip() == hexv)
r = run("crew-color", "show", MAIN, env=COLOR_ENV)
check("crew-color show names it and says Peacock is not applied",
      r.returncode == 0 and f"  color      {hexv}" in r.stdout and "  peacock    not applied" in r.stdout, r.stdout)

# A family: the parent's colour (Blue, preset), shades on the children, a child's
# Peacock file followed, and leaving puts the colour from before back. The hexes
# are the Python's own arithmetic (Peacock's HSL lighten/darken).
import hashlib  # noqa: E402
FAM = os.path.join(T, "fam")
PARENT, KID1, KID2 = (os.path.join(FAM, n) for n in ("parent", "kid1", "kid2"))
for d in (PARENT, KID1, os.path.join(KID2, ".vscode")):
    os.makedirs(d)
open(os.path.join(KID2, ".vscode", "settings.json"), "w").write(
    '{\n  // mine\n  "peacock.color": "#C0392B", "editor.fontSize": 13,\n}\n')
REG = os.path.join(CACHE, "cmux-crew", "colors")
os.makedirs(REG, exist_ok=True)
open(os.path.join(REG, hashlib.md5(PARENT.encode()).hexdigest()), "w").write(
    f"ROOT={PARENT}\nCOLOR=#1565C0\nNAME=Blue\nCREATED=1\n")
open(os.path.join(REG, hashlib.md5(KID2.encode()).hexdigest()), "w").write(
    f"ROOT={KID2}\nCOLOR=#C0392B\nNAME=Red\nCREATED=2\n")
r = run("crew-color", "family", PARENT, KID1, KID2, env=COLOR_ENV)
check("crew-color family: the parent keeps Blue, the children take its shades",
      r.returncode == 0 and r.stdout == f"{PARENT}\t#1565C0\n{KID1}\t#3D8EEA\n{KID2}\t#0D3E76\n", r.stdout + r.stderr)
k2 = json.loads(open(os.path.join(KID2, ".vscode", "settings.json")).read())
cc = k2.get("workbench.colorCustomizations") or {}
check("…a child already wearing Peacock follows its shade, keeping its own keys",
      k2.get("peacock.color") == "#0D3E76" and k2.get("editor.fontSize") == 13
      and cc.get("activityBar.background") == "#104A8D" and cc.get("activityBarBadge.background") == "#3488E8"
      and cc.get("statusBar.foreground") == "#e7e7e7", str(k2))
check("…and a child with no .vscode gets none", not os.path.exists(os.path.join(KID1, ".vscode")))
r = run("crew-color", "list", env=COLOR_ENV)

def color_block(out, hexv):
    """The list's line for one colour and the holder lines under it."""
    lines = out.splitlines()
    for i, l in enumerate(lines):
        if l[4:11] == hexv:
            rest = [x for x in lines[i + 1:]]
            end = next((j for j, x in enumerate(rest) if not x.startswith("        ")), len(rest))
            return l, [x.strip() for x in rest[:end]]
    return "", []


blue, holders = color_block(r.stdout, "#1565C0")
# Another worktree (the crew-sync case above) may hash to Blue too: then the
# line also says (shared), which is the list doing its job.
check("crew-color list marks Blue held and names its holder",
      r.returncode == 0 and blue.startswith("  ● #1565C0  Blue") and "parent" in holders, r.stdout)
r = run("crew-color", "unfamily", "--stale", env=COLOR_ENV)
check("crew-color unfamily --stale gives each member its colour from before",
      r.returncode == 0 and f"{KID2}\t#C0392B\n" in r.stdout and f"{KID1}\t\n" in r.stdout
      and json.loads(open(os.path.join(KID2, ".vscode", "settings.json")).read())["peacock.color"] == "#C0392B",
      r.stdout + r.stderr)
r = run("crew-color", "bogus", env=COLOR_ENV)
check("crew-color: an unknown command fails with exit 1", r.returncode == 1 and r.stdout == "" and "unknown 'bogus'" in r.stderr)

TEMPLATE = """{
  // the template's own docs
  "hosts": ["a", "b"],
  "link": "https://example.invalid//x",
  "controls": [ {"id": "one", "label": "One"}, {"id": "two", "label": "Two", "x": 1} ],
  "nested": { "keep": true, "swap": 1 }
}
"""
OVER = os.path.join(T, "overlay.json")
open(OVER, "w").write('{ /* mine */ "hosts": ["c"], "controls": [{"id": "two", "label": "Mine"},'
                      ' {"id": "three"}], "nested": {"swap": 2}, "extra": null }')
r = run("crew-overlay", OVER, "my-overlay.json", env=ENV, stdin=TEMPLATE)
check("crew-overlay: controls merge by id, lists replace, nested dicts merge, strict JSON out",
      r.returncode == 0 and r.stdout == json.dumps({
          "hosts": ["c"], "link": "https://example.invalid//x",
          "controls": [{"id": "one", "label": "One"}, {"id": "two", "label": "Mine", "x": 1}, {"id": "three"}],
          "nested": {"keep": True, "swap": 2}, "extra": None}, indent=2) + "\n", r.stdout + r.stderr)
open(OVER, "w").write("{ nope")
r = run("crew-overlay", OVER, "my-overlay.json", env=ENV, stdin=TEMPLATE)
check("…an unreadable overlay fails loudly, naming the file it was given",
      r.returncode == 1 and r.stdout == "" and "cannot read overlay my-overlay.json" in r.stderr, r.stderr)

put_rows([])
r = run("crew-sweep", "--json", env=dict(ENV, CREW_CLAUDE_PROJECTS=os.path.join(T, "no-projects")), timeout=120)
got = json.loads(r.stdout or "{}")
check("crew-sweep --json on a machine with nothing to sweep: an empty queue",
      r.returncode == 0 and got.get("queue") == [] and "dormant_days" in got, r.stdout + r.stderr)


shutil.rmtree(T, ignore_errors=True)
print(f"\n{sum(results)}/{len(results)} hold")
sys.exit(0 if all(results) else 1)
