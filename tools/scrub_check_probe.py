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
    "a home path in quotes": 'cwd = "' + U + 'sam.rivera/x"',
    "a home path after =": "HOME=" + H + "srivera",
    "a home path after ~ and (": "(" + U + "srivera)",
    "a home path in a file:// URL": "file://" + U + "srivera/notes.md",
    "a hyphenated macOS home": U + "sam-rivera/code/x",
    "a Linux home": H + "srivera/code",
    "a Windows profile": W + "srivera\\AppData",
    "a Windows profile, forward slashes": "C:/" + "Users/srivera/x",
    "a Claude projects dir": "~/.claude/projects/-Us" + "ers-sam-rivera-code-seamux/memory",
    "a Claude scratch dir": "/private/tmp/claude-501/-Us" + "ers-sam-rivera-code-seamux/abc",
    "a projects dir whose name starts with a placeholder": "-Us" + "ers-demo-smith-code-x",
    "a projects dir, placeholder then a non-directory word": "~/.claude/projects/-ho" + "me-alice-jones-src",
    "an -mbp.local hostname": "ssh sam-rivera-" + "mbp.local",
    "the env username in a path": "/srv/jo" + ".example/code",
    "the env username, joined, after @": "mail @jo" + "example",
    "the env username, hyphenated, in a projects dir": "x-Users-jo" + "-example-code",
    "the env username ahead of .local": "jo" + "example-air.local",
    "the machine's hostname": "ping jo-mbp" + ".local",
    "the author's username": "ricky" + ".kotermanski",
}
for name, line in must_flag.items():
    check("flags " + name, sc.scan_line(line, pats), line)

# The machine's own distinctive name is never let through, even if it were
# a listed account; a system account as the machine user stays allowed.
check("the machine's own name in a home path flags", sc.scan_line(H + "jo.example/x", pats))
check("a system machine user keeps its home allowed",
      not sc.scan_line(H + "ubuntu/x", sc.build_patterns(user="ubuntu", host="localhost")))

must_pass = {
    "a placeholder macOS home": U + "alice/code/x",
    "__HOME__": U + "__HOME__/x",
    "a placeholder Linux home": H + "demo/code",
    "a placeholder with a space": H + "John Smith/plans",
    "an elided home": U + "\u2026/main-repo",
    "an angle-bracket home": U + "<name>/code",
    "a placeholder Windows profile": W + "you\\x",
    "the Public profile": W + "Public\\Documents",
    "the Default profile": W + "Default\\AppData",
    "the Default User profile": W + "Default User\\NTUSER.DAT",
    "the All Users profile": "C:/" + "Users/All Users/x",
    "the Administrator profile": W + "Administrator\\x",
    "a placeholder projects dir": "-Us" + "ers-you-code-proj",
    "a system account's Linux home": H + "ubuntu/app",
    "a container's node home": H + "node/.npm",
    "a devcontainer's vscode home": H + "vscode/.cache",
    "an EC2 home": H + "ec2-user/x",
    "linuxbrew's home": H + "linuxbrew/.linuxbrew/bin",
    "a Vagrant box's home": H + "vagrant/x",
    "a Raspberry Pi's home": H + "pi/x",
    "a git server's home": H + "git/repos",
    "www-data's home": H + "www-data/x",
    "a gitpod workspace home": H + "gitpod/.bashrc",
    "a CircleCI home": H + "circleci/project",
    "a Jenkins home": H + "jenkins/workspace",
    "a codespace home": H + "codespace/x",
    "a macOS runner's home": U + "runner/work",
    "root's home as /home/root": H + "root/x",
    "a placeholder projects dir under Documents": "/x/-Us" + "ers-demo-Documents-notes",
    "a placeholder projects dir under tmp": "-ho" + "me-alice-tmp-scratch",
    "a placeholder hostname": "your-name-" + "mbp.local",
    "the public GitHub handle": "github.com/rickykoter/seamux",
    "a plain users word": "for users of the app",
    "a lowercase API path": "GET /us" + "ers/list",
    "a URL path with /home/": "https://example.com/ho" + "me/settings",
    "a nested path segment": "/srv/data/ho" + "me/srivera",
    "a path after a dot": "x./ho" + "me/srivera",
    "the env username in prose": "jo" + ".example wrote this",
    "a -Users- word inside prose": "the-Us" + "ers-guide-text",
    "a -home- word inside prose": "a well-ho" + "me-grown-tool",
    "a projects-dir form with no further segment": "/-Us" + "ers-sam-",
}
for name, line in must_pass.items():
    hits = sc.scan_line(line, pats)
    check("passes " + name, not hits, repr(hits))

for host in ("MacBookPro", "MacBook-Pro", "laptop", "ip-10-0-0-1", "fv-az123-456", "localhost", "dev", "Mac-mini"):
    check(f"a generic hostname ({host}) adds no hostname pattern",
          not [w for _, w in sc.env_patterns(user="runner", host=host + ".local")], repr(sc.env_patterns(user="runner", host=host)))
for host in ("srivera-mbp", "sriveras-MacBook-Pro", "kestrel-7"):
    check(f"a distinctive hostname ({host}) adds a pattern",
          bool(sc.env_patterns(user="runner", host=host + ".local")))
for acct in ("runner", "build", "admin", "dev", "test", "user", "pat"):
    check(f"a common or short account ({acct}) adds no username pattern",
          not sc.env_patterns(user=acct, host="localhost"))
check("a short account with a separator still counts", bool(sc.env_patterns(user="j.d", host="localhost")))

print("\n%d failure(s)" % len(FAILS) if FAILS else "\nall scrub_check probes pass")
sys.exit(1 if FAILS else 0)
