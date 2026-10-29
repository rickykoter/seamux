#!/usr/bin/env python3
"""install_probe — `crew apply`, `crew uninstall` and crew-sandbox's naming and
prune, in a throwaway HOME with a fake seamux, cmux and sbx. No app, no
network, no real config, no Keychain (sandboxes run --claude=isolated).

What is asserted:

  - crew-sandbox names a sandbox crew-<base>-<8 hex of the root>, so two
    worktrees with one basename get two sandboxes; a root registered under an
    old basename-only name keeps it; a name two roots are registered to is
    neither reused by `up` (it gets its own) nor destroyed by `rm`;
  - prune keeps every config dir when sbx cannot list its sandboxes, and
    drops only the unreferenced one when it can;
  - apply backs up a project and a global Dock it did not write (once, with a
    timestamp), keeps the newest five live-tree backups, keeps the legacy
    settings.json hooks while the crew plugin is not enabled and strips them
    once it is (atomically: no temp file left), and bounces only the intent
    server listening on the recorded port, not another process whose command
    line names it;
  - uninstall puts both Docks back, keeps the sandbox registry and
    transcripts while clearing the rest of the state, does not kill a
    listen.pid that is no longer the reconciler, and claims no removal of a
    thing that was never there.

    python3 crew/tools/install_probe.py      exit 0 when all hold
"""
import glob
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CREW = os.path.join(REPO, "crew")
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


def write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    if mode:
        os.chmod(path, mode)


T = os.path.realpath(tempfile.mkdtemp(prefix="install-probe-"))
HOME = os.path.join(T, "home")
FAKE = os.path.join(T, "fake")
BIN = os.path.join(FAKE, "bin")
STATE = os.path.join(HOME, ".cache", "cmux-crew")
os.makedirs(BIN)
os.makedirs(HOME)
spawned = []          # pids this probe must not leave behind

# --- fakes -------------------------------------------------------------------
write(os.path.join(BIN, "cmux"), "#!/bin/sh\nexit 0\n", 0o755)

SBX_STATE = os.path.join(FAKE, "sbx.json")
write(os.path.join(BIN, "sbx"), f"""#!{sys.executable}
import json, os, sys
p = {SBX_STATE!r}
a = sys.argv[1:]
st = json.load(open(p)) if os.path.exists(p) else {{}}
open(p + ".log", "a").write(" ".join(a) + "\\n")
if a[:2] == ["daemon", "status"]:
    print("running")
elif a[:1] == ["ls"]:
    if "--json" in a:
        if os.path.exists(p + ".broken"):
            print("{{not json")
        else:
            print(json.dumps({{"sandboxes": [{{"name": n, "status": s}} for n, s in st.items()]}}))
    else:
        print("ok")
elif a[:1] == ["create"]:
    st[a[a.index("--name") + 1]] = "stopped"
elif a[:1] == ["rm"]:
    st.pop(a[-1], None)
elif a[:1] == ["stop"]:
    st[a[-1]] = "stopped"
json.dump(st, open(p, "w"))
""", 0o755)

# The intent server stand-in: listens on the port in board-intent.port and
# records its pid. Exits on its own after a minute, whatever happens here.
INTENT = os.path.join(FAKE, "intent.py")
write(INTENT, f"""import os, socket, sys, time
port = int(open(os.path.join({STATE!r}, "board-intent.port")).read())
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
for _ in range(50):
    try:
        s.bind(("127.0.0.1", port)); break
    except OSError:
        time.sleep(0.05)
s.listen(5)
open(os.path.join({FAKE!r}, "intent.pids"), "a").write("%d\\n" % os.getpid())
end = time.time() + 60
while time.time() < end:
    time.sleep(0.2)
""")
SEAMUX = os.path.join(BIN, "seamux")
write(SEAMUX, f"""#!/bin/sh
case "$1" in
  --version) echo "seamux 0.0.0-probe" ;;
  --tools) printf '%s\\n' crew-color crew-digest crew-feed crew-resume crew-sweep crew-sync crew-listen crew-artifacts crew-board ;;
  crew-plugin-root) exit 1 ;;
  crew-board-intent) exec {sys.executable} {INTENT} crew-board-intent ;;
  *) exit 0 ;;
esac
""", 0o755)

