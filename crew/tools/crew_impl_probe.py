#!/usr/bin/env python3
"""crew_impl_probe — crew_impl, the probes' helper, in Python and its node twin.

Each case runs both implementations in a fresh process and checks they give
the same answer. Against a stub seamux (SEAMUX_BIN): a registered tool runs as
seamux, an unregistered one and a missing seamux are refused, and the env the
tools need. Against a copy of crew_impl in a throwaway repo with a stub cargo
on PATH: with SEAMUX_BIN unset it builds seamux once per process, whether or
not a binary is already there; a failed build and a missing cargo are
refused with what went wrong; a probe that swaps HOME still builds with the
real one; and a seamux on PATH is never picked. No cmux and no real cargo:
the probes job runs this without a Rust toolchain.

    python3 crew/tools/crew_impl_probe.py
"""
import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PY = os.path.join(HERE, "crew_impl.py")
MJS = os.path.join(HERE, "crew_impl.mjs")
# node's own path, not a version manager's shim: the build cases run with a
# bare PATH, which a shim cannot resolve from.
NODE = subprocess.run(["node", "-p", "process.execPath"], capture_output=True, text=True).stdout.strip() or "node"
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


T = os.path.realpath(tempfile.mkdtemp(prefix="crew-impl-probe-"))
STUB = os.path.join(T, "seamux")
with open(STUB, "w") as fh:
    fh.write('#!/bin/sh\n[ "$1" = --tools ] && printf "crew-color\\ntriage\\n"\n')
os.chmod(STUB, 0o755)


def base_env(**kw):
    e = {k: v for k, v in os.environ.items() if k not in ("SEAMUX_BIN", "CREW_HOME", "CREW_CMUX_TRANSPORT")}
    e["SEAMUX_BIN"] = STUB
    e.update({k: v for k, v in kw.items() if v is not None})
    for k, v in kw.items():
        if v is None:
            e.pop(k, None)
    return e


# q: argv (a tool, asked `times` times), base (for env), swap_home (replace
# the env with a throwaway HOME first, as artifacts_probe does).
PY_SNIPPET = """
import json, os, sys
sys.path.insert(0, %r)
import crew_impl as C
q = json.loads(sys.argv[1])
if q.get("swap_home"):
    keep = {k: os.environ[k] for k in ("PATH", "SEAMUX_BIN", "FAKE_CARGO_LOG", "FAKE_CARGO_FAIL") if k in os.environ}
    os.environ.clear()
    os.environ.update(keep, HOME=q["swap_home"])
try:
    a = None
    for _ in range(q.get("times", 1)):
        a = C.argv(*q["argv"]) if q.get("argv") else None
    out = {"argv": a, "env": C.env(q.get("base", {})) if "base" in q else None}
except C.NotPorted as e:
    out = {"notported": str(e), "build_failed": isinstance(e, C.BuildFailed)}
except ValueError as e:
    out = {"bad": str(e)}
print(json.dumps(out))
"""

NODE_SNIPPET = """
const C = await import(%r);
const q = JSON.parse(process.argv[1]);
if (q.swap_home) {
  for (const k of Object.keys(process.env))
    if (!["PATH", "SEAMUX_BIN", "FAKE_CARGO_LOG", "FAKE_CARGO_FAIL"].includes(k)) delete process.env[k];
  process.env.HOME = q.swap_home;
}
let out;
try {
  let a = null;
  for (let i = 0; i < (q.times || 1); i++) a = q.argv ? C.argv(...q.argv) : null;
  out = { argv: a, env: ("base" in q) ? C.env(q.base) : null };
} catch (e) {
  out = e instanceof C.NotPorted ? { notported: e.message, build_failed: e instanceof C.BuildFailed } : { bad: e.message };
}
console.log(JSON.stringify(out));
"""


