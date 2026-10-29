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
    (r"(?<![A-Za-z]:)/Users/(?P<name>[A-Za-z0-9_][\w.-]*)",            "an absolute home path (use ~ or __HOME__)"),
    (r"/home/(?P<name>[A-Za-z0-9_][\w.-]*)",             "an absolute home path (use ~ or __HOME__)"),
    (r"\b[A-Za-z]:[\\/]+Users[\\/]+(?P<name>(?:Default|All) Users?|[\w.-]+)", "a Windows profile path (use %USERPROFILE%)"),
    # Only as a path segment: a leading dash right after a slash, a quote or
    # the start of a line, then the name and at least one more segment.
    (r"(?:^|(?<=[/\\\s\"'`(=:]))-(?:Users|home)-(?P<name>[A-Za-z0-9_]+)-(?P<next>[\w.]+)",
                                                        "a Claude projects-dir path, which embeds a home"),
    (r"\b(?P<name>[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*?)-(?:mbp|mba|macbook[\w-]*|imac|mac-?mini)\.local\b",
                                                        "a machine's .local hostname"),
]

# The dash-joined projects-dir form cannot say where the user name ends
# (demo then smith may be the one user demo-smith), so a placeholder first
# segment passes only when the next one is a directory, not more of a name.
DIR_WORDS = {"code", "src", "projects", "project", "dev", "work", "documents", "desktop",
             "repos", "repo", "tmp", "git", "workspace", "workspaces", "downloads"}

# Names that stand for "some user" rather than being one. Lowercased.
PLACEHOLDERS = {
    "alice", "bob", "carol", "dave", "eve", "mallory", "you", "your", "yourname", "your-name",
    "me", "demo", "user", "username", "name", "someone", "somebody", "dev", "agent", "test",
    "tester", "example", "x", "t", "john", "jane", "jdoe", "shared", "guest", "runner",
    "__home__", "home", "foo", "bar", "nobody",
    # Windows' shared profiles, named the same on every machine.
    "public", "default", "default user", "all users", "administrator",
}

# Account names that say nothing about who ran the check, or are ordinary
# words a check would trip on in prose (CI runners, root, build boxes).
SYSTEM_USERS = {
    "runner", "root", "ubuntu", "vsts", "ec2-user", "admin", "administrator", "user", "users",
    "nobody", "github", "build", "builder", "buildkite", "jenkins", "deploy", "docker", "ci",
    "worker", "service", "default", "guest", "local", "staff", "developer", "travis", "circleci",
    "node", "vscode", "codespace", "app",
    "linuxbrew", "vagrant", "pi", "git", "www-data", "gitpod",
}


def distinctive(name):
    """A username worth hunting for: not a common word, and long enough or
    shaped (a separator, a digit) that it will not match ordinary prose."""
    n = name.lower()
    if n in SYSTEM_USERS or n in PLACEHOLDERS:
        return False
    return len(n) >= 5 or (len(n) >= 3 and bool(re.search(r"[._\-\d]", n)))


def _sep_pattern(name):
    """`first.last` -> first.last, first-last, first_last or firstlast, but only
    where a username sits in a path or a host: after /, \\, @, -Users- or
    -home-, or ahead of a .local hostname."""
    parts = [re.escape(p) for p in re.split(r"[._\- ]+", name) if p]
    core = r"[._\- ]?".join(parts)
    return (r"(?:(?:(?<=[/\\@])|(?<=-Users-)|(?<=-home-))" + core + r"(?![\w])"
            r"|\b" + core + r"(?=[\w-]*(?:\.[\w-]+)*\.local\b))")


# Hostname labels every machine of a kind shares: a model name, a role, a
# cloud runner's generated name. None of them says whose machine it is.
HOST_WORDS = {
    "localhost", "local", "home", "dev", "server", "laptop", "desktop", "workstation", "pc",
    "mac", "macbook", "macbookpro", "macbookair", "imac", "macmini", "macstudio", "macpro",
    "ubuntu", "debian", "fedora", "raspberrypi", "runner", "box", "vm", "host", "computer",
}
MODEL_SUFFIX = re.compile(r"[-_]?(?:macbook[-_]?(?:pro|air)?|imac|mac[-_]?(?:mini|studio|pro)|mbp|mba)(?:[-_]?\d+)?$", re.I)
GENERATED_HOST = re.compile(r"^(?:ip-\d|fv-az|runner-|ghost-|codespaces-|ec2-|localhost)", re.I)


def distinctive_host(label):
    """A hostname label worth hunting for. `jdoe-MacBook-Pro` is (it carries a
    name); `MacBookPro`, `laptop` and `ip-10-0-0-1` are not."""
    label = (label or "").strip()
    if len(label) < 3 or GENERATED_HOST.match(label) or label.lower() in HOST_WORDS:
        return False
    rest = MODEL_SUFFIX.sub("", label)
    if rest != label:
        rest = re.sub(r"(?i)s$", "", rest) if rest.lower().endswith("s") and len(rest) > 3 else rest
        return bool(rest) and distinctive(rest)
    return distinctive(label)


def machine_user(user=None):
    if user is None:
        try:
            user = getpass.getuser()
        except Exception:
            user = ""
    return (user or "").strip()


def env_patterns(user=None, host=None):
    """Patterns for this machine's own identity: the account name in its
    separator variants and the machine's .local hostname. Built at run time so
    the real values never appear in this file."""
    out = []
    u = machine_user(user)
    if distinctive(u):
        out.append((_sep_pattern(u), "this machine's username"))
    if host is None:
        host = socket.gethostname()
    label = (host or "").split(".")[0]
    if distinctive_host(label):
        out.append((r"\b" + re.escape(label) + r"(?:\.[\w-]+)*\.local\b", "this machine's .local hostname"))
    return out


def build_patterns(user=None, host=None):
    pats = [(re.compile(p, re.IGNORECASE), why, False) for p, why in FORBIDDEN]
    pats += [(re.compile(p, re.IGNORECASE), why, False) for p, why in env_patterns(user, host)]
    # A home form passes for a placeholder or a system account (/home/ubuntu,
    # /Users/runner), never for this machine's own name when it is distinctive.
    u = machine_user(user).lower()
    passing = frozenset((PLACEHOLDERS | SYSTEM_USERS) - ({u} if distinctive(u) else set()))
    pats += [(re.compile(p, re.IGNORECASE), why, passing) for p, why in HOME_FORMS]
    return pats


def scan_line(line, pats):
    """Every (match, why) in one line; a home form whose user is a placeholder
    or a system account passes."""
    hits = []
    for pat, why, passing in pats:
        for m in pat.finditer(line):
            if passing and m.group("name").lower().rstrip(".-") in passing:
                nxt = m.groupdict().get("next")
                if nxt is None or nxt.lower().rstrip(".") in DIR_WORDS:
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
