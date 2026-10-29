#!/usr/bin/env python3
"""Refuse to ship an internal identifier in the public tree.

Why this exists at the repo level. The export scrubber that built the original
bundle (crew-export/export_bundle.py) already had a FORBIDDEN verify pass, and
it worked -- but it only ever ran on the bundle it generated. The repo was
seeded from the live install by a different path, so five internal repo names,
a product name and two CI hosts rode in with the 0.1.0 commit and sat in a
public tree for two days. A check that lives beside the thing being exported
cannot protect a tree that is no longer produced by that export.

This file is covered by its own check -- see the note on the patterns below.

So: tracked files only, every push, fails closed. Patterns are specific rather
than clever -- a false positive here costs a minute, a false negative costs a
force-push.
"""
import getpass
import re
import socket
import subprocess
import sys

# Each entry is (regex, what it is). Keep them anchored to the actual
# identifier: a broad pattern like `atlassian\.net` would flag install.sh's
# `yourco.atlassian.net`, which is the placeholder we *want* people to see.
# Every pattern hides one character in a class -- `lending[h]ome` matches
# the real string but is not itself that string. Without this, the file could
# not be scanned by its own check, and worse: a `git filter-repo --replace-text`
# pass over the history would rewrite these patterns into the very placeholders
# they are meant to permit, leaving a checker that rejects the clean tree. The
# brackets cost one character of legibility and buy both.
FORBIDDEN = [
    (r"lending[h]ome",               "company repo/org/database name"),
    (r"\bkia[v]i\b",                 "company name"),
    (r"ricky[._-]?k[o]termanski",    "the author's username"),
    (r"\bA[O]-\d",                    "internal Jira key"),
    (r"\bDAT[A]-\d",                  "internal Jira key"),
    (r"\bBO[X]-\d",                   "internal Jira key"),
    (r"\bre[k]/",                     "the author's branch prefix (use dev/)"),
    (r"\be[D]SCR\b",                 "internal product name"),
    (r"gamma[-]infrastructure",      "internal repo name"),
    (r"snowflake[-]schemachange",    "internal repo name"),
    (r"lh[-]data-workflow",          "internal repo name"),
    (r"rik[i]pedia",                 "internal repo name"),
]

# Home paths, in every form a real one leaks in: macOS and Linux homes, a
# Windows profile, and the dash-joined form Claude Code names a project's
# directory with (also the root of its scratch dirs under /private/tmp). Each
# names its user in the `name` group, and a name in PLACEHOLDERS passes: docs
# and tests are full of /home/demo and its kin, which are the point.
HOME_FORMS = [
    (r"/Users/(?P<name>[A-Za-z0-9_][\w.-]*)",            "an absolute home path (use ~ or __HOME__)"),
    (r"/home/(?P<name>[A-Za-z0-9_][\w.-]*)",             "an absolute home path (use ~ or __HOME__)"),
    (r"\b[A-Za-z]:[\\/]+Users[\\/]+(?P<name>[\w.-]+)", "a Windows profile path (use %USERPROFILE%)"),
    (r"-(?:Users|home)-(?P<name>[A-Za-z0-9_]+)-",       "a Claude projects-dir path, which embeds a home"),
    (r"\b(?P<name>[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*?)-(?:mbp|mba|macbook[\w-]*|imac|mac-?mini)\.local\b",
                                                        "a machine's .local hostname"),
]

# Names that stand for "some user" rather than being one. Lowercased.
PLACEHOLDERS = {
    "alice", "bob", "carol", "dave", "eve", "mallory", "you", "your", "yourname", "your-name",
    "me", "demo", "user", "username", "name", "someone", "somebody", "dev", "agent", "test",
    "tester", "example", "x", "t", "john", "jane", "jdoe", "shared", "guest", "runner",
    "__home__", "home", "foo", "bar", "nobody",
}

# Account names that say nothing about who ran the check (CI runners, root).
SYSTEM_USERS = {"runner", "root", "ubuntu", "vsts", "ec2-user", "admin", "user", "nobody", "github"}


def _sep_pattern(name):
    """`first.last` -> a pattern for first.last, first-last, first_last and firstlast."""
    parts = [re.escape(p) for p in re.split(r"[._\- ]+", name) if p]
    return r"\b" + r"[._\- ]?".join(parts) + r"\b"


def env_patterns(user=None, host=None):
    """Patterns for this machine's own identity: the account name in its
    separator variants and the machine's .local hostname. Built at run time so
    the real values never appear in this file."""
    out = []
    if user is None:
        try:
            user = getpass.getuser()
        except Exception:
            user = ""
    u = (user or "").strip()
    if len(u) >= 3 and u.lower() not in SYSTEM_USERS | PLACEHOLDERS:
        out.append((_sep_pattern(u), "this machine's username"))
    if host is None:
        host = socket.gethostname()
    label = (host or "").split(".")[0]
    if len(label) >= 3 and label.lower() not in {"localhost"}:
        out.append((r"\b" + re.escape(label) + r"(?:\.[\w-]+)*\.local\b", "this machine's .local hostname"))
    return out


def build_patterns(user=None, host=None):
    pats = [(re.compile(p, re.IGNORECASE), why, False) for p, why in FORBIDDEN]
    pats += [(re.compile(p, re.IGNORECASE), why, False) for p, why in env_patterns(user, host)]
    pats += [(re.compile(p, re.IGNORECASE), why, True) for p, why in HOME_FORMS]
    return pats


def scan_line(line, pats):
    """Every (match, why) in one line; a home form whose user is a placeholder passes."""
    hits = []
    for pat, why, placeholder_ok in pats:
        for m in pat.finditer(line):
            if placeholder_ok and m.group("name").lower().rstrip(".-") in PLACEHOLDERS:
                continue
            hits.append((m.group(0), why))
            break
    return hits


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout
    return [f for f in out.decode("utf-8").split("\0") if f]


def is_text(path):
    try:
        with open(path, "rb") as fh:
            if b"\0" in fh.read(8192):
                return False
        with open(path, encoding="utf-8") as fh:
            fh.read()
        return True
    except (UnicodeDecodeError, OSError):
        return False


def main():
    pats = build_patterns()
    hits = []
    scanned = 0
    for path in tracked_files():
        if not is_text(path):
            continue
        scanned += 1
        with open(path, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                for found, why in scan_line(line, pats):
                    hits.append((path, n, found, why))

    if hits:
        print("scrub check FAILED — %d internal identifier(s) in tracked files:\n" % len(hits))
        for path, n, found, why in hits:
            print("  %s:%d  %r  (%s)" % (path, n, found, why))
        print("\nGenericize them, keeping the surrounding reasoning intact.")
        return 1

    print("scrub check: %d text files, no internal identifiers" % scanned)
    return 0


if __name__ == "__main__":
    sys.exit(main())
