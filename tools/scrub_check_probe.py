#!/usr/bin/env python3
"""Probe tools/scrub_check.py: the forms it must flag and the placeholders it
must pass. Every leaking sample is assembled at run time ("/Us" + "ers/..."),
so this file passes the check it tests."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scrub_check as sc  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f" -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


U, H, W = "/Us" + "ers/", "/ho" + "me/", "C:\\" + "Users\\"
# A made-up identity, so the probe never depends on who runs it.
pats = sc.build_patterns(user="jo.example", host="jo-mbp" + ".local")

must_flag = {
    "a dotted macOS home": U + "sam.rivera/code/x",
    "a hyphenated macOS home": U + "sam-rivera/code/x",
    "a Linux home": H + "srivera/code",
    "a Windows profile": W + "srivera\\AppData",
    "a Windows profile, forward slashes": "C:/" + "Users/srivera/x",
    "a Claude projects dir": "~/.claude/projects/-Us" + "ers-sam-rivera-code-seamux/memory",
    "a Claude scratch dir": "/private/tmp/claude-501/-Us" + "ers-sam-rivera-code-seamux/abc",
    "an -mbp.local hostname": "ssh sam-rivera-" + "mbp.local",
    "the env username, dotted": "jo" + ".example wrote this",
    "the env username, joined": "jo" + "example wrote this",
    "the env username, hyphenated": "by jo" + "-example",
    "the machine's hostname": "ping jo-mbp" + ".local",
    "the author's username": "ricky" + ".kotermanski",
}
for name, line in must_flag.items():
    check("flags " + name, sc.scan_line(line, pats), line)

must_pass = {
    "a placeholder macOS home": U + "alice/code/x",
    "__HOME__": U + "__HOME__/x",
    "a placeholder Linux home": H + "demo/code",
    "a placeholder with a space": H + "John Smith/plans",
    "an elided home": U + "\u2026/main-repo",
    "an angle-bracket home": U + "<name>/code",
    "a placeholder Windows profile": W + "you\\x",
    "a placeholder projects dir": "-Us" + "ers-you-code-proj",
    "a placeholder hostname": "your-name-" + "mbp.local",
    "the public GitHub handle": "github.com/rickykoter/seamux",
    "a plain users word": "for users of the app",
}
for name, line in must_pass.items():
    hits = sc.scan_line(line, pats)
    check("passes " + name, not hits, repr(hits))

check("a CI runner's account adds no username pattern",
      not [w for _, w in sc.env_patterns(user="runner", host="localhost")])

print("\n%d failure(s)" % len(FAILS) if FAILS else "\nall scrub_check probes pass")
sys.exit(1 if FAILS else 0)
