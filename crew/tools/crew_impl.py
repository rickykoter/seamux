#!/usr/bin/env python3
"""crew_impl — which implementation a probe runs: today's Python or `seamux`.

    CREW_IMPL unset        every tool runs as the Python it is today
    CREW_IMPL=rust         a tool runs as `seamux <tool>` when seamux registers
                           it, and as the Python otherwise, so each port can run
                           every shared probe as soon as its own tools exist
    CREW_IMPL=rust-strict  as rust, but an unregistered tool raises NotPorted:
                           the cutover's proof that nothing is left on Python

In a probe:

    import crew_impl
    argv = crew_impl.argv("crew-sync", CREW_SYNC_PATH)            # shebang script
    argv = crew_impl.argv("typesafe", TYPESAFE_PY, sys.executable)  # run under python
    subprocess.run(argv, env=crew_impl.env(env), ...)

env() adds what the Rust needs to stand where the Python stood: under rust it
sets CREW_CMUX_TRANSPORT=cli, so crates/cmux sends every call through the
probe's CREW_CMUX (fakecmux), and CREW_HOME to this checkout's crew/ unless
the probe set one.

seamux is SEAMUX_BIN, else app/target/debug/seamux in this checkout, else
`seamux` on PATH. Build it first: cargo build --manifest-path app/Cargo.toml -p seamux-cli

From another language: crew_impl.py argv <tool> <path> [interp]  prints the argv
as JSON (crew_impl.mjs is the node twin, and needs no python).
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CREW = os.path.join(REPO, "crew")
MODES = ("", "rust", "rust-strict")


class NotPorted(RuntimeError):
    """CREW_IMPL=rust-strict and seamux does not register the tool."""


def mode():
    m = os.environ.get("CREW_IMPL", "")
    if m not in MODES:
        raise ValueError("CREW_IMPL must be unset, rust or rust-strict, not %r" % m)
    return m


def seamux_bin():
    env = os.environ.get("SEAMUX_BIN")
    if env:
        return env
    built = os.path.join(REPO, "app", "target", "debug", "seamux")
    if os.access(built, os.X_OK):
        return built
    return shutil.which("seamux")


_registered = {}


def registered():
    """The tool names `seamux --tools` lists; empty when there is no seamux."""
    b = seamux_bin()
    if not b:
        return frozenset()
    if b not in _registered:
        try:
            out = subprocess.run([b, "--tools"], capture_output=True, text=True,
                                 timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            # Missing, not executable, or hung past the timeout: no tools, so
            # rust falls back to the Python and rust-strict says what is missing.
            out = ""
        _registered[b] = frozenset(l.strip() for l in out.splitlines() if l.strip())
    return _registered[b]


def argv(tool, path, interp=None):
    """The argv that runs `tool`: [seamux, tool] or the Python's own argv."""
    m = mode()
    python = ([interp] if interp else []) + [path]
    if not m:
        return python
    if tool in registered():
        return [seamux_bin(), tool]
    if m == "rust-strict":
        raise NotPorted("CREW_IMPL=rust-strict: seamux does not register %r (seamux: %s)"
                        % (tool, seamux_bin() or "not found"))
    return python


def is_rust(tool):
    """True when argv(tool, ...) would run seamux."""
    return bool(mode()) and tool in registered()


def env(base=None):
    """A copy of base (default os.environ) with what the Rust needs under CREW_IMPL."""
    e = dict(os.environ if base is None else base)
    if mode():
        e["CREW_CMUX_TRANSPORT"] = "cli"
        e.setdefault("CREW_HOME", CREW)
    return e


def main(args):
    if len(args) >= 3 and args[0] == "argv":
        try:
            print(json.dumps(argv(args[1], args[2], args[3] if len(args) > 3 else None)))
        except NotPorted as e:
            print(str(e), file=sys.stderr)
            return 3
        return 0
    if args[:1] == ["tools"]:
        print("\n".join(sorted(registered())))
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