PATH = ":".join([BIN, os.path.dirname(sys.executable), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
ENV = {"HOME": HOME, "PATH": PATH, "USER": os.environ.get("USER", "probe"), "TMPDIR": T,
       "SEAMUX_BIN": SEAMUX, "CREW_SBX": os.path.join(BIN, "sbx"),
       "CREW_SANDBOX_CLAUDE": "isolated", "GIT_CONFIG_GLOBAL": os.path.join(T, "gitconfig"),
       "GIT_CONFIG_NOSYSTEM": "1", "LANG": "en_US.UTF-8"}


def run(argv, env=None, timeout=60):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                          env=dict(ENV, **(env or {})), cwd=HOME)


def sbx_names():
    return set(json.load(open(SBX_STATE))) if os.path.exists(SBX_STATE) else set()


SANDBOX = os.path.join(CREW, "bin", "crew-sandbox")
REG = os.path.join(STATE, "sandbox", "roots")


def sb(*argv):
    return run(["bash", SANDBOX] + list(argv))


def status(root):
    return json.loads(sb("status", root, "--json").stdout or "{}")


def md5(s):
    import hashlib
    return hashlib.md5(s.encode()).hexdigest()


def register(root, name):
    write(os.path.join(REG, md5(root)), f"NAME={name}\nROOT={root}\nWS=\nTEMPLATE=\nCLAUDE_MODE=isolated\nCREATED=0\n")


# --- crew-sandbox: names -----------------------------------------------------
print("crew-sandbox")
A = os.path.join(T, "a.worktrees", "fix")
B = os.path.join(T, "b.worktrees", "fix")
U1, U2 = os.path.join(T, "w", "foo_bar"), os.path.join(T, "w", "foo-bar")
for d in (A, B, U1, U2):
    os.makedirs(d)
na, nb = status(A).get("name", ""), status(B).get("name", "")
check("two worktrees named fix get two names, crew-fix-<8 hex>",
      na != nb and na == "crew-fix-" + md5(A)[:8] and nb == "crew-fix-" + md5(B)[:8], f"{na} {nb}")
check("foo_bar and foo-bar no longer collide once sanitised",
      status(U1)["name"] != status(U2)["name"], f"{status(U1)} {status(U2)}")
ra, rb = sb("up", A), sb("up", B)
check("up on each creates its own sandbox",
      ra.returncode == 0 and rb.returncode == 0 and {na, nb} <= sbx_names(), ra.stderr + rb.stderr)

C = os.path.join(T, "c.worktrees", "legacy")
os.makedirs(C)
register(C, "crew-legacy")
json.dump(dict(json.load(open(SBX_STATE)), **{"crew-legacy": "stopped", "crew-shared": "stopped"}), open(SBX_STATE, "w"))
before = len(open(SBX_STATE + ".log").read().splitlines())
r = sb("up", C)
log = open(SBX_STATE + ".log").read().splitlines()[before:]
check("a root registered under an old basename name keeps it: up reuses, no create",
      r.returncode == 0 and status(C)["name"] == "crew-legacy" and not any(l.startswith("create") for l in log),
      r.stdout + r.stderr + repr(log))

D, E = os.path.join(T, "d.worktrees", "shared"), os.path.join(T, "e.worktrees", "shared")
for d in (D, E):
    os.makedirs(d)
    register(d, "crew-shared")
r = sb("exec", D, "--", "true")
check("exec refuses a sandbox another root is registered to",
      r.returncode != 0 and "also registered to" in r.stderr, r.stderr)
r = sb("rm", D)
check("rm of a sandbox two roots claim leaves it, drops only that root's entry",
      r.returncode == 0 and "crew-shared" in sbx_names() and not os.path.exists(os.path.join(REG, md5(D)))
      and os.path.exists(os.path.join(REG, md5(E))), r.stdout + r.stderr)
F = os.path.join(T, "f.worktrees", "shared")
os.makedirs(F)
register(F, "crew-shared")
r = sb("up", F)
nf = status(F)["name"]
check("up on a shared name gives that root its own sandbox and says so",
      r.returncode == 0 and nf == "crew-shared-" + md5(F)[:8] and nf in sbx_names()
      and "crew-shared" in sbx_names() and "also registered to" in r.stderr, r.stdout + r.stderr + nf)
r = sb("rm", E)
check("…and once one root is left, rm destroys it",
      r.returncode == 0 and "crew-shared" not in sbx_names(), r.stdout + r.stderr)

# --- crew-sandbox: prune -----------------------------------------------------
CFG = os.path.join(STATE, "sandbox", "claude")
for n in ("crew-orphan", na):
    os.makedirs(os.path.join(CFG, n, "projects"), exist_ok=True)
for f in os.listdir(REG):          # unregister A: only sbx still knows it
    if open(os.path.join(REG, f)).read().startswith(f"NAME={na}\n"):
        os.remove(os.path.join(REG, f))
open(SBX_STATE + ".broken", "w").close()
r = sb("prune")
check("prune with sbx answering garbage keeps every config dir and says why",
      os.path.isdir(os.path.join(CFG, "crew-orphan")) and os.path.isdir(os.path.join(CFG, na))
      and "did not list" in r.stderr, r.stdout + r.stderr)
r = run(["bash", SANDBOX, "prune"], env={"CREW_SBX": os.path.join(T, "no-sbx")})
check("…and with no sbx at all",
      os.path.isdir(os.path.join(CFG, "crew-orphan")) and "did not list" in r.stderr, r.stdout + r.stderr)
os.remove(SBX_STATE + ".broken")
r = sb("prune")
check("with a real answer, only the dir no entry and no sandbox owns goes",
      not os.path.exists(os.path.join(CFG, "crew-orphan")) and os.path.isdir(os.path.join(CFG, na)),
      r.stdout + r.stderr)

# --- crew apply --------------------------------------------------------------
print("crew apply")
CMUXD = os.path.join(HOME, ".config", "cmux")
GDOCK = os.path.join(CMUXD, "dock.json")
MONO = os.path.join(HOME, "code", "mono")
PDOCK = os.path.join(MONO, ".cmux", "dock.json")
SETTINGS = os.path.join(HOME, ".claude", "settings.json")
os.makedirs(MONO)
subprocess.run(["git", "init", "-q", MONO], check=True, env=ENV)
MINE_G = '{ "controls": [ { "id": "mine-global" } ] }\n'
MINE_P = '{ "controls": [ { "id": "mine-project" } ] }\n'
write(GDOCK, MINE_G)
write(PDOCK, MINE_P)
write(os.path.join(CMUXD, "cmux.json"), "{}\n")
LEGACY = {"hooks": {"Stop": [{"matcher": "", "hooks": [
    {"type": "command", "command": 'bash "/x/crew-hook.sh" stop'},
    {"type": "command", "command": "other.sh"}]}]}}
write(SETTINGS, json.dumps(LEGACY))
BACKUPS = os.path.join(CMUXD, "crew-backups")
for i in range(6):
    os.makedirs(os.path.join(BACKUPS, "crew.2020010%d-000000" % i))
os.makedirs(os.path.join(CMUXD, "crew", "bin"))          # a live tree to move aside

# A running intent server on the recorded port, and a decoy whose command line
# names crew-board-intent but which listens on nothing.
s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
write(os.path.join(STATE, "board-intent.port"), str(PORT))
old = subprocess.Popen([sys.executable, INTENT, "crew-board-intent"], start_new_session=True)
decoy = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "crew-board-intent"],
                         start_new_session=True)
