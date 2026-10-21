#!/usr/bin/env python3
"""crew_impl_probe — the CREW_IMPL helper, in Python and its node twin.

Each case runs both implementations in a fresh process against a stub seamux
that registers crew-color and triage, and checks they give the same answer:
which argv a tool gets in each mode, the fallback and the strict refusal, the
env the Rust needs, and how seamux is found. No cmux, no cargo needed; when a
built app/target/debug/seamux exists it is checked too.

    python3 crew/tools/crew_impl_probe.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PY = os.path.join(HERE, "crew_impl.py")
MJS = os.path.join(HERE, "crew_impl.mjs")
BUILT = os.path.join(REPO, "app", "target", "debug", "seamux")
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


T = tempfile.mkdtemp(prefix="crew-impl-probe-")
STUB = os.path.join(T, "seamux")
with open(STUB, "w") as fh:
    fh.write('#!/bin/sh\n[ "$1" = --tools ] && printf "crew-color\\ntriage\\n"\n')
os.chmod(STUB, 0o755)


def base_env(**kw):
    e = {k: v for k, v in os.environ.items() if k not in ("CREW_IMPL", "SEAMUX_BIN", "CREW_HOME", "CREW_CMUX_TRANSPORT")}
    e["SEAMUX_BIN"] = STUB
    e.update({k: v for k, v in kw.items() if v is not None})
    for k, v in kw.items():
        if v is None:
            e.pop(k, None)
    return e


PY_SNIPPET = """
import json, sys
sys.path.insert(0, %r)
import crew_impl as C
q = json.loads(sys.argv[1])
try:
    out = {"argv": C.argv(*q["argv"]) if q.get("argv") else None, "env": C.env(q.get("base", {})) if "base" in q else None}
except C.NotPorted as e:
    out = {"notported": str(e)}
except ValueError as e:
    out = {"bad": str(e)}
print(json.dumps(out))
""" % HERE

NODE_SNIPPET = """
const C = await import(%r);
const q = JSON.parse(process.argv[1]);
let out;
try {
  out = { argv: q.argv ? C.argv(...q.argv) : null, env: ("base" in q) ? C.env(q.base) : null };
} catch (e) {
  out = e instanceof C.NotPorted ? { notported: e.message } : { bad: e.message };
}
console.log(JSON.stringify(out));
""" % MJS


def both(q, env):
    """Ask the Python and the node twin the same question; return both answers."""
    p = subprocess.run([sys.executable, "-c", PY_SNIPPET, json.dumps(q)], env=env,
                       capture_output=True, text=True)
    n = subprocess.run(["node", "--input-type=module", "-e", NODE_SNIPPET, json.dumps(q)], env=env,
                       capture_output=True, text=True)
    try:
        pa = json.loads(p.stdout)
    except ValueError:
        pa = {"crash": p.stderr[-300:]}
    try:
        na = json.loads(n.stdout)
    except ValueError:
        na = {"crash": n.stderr[-300:]}
    return pa, na


def same(name, q, env, want):
    """Both implementations answer `want` (a predicate on the answer)."""
    pa, na = both(q, env)
    check(f"{name} (python)", want(pa), json.dumps(pa))
    check(f"{name} (node)", want(na), json.dumps(na))
    return pa


print("crew_impl: modes")
e = base_env()
same("unset: a registered tool still runs the Python", {"argv": ["crew-color", "/p/crew-color"]}, e,
     lambda a: a.get("argv") == ["/p/crew-color"])
same("unset: an interpreter is kept in front", {"argv": ["typesafe", "/p/typesafe.py", "python3"]}, e,
     lambda a: a.get("argv") == ["python3", "/p/typesafe.py"])

e = base_env(CREW_IMPL="rust")
same("rust: a registered tool runs seamux", {"argv": ["crew-color", "/p/crew-color"]}, e,
     lambda a: a.get("argv") == [STUB, "crew-color"])
same("rust: an unregistered tool falls back to the Python", {"argv": ["crew-sync", "/p/crew-sync", "python3"]}, e,
     lambda a: a.get("argv") == ["python3", "/p/crew-sync"])

e = base_env(CREW_IMPL="rust-strict")
same("rust-strict: an unregistered tool is refused", {"argv": ["crew-sync", "/p/crew-sync"]}, e,
     lambda a: "crew-sync" in a.get("notported", ""))
same("rust-strict: a registered tool runs seamux", {"argv": ["triage", "/p/triage.py"]}, e,
     lambda a: a.get("argv") == [STUB, "triage"])

e = base_env(CREW_IMPL="python")
same("an unknown mode is an error, not a guess", {"argv": ["triage", "/p/triage.py"]}, e,
     lambda a: "rust-strict" in a.get("bad", ""))

e = base_env(CREW_IMPL="rust", SEAMUX_BIN=os.path.join(T, "missing"))
same("rust with no seamux at all falls back", {"argv": ["crew-color", "/p/crew-color"]}, e,
     lambda a: a.get("argv") == ["/p/crew-color"])

print("crew_impl: env")
e = base_env(CREW_IMPL="rust")
same("rust: CLI transport and CREW_HOME at this checkout", {"base": {"CREW_CMUX": "/f/fakecmux.py"}}, e,
     lambda a: a["env"] == {"CREW_CMUX": "/f/fakecmux.py", "CREW_CMUX_TRANSPORT": "cli",
                            "CREW_HOME": os.path.join(REPO, "crew")})
same("rust: a probe's own CREW_HOME is kept", {"base": {"CREW_HOME": "/elsewhere"}}, e,
     lambda a: a["env"]["CREW_HOME"] == "/elsewhere")
e = base_env()
same("unset: env is a plain copy", {"base": {"A": "1"}}, e, lambda a: a["env"] == {"A": "1"})

print("crew_impl: finding seamux")
pa = subprocess.run([sys.executable, PY, "argv", "crew-color", "/p/crew-color"],
                    env=base_env(CREW_IMPL="rust"), capture_output=True, text=True)
check("the CLI form prints the argv as JSON", json.loads(pa.stdout or "null") == [STUB, "crew-color"], pa.stdout + pa.stderr)
pa = subprocess.run([sys.executable, PY, "argv", "crew-sync", "/p/crew-sync"],
                    env=base_env(CREW_IMPL="rust-strict"), capture_output=True, text=True)
check("the CLI form exits 3 on a strict refusal", pa.returncode == 3, pa.stderr)
if os.access(BUILT, os.X_OK):
    e = base_env(CREW_IMPL="rust", SEAMUX_BIN=None)
    same("without SEAMUX_BIN the checkout's build wins", {"argv": ["cmux", "/p/none"]}, e,
         lambda a: a.get("argv") == [BUILT, "cmux"])
else:
    print("  skip the checkout's own build (cargo build --manifest-path app/Cargo.toml -p seamux-cli)")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
