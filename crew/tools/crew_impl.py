#!/usr/bin/env python3
"""crew_impl — the one place a probe turns a crew tool into a command:
this branch's `seamux <tool>`.

In a probe:

    import crew_impl
    argv = crew_impl.argv("crew-sync")                 # [seamux, "crew-sync"]
    subprocess.run(argv + args, env=crew_impl.env(env), ...)

argv() raises NotPorted when seamux does not register the tool, so a probe
never passes against something it did not mean to test. env() adds what the tools need to stand in a probe's world:
CREW_CMUX_TRANSPORT=cli, so crates/cmux sends every call through the probe's
CREW_CMUX (fakecmux), and CREW_HOME to this checkout's crew/ unless the probe
set one.

seamux is SEAMUX_BIN, else app/target/debug/seamux in this checkout, built
by the first seamux_bin() call in each process:
cargo build -q --manifest-path app/Cargo.toml -p seamux-cli
A build with nothing to do takes well under a second, and it means a probe
never tests a binary left over from an older tree. A failed build raises
BuildFailed with cargo's output. Set SEAMUX_BIN to skip the build. Never
`seamux` on PATH: that is the installed app, and a probe that fell back to it
would test another branch's code.

From another language: crew_impl.py argv <tool>  prints the argv as JSON
(crew_impl.mjs is the node twin, and needs no python).
"""
import json
import os
import pwd
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CREW = os.path.join(REPO, "crew")
BUILD = "cargo build -q --manifest-path app/Cargo.toml -p seamux-cli"
# The env at import. Some probes swap os.environ for a throwaway HOME before
# they first ask for seamux; cargo's rustup proxy would look for its toolchain
# there.
BUILD_ENV = dict(os.environ)


class NotPorted(RuntimeError):
    """seamux is missing, or does not register the tool."""


class BuildFailed(NotPorted):
    """cargo could not build this checkout's seamux."""


def _build_env():
    e = dict(BUILD_ENV)
    try:
        home = pwd.getpwuid(os.getuid()).pw_dir
    except KeyError:
        home = e.get("HOME", "")
    if home:
        e.setdefault("CARGO_HOME", os.path.join(home, ".cargo"))
        e.setdefault("RUSTUP_HOME", os.path.join(home, ".rustup"))
    return e


_built = []


def built_path():
    """Where cargo leaves seamux: CARGO_TARGET_DIR (from the repo root) or app/target."""
    target = BUILD_ENV.get("CARGO_TARGET_DIR") or os.path.join(REPO, "app", "target")
    return os.path.join(REPO, target, "debug", "seamux")


def build():
    """Build this checkout's seamux, once per process; BuildFailed if cargo cannot."""
    if _built:
        return _built[0]
    built = built_path()
    # A cold build, or one queued on cargo's lock behind a sibling probe, can
    # take a while; say so, since -q hides cargo's own progress.
    sys.stderr.write("crew_impl: %s\n" % BUILD)
    sys.stderr.flush()
    try:
        p = subprocess.run(BUILD.split(), cwd=REPO, env=_build_env(),
                           capture_output=True, text=True)
    except OSError as e:
        raise BuildFailed("cannot build seamux: %s (%s); put cargo on PATH or set SEAMUX_BIN"
                          % (e, BUILD))
    if p.returncode != 0:
        tail = "\n".join((p.stdout + p.stderr).strip().splitlines()[-30:])
        raise BuildFailed("seamux did not build (%s, exit %d):\n%s" % (BUILD, p.returncode, tail))
    if not os.access(built, os.X_OK):
        raise BuildFailed("%s exited 0 but left no %s" % (BUILD, built))
    _built.append(built)
    return built


def seamux_bin():
    """SEAMUX_BIN, else this checkout's seamux, built first."""
    env = os.environ.get("SEAMUX_BIN")
    if env:
        return env
    return build()


_registered = {}


def registered():
    """The tool names `seamux --tools` lists; empty when that seamux is not there."""
    b = seamux_bin()
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
        try:
            print("\n".join(sorted(registered())))
        except NotPorted as e:
            print(str(e), file=sys.stderr)
            return 3
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