spawned += [old.pid, decoy.pid]


def listening(port):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
        return True
    except OSError:
        return False


for _ in range(50):
    if listening(PORT):
        break
    time.sleep(0.05)
past = time.time() - 3600
os.utime(os.path.join(STATE, "board-intent.port"), (past, past))

APPLY_ENV = {"CREW_MONOLITH": MONO}
r = run(["bash", os.path.join(CREW, "bin", "crew"), "apply", "--dry-run"], env=APPLY_ENV)
check("dry run with the crew plugin not enabled: says the legacy hook would be kept",
      "would keep the 1 legacy" in r.stdout and "to remove" not in r.stdout, r.stdout + r.stderr)
r = run(["bash", os.path.join(CREW, "bin", "crew"), "apply"], env=APPLY_ENV)
out = r.stdout + r.stderr
check("apply runs", "rendered cmux.json" in out and os.path.isfile(os.path.join(CMUXD, "crew", "bin", "crew")), out)
gb, pb = glob.glob(GDOCK + ".pre-crew.*.bak"), glob.glob(PDOCK + ".pre-crew.*.bak")
check("the global and project Docks crew did not write are backed up, timestamped",
      len(gb) == 1 and open(gb[0]).read() == MINE_G and len(pb) == 1 and open(pb[0]).read() == MINE_P,
      f"{gb} {pb}")