def ask(lang, q, env, where=HERE):
    """Ask one twin in `where` a question; return its answer."""
    if lang == "python":
        cmd = [sys.executable, "-c", PY_SNIPPET % where, json.dumps(q)]
    else:
        cmd = [NODE, "--input-type=module", "-e", NODE_SNIPPET % os.path.join(where, "crew_impl.mjs"), json.dumps(q)]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"crash": r.stderr[-300:]}


def same(name, q, env, want, where=HERE, before=None):
    """Both implementations answer `want` (a predicate on the answer); `before`
    runs ahead of each one, to reset what the case starts from."""
    answers = {}
    for lang in ("python", "node"):
        if before:
            before()
        answers[lang] = ask(lang, q, env, where)
    pa, na = answers["python"], answers["node"]
    check(f"{name} (python)", want(pa), json.dumps(pa))
    check(f"{name} (node)", want(na), json.dumps(na))
    return pa


print("crew_impl: argv")
e = base_env()
same("a registered tool runs seamux", {"argv": ["crew-color"]}, e,
     lambda a: a.get("argv") == [STUB, "crew-color"])
same("an unregistered tool is refused, by name", {"argv": ["crew-sync"]}, e,
     lambda a: "crew-sync" in a.get("notported", ""))
e = base_env(SEAMUX_BIN=os.path.join(T, "missing"))
same("a seamux that is not there registers nothing, so it is refused", {"argv": ["crew-color"]}, e,
     lambda a: "crew-color" in a.get("notported", ""))

print("crew_impl: env")
e = base_env()
same("CLI transport and CREW_HOME at this checkout", {"base": {"CREW_CMUX": "/f/fakecmux.py"}}, e,
     lambda a: a["env"] == {"CREW_CMUX": "/f/fakecmux.py", "CREW_CMUX_TRANSPORT": "cli",
                            "CREW_HOME": os.path.join(REPO, "crew")})
same("a probe's own CREW_HOME is kept", {"base": {"CREW_HOME": "/elsewhere"}}, e,
     lambda a: a["env"]["CREW_HOME"] == "/elsewhere")

print("crew_impl: finding seamux")
pa = subprocess.run([sys.executable, PY, "argv", "crew-color"], env=base_env(), capture_output=True, text=True)
check("the CLI form prints the argv as JSON", json.loads(pa.stdout or "null") == [STUB, "crew-color"], pa.stdout + pa.stderr)
pa = subprocess.run([sys.executable, PY, "argv", "crew-sync"], env=base_env(), capture_output=True, text=True)
check("the CLI form exits 3 on a refusal", pa.returncode == 3, pa.stderr)

# --- building seamux --------------------------------------------------------
# crew_impl in a throwaway repo, so its REPO is that tree and a build writes
# there. The stub cargo logs each call (cwd, HOME, CARGO_HOME), then writes the
# stub seamux where cargo would, or fails like a compile error.
FAKE = os.path.join(T, "repo")
FAKE_TOOLS = os.path.join(FAKE, "crew", "tools")
os.makedirs(FAKE_TOOLS)
for f in (PY, MJS):
    shutil.copy(f, FAKE_TOOLS)
FAKE_BIN = os.path.join(FAKE, "app", "target", "debug", "seamux")
CARGO_DIR = os.path.join(T, "cargo-bin")
os.makedirs(CARGO_DIR)
with open(os.path.join(CARGO_DIR, "cargo"), "w") as fh:
    fh.write("""#!/bin/sh
printf '%s|%s|%s|%s\\n' "$PWD" "$HOME" "$CARGO_HOME" "$*" >> "$FAKE_CARGO_LOG"
if [ -n "$FAKE_CARGO_FAIL" ]; then
  echo 'error[E0308]: mismatched types' >&2; exit 101
fi
t="${CARGO_TARGET_DIR:-app/target}/debug"
mkdir -p "$t" && cp STUB "$t/seamux" && chmod 755 "$t/seamux"
""".replace("STUB", STUB))
os.chmod(os.path.join(CARGO_DIR, "cargo"), 0o755)
LOG = os.path.join(T, "cargo.log")
SYS_PATH = "/usr/bin:/bin"
REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir


def build_env(**kw):
    e = base_env(SEAMUX_BIN=None, CARGO_HOME=None, RUSTUP_HOME=None,
                 PATH=CARGO_DIR + os.pathsep + SYS_PATH, FAKE_CARGO_LOG=LOG, FAKE_CARGO_FAIL=None)
    e.update({k: v for k, v in kw.items() if v is not None})
    for k, v in kw.items():
        if v is None:
            e.pop(k, None)
    return e


def calls():
    try:
        return [l.split("|") for l in open(LOG).read().splitlines()]
    except OSError:
        return []


def fresh(binary=False):
    """No cargo calls logged, and the fake build there or not."""
    def go():
        for f in (LOG, FAKE_BIN):
            if os.path.exists(f):
                os.remove(f)
        if binary:
            os.makedirs(os.path.dirname(FAKE_BIN), exist_ok=True)
            shutil.copy(STUB, FAKE_BIN)
    return go


def built_once(a):
    c = calls()
    return a.get("argv") == [FAKE_BIN, "crew-color"] and len(c) == 1 and c[0][0] == os.path.realpath(FAKE) \
        and "-p seamux-cli" in c[0][3]


print("crew_impl: building seamux")
same("no SEAMUX_BIN and no binary: cargo builds it, and the build runs", {"argv": ["crew-color"]},
     build_env(), built_once, where=FAKE_TOOLS, before=fresh())
same("a binary already there is built again, so a stale one is never tested", {"argv": ["crew-color"]},
     build_env(), built_once, where=FAKE_TOOLS, before=fresh(binary=True))
same("one build per process, however many tools it asks for", {"argv": ["crew-color"], "times": 3},
     build_env(), built_once, where=FAKE_TOOLS, before=fresh())
same("a failed build is refused with cargo's own words", {"argv": ["crew-color"]},
     build_env(FAKE_CARGO_FAIL="1"),
     lambda a: a.get("build_failed") and "E0308" in a.get("notported", "") and "exit 101" in a["notported"],
     where=FAKE_TOOLS, before=fresh())
if shutil.which("cargo", path=SYS_PATH):
    print("  skip no cargo at all (%s has one)" % SYS_PATH)
else:
    same("no cargo is refused, naming SEAMUX_BIN", {"argv": ["crew-color"]}, build_env(PATH=SYS_PATH),
         lambda a: a.get("build_failed") and "SEAMUX_BIN" in a.get("notported", ""),
         where=FAKE_TOOLS, before=fresh())
same("SEAMUX_BIN set: cargo never runs", {"argv": ["crew-color"]}, build_env(SEAMUX_BIN=STUB),
     lambda a: a.get("argv") == [STUB, "crew-color"] and not calls(), where=FAKE_TOOLS, before=fresh())
throwaway = os.path.join(T, "throwaway-home")
same("a probe that swaps in a throwaway HOME still builds with the real one",
     {"argv": ["crew-color"], "swap_home": throwaway}, build_env(),
     lambda a: built_once(a) and calls()[0][1] == os.environ.get("HOME", "")
     and calls()[0][2] == os.path.join(REAL_HOME, ".cargo"),
     where=FAKE_TOOLS, before=fresh())
OTHER = os.path.join(T, "other-target")
same("CARGO_TARGET_DIR moves the build, and the binary is found there", {"argv": ["crew-color"]},
     build_env(CARGO_TARGET_DIR=OTHER),
     lambda a: a.get("argv") == [os.path.join(OTHER, "debug", "seamux"), "crew-color"] and len(calls()) == 1,
     where=FAKE_TOOLS, before=fresh())
# A seamux on PATH is the installed app, not this branch: never picked.
same("a seamux on PATH is never picked", {"argv": ["crew-color"]},
     build_env(PATH=os.pathsep.join([T, CARGO_DIR, SYS_PATH])), built_once, where=FAKE_TOOLS, before=fresh())

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
