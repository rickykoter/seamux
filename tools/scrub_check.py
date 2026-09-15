#!/usr/bin/env python3
"""Refuse to ship an internal identifier in the public tree.

Why this exists at the repo level. The export scrubber that built the original
bundle (crew-export/export_bundle.py) already had a FORBIDDEN verify pass, and
it worked -- but it only ever ran on the bundle it generated. The repo was
seeded from the live install by a different path, so five internal repo names,
a product name and two CI hosts rode in with the 0.1.0 commit and sat in a
public tree for two days. A check that lives beside the thing being exported
cannot protect a tree that is no longer produced by that export.

So: tracked files only, every push, fails closed. Patterns are specific rather
than clever -- a false positive here costs a minute, a false negative costs a
force-push.
"""
import re
import subprocess
import sys

# Each entry is (regex, what it is). Keep them anchored to the actual
# identifier: a broad pattern like `atlassian\.net` would flag install.sh's
# `yourco.atlassian.net`, which is the placeholder we *want* people to see.
FORBIDDEN = [
    (r"lendinghome",                 "company repo/org/database name"),
    (r"\bkiavi\b",                   "company name"),
    (r"rickykotermanski",            "the author's username"),
    (r"/Users/[a-z]",                "an absolute home path (use ~ or __HOME__)"),
    (r"\bAO-\d",                     "internal Jira key"),
    (r"\bDATA-\d",                   "internal Jira key"),
    (r"\bBOX-\d",                    "internal Jira key"),
    (r"\brek/",                       "the author's branch prefix (use dev/)"),
    (r"\bthe-app\b",                   "internal product name"),
    (r"infrastructure",        "internal repo name"),
    (r"data-warehouse",      "internal repo name"),
    (r"data-pipelines",            "internal repo name"),
    (r"notes",                   "internal repo name"),
]

# This file necessarily contains every string it exists to forbid.
SELF = "tools/scrub_check.py"


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout
    return [f for f in out.decode("utf-8").split("\0") if f and f != SELF]


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
    pats = [(re.compile(p, re.IGNORECASE), why) for p, why in FORBIDDEN]
    hits = []
    scanned = 0
    for path in tracked_files():
        if not is_text(path):
            continue
        scanned += 1
        with open(path, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                for pat, why in pats:
                    m = pat.search(line)
                    if m:
                        hits.append((path, n, m.group(0), why))

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