check("…and rendered over with crew's", '"board"' in open(GDOCK).read() and '"board"' in open(PDOCK).read())
check("five live-tree backups kept, the oldest pruned",
      len(os.listdir(BACKUPS)) == 5 and "crew.20200100-000000" not in os.listdir(BACKUPS)
      and "crew.20200101-000000" not in os.listdir(BACKUPS), repr(sorted(os.listdir(BACKUPS))))
check("crew plugin not enabled: the legacy hook stays, and apply says why",
      "crew-hook.sh" in open(SETTINGS).read() and "not enabled" in out
      and "hooks come from the crew plugin" not in out, out)
old.wait(timeout=5) if old.poll() is None and not listening(PORT) else None
check("the intent server on the recorded port was bounced", old.poll() is not None, out)
check("…a decoy naming crew-board-intent was not touched", decoy.poll() is None)
time.sleep(0.2)
check("…and a new server listens there", listening(PORT), out)

r = run(["bash", os.path.join(HOME, ".config", "cmux", "crew", "bin", "crew"), "apply"], env=APPLY_ENV)
check("a second apply takes no new Dock backup",
      len(glob.glob(GDOCK + ".pre-crew.*bak")) == 1 and len(glob.glob(PDOCK + ".pre-crew.*bak")) == 1,
      r.stdout + r.stderr)

s = json.load(open(SETTINGS))
s["enabledPlugins"] = {"crew@seamux": True}
write(SETTINGS, json.dumps(s))
r = run(["bash", os.path.join(CREW, "bin", "crew"), "apply"], env=APPLY_ENV)
s = json.load(open(SETTINGS))
check("crew plugin enabled: apply strips the legacy hook, keeps the rest",
      "crew-hook.sh" not in json.dumps(s) and "other.sh" in json.dumps(s)
      and s["enabledPlugins"] == {"crew@seamux": True}, r.stdout + r.stderr)
check("…writing settings.json through a temp file it leaves nowhere",
      not [f for f in os.listdir(os.path.dirname(SETTINGS)) if f.startswith(".settings.json.crew-")])

# --- crew uninstall ----------------------------------------------------------
print("crew uninstall")
write(os.path.join(STATE, "sandbox", "roots", "keepme"), f"NAME=crew-k\nROOT={A}\n")
write(os.path.join(STATE, "sandbox", "claude", "crew-k", "projects", "t.jsonl"), "{}\n")
write(os.path.join(STATE, "listen.pid"), str(decoy.pid))
r = run(["bash", os.path.join(CMUXD, "crew", "bin", "crew"), "uninstall"], env=APPLY_ENV)
out = r.stdout + r.stderr
check("uninstall restores both Docks", open(GDOCK).read() == MINE_G and open(PDOCK).read() == MINE_P, out)
check("…keeps the sandbox registry and transcripts, clears the rest",
      os.path.isfile(os.path.join(STATE, "sandbox", "roots", "keepme"))
      and os.path.isfile(os.path.join(STATE, "sandbox", "claude", "crew-k", "projects", "t.jsonl"))
      and sorted(os.listdir(STATE)) == ["sandbox"], repr(os.listdir(STATE)) + out)
check("…leaves a listen.pid that is not the reconciler alive", decoy.poll() is None, out)
check("…and claims no removal it did not make",
      "removed sync timer" not in out and "removed event listener" not in out and "removed sidebar" not in out, out)

GDOCK2 = GDOCK
for f in glob.glob(GDOCK + ".pre-crew.*bak"):
    os.remove(f)
write(GDOCK2, '{ "controls": [ { "id": "board" } ] }\n')
r = run(["bash", os.path.join(CREW, "bin", "crew"), "uninstall"], env=APPLY_ENV)
check("with no backup, a crew-rendered global Dock is removed", not os.path.exists(GDOCK2), r.stdout)

# --- cleanup -----------------------------------------------------------------
try:
    spawned += [int(x) for x in open(os.path.join(FAKE, "intent.pids")).read().split()]
except OSError:
    pass
for pid in set(spawned):
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
shutil.rmtree(T, ignore_errors=True)
print(f"\n{sum(results)}/{len(results)} hold")
sys.exit(0 if all(results) else 1)
