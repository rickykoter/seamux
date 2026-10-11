#!/usr/bin/env python3
"""Probe tools/skill_lint.py: one fixture plugin per rule in a throwaway root,
plus a clean one that must produce nothing."""
import io
import os
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skill_lint as sl  # noqa: E402

FAILS = []
GOOD_FM = "---\nname: good-skill\ndescription: Plans a change carefully. Use when the user asks to plan.\n---\n"


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f" -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def plugin(root, name, skill, refs=None):
    d = os.path.join(root, name)
    os.makedirs(os.path.join(d, "references"), exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w") as fh:
        fh.write(skill)
    for rname, rtext in (refs or {}).items():
        with open(os.path.join(d, "references", rname), "w") as fh:
            fh.write(rtext)


def lint(root, name):
    return sl.lint_plugin(root, name)


def rules(findings):
    return sorted({f.split(": ")[1] for f in findings})


TOC = "# Spec\n\n## Contents\n- [Shape](#shape)\n\n" + "\n".join(f"line {i}" for i in range(120)) + "\n"

with tempfile.TemporaryDirectory() as root:
    plugin(root, "clean", GOOD_FM + "# Good\n\nSee [the spec](references/spec.md) and `references/gate.md`.\n",
           {"spec.md": TOC, "gate.md": "# Gate\n\nShort.\n"})
    f = lint(root, "clean")
    check("a clean skill has no findings", f == [], "\n".join(f))

    cases = {
        "name": ("---\nname: Claude_Helper\ndescription: Does a thing.\n---\nbody\n", {}),
        "description": ("---\nname: x\ndescription: You can use this to <b>plan</b>.\n---\nbody\n", {}),
        "listing": ("---\nname: x\ndescription: " + "d" * 1000 + "\nwhen_to_use: " + "w" * 600 + "\n---\nbody\n", {}),
        "length": (GOOD_FM + "\n".join("l" for _ in range(501)) + "\n", {}),
        "size": (GOOD_FM + ("word " * 4100) + "\n", {}),
        "link": (GOOD_FM + "See [missing](references/nope.md).\n", {}),
        "orphan": (GOOD_FM + "No links.\n", {"lonely.md": "# Lonely\n"}),
        "depth": (GOOD_FM + "See [a](references/a.md) and [b](references/b.md).\n",
                  {"a.md": "# A\n\nThen read [b](b.md).\n", "b.md": "# B\n"}),
        "contents": (GOOD_FM + "See [long](references/long.md).\n",
                     {"long.md": "# Long\n" + "\n".join(f"line {i}" for i in range(120)) + "\n"}),
    }
    for rule, (skill, refs) in cases.items():
        plugin(root, rule, skill, refs)
        got = rules(lint(root, rule))
        check(f"{rule} rule fires alone", got == [rule], f"got {got}")

    plugin(root, "fenced", GOOD_FM + "Example:\n\n```js\nhandlers[0](event)\n```\n")
    check("link-like code inside a fence is not a link", lint(root, "fenced") == [], str(lint(root, "fenced")))

    plugin(root, "nofm", "# No frontmatter\n")
    check("a missing frontmatter block is reported", rules(lint(root, "nofm")) == ["frontmatter"])

    plugin(root, "folded", "---\nname: folded\ndescription: >\n  Plans a change\n  carefully.\n---\nbody\n")
    check("a folded description is read", lint(root, "folded") == [])

    f = lint(root, "length")
    check("a finding leads with path:line", f and f[0].startswith("length/SKILL.md:"), str(f))

    os.environ["SKILL_LINT_ROOT"] = root
    out = io.StringIO()
    with redirect_stdout(out), redirect_stderr(io.StringIO()):
        code_clean = sl.main(["clean"])
        code_bad = sl.main(["clean", "depth"])
        code_missing = sl.main(["does-not-exist"])
    check("exit 0 on a clean skill", code_clean == 0)
    check("exit 1 on any finding", code_bad == 1)
    check("exit 2 on a plugin with no SKILL.md", code_missing == 2)
    check("no arguments finds every plugin with a root SKILL.md",
          "clean" in sl.plugins_with_skill(root) and "depth" in sl.plugins_with_skill(root))

print(f"\n{'all good' if not FAILS else f'{len(FAILS)} failed'}")
sys.exit(1 if FAILS else 0)
