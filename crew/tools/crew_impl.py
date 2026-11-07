#!/usr/bin/env python3
"""crew_impl — the one place a probe turns a crew tool into a command:
this branch's `seamux <tool>`.

In a probe:

    import crew_impl
    argv = crew_impl.argv("crew-sync")                 # [seamux, "crew-sync"]
    subprocess.run(argv + args, env=crew_impl.env(env), ...)

argv() raises NotPorted when seamux does not register the tool, and when no
seamux is built, so a probe never passes against something it did not mean
to test. env() adds what the tools need to stand in a probe's world:
CREW_CMUX_TRANSPORT=cli, so crates/cmux sends every call through the probe's
CREW_CMUX (fakecmux), and CREW_HOME to this checkout's crew/ unless the probe
set one.

seamux is SEAMUX_BIN, else app/target/debug/seamux in this checkout. Never
`seamux` on PATH: that is the installed app, and a probe that fell back to it
would test another branch's code. Build it first:
cargo build --manifest-path app/Cargo.toml -p seamux-cli

From another language: crew_impl.py argv <tool>  prints the argv as JSON
(crew_impl.mjs is the node twin, and needs no python).
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CREW = os.path.join(REPO, "crew")
BUILD = "cargo build --manifest-path app/Cargo.toml -p seamux-cli"


class NotPorted(RuntimeError):
    """seamux is missing, or does not register the tool."""


def seamux_bin():
    env = os.environ.get("SEAMUX_BIN")
    if env:
        return env
    built = os.path.join(REPO, "app", "target", "debug", "seamux")
    if os.access(built, os.X_OK):
        return built
    return None


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
            # argv says what is missing.
            out = ""
        _registered[b] = frozenset(l.strip() for l in out.splitlines() if l.strip())
    return _registered[b]


def argv(tool):
    """[seamux, tool], or NotPorted naming what is missing."""
    b = seamux_bin()
    if not b:
        raise NotPorted("no seamux: set SEAMUX_BIN or build app/target/debug/seamux (%s)" % BUILD)
    if tool not in registered():
        raise NotPorted("seamux (%s) does not register %r" % (b, tool))
    return [b, tool]


def has(tool):
    """True when argv(tool) would run."""
    return tool in registered()


def env(base=None):
    """A copy of base (default os.environ) with what the tools need in a probe."""
    e = dict(os.environ if base is None else base)
    e["CREW_CMUX_TRANSPORT"] = "cli"
    e.setdefault("CREW_HOME", CREW)
    return e


def main(args):
    if len(args) == 2 and args[0] == "argv":
        try:
            print(json.dumps(argv(args[1])))
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
