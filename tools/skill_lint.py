#!/usr/bin/env python3
"""Lint every seamux skill against Anthropic's checkable authoring rules.

Why this exists. Each seamux skill plugin keeps its SKILL.md at the plugin
root (ADR 0004), and `claude plugin validate` checks only skills under a
skills/ directory -- so nothing checked these files. The rules below are the
ones Anthropic's guidance states precisely enough to test (October 2026):

  name            at most 64 chars, lowercase letters, digits and hyphens,
                  no "anthropic" or "claude"
  description     present, at most 1,024 chars, no XML tags, third person
                  (does not open "I " or "You ")
  listing         description + when_to_use at most 1,536 chars, the cap
                  Claude Code truncates the skill listing at
  length          body at most 500 lines
  size            body at most 20,000 chars -- about the 5,000 tokens Claude
                  Code keeps of an invoked skill after compaction, so the
                  whole skill survives one
  link            every relative link from SKILL.md resolves
  orphan          every file under references/ is linked from SKILL.md
  depth           no reference links another reference (one level deep)
  contents        a reference over 100 lines opens with a contents list

    python3 tools/skill_lint.py [plugin ...]    default: every plugin with a root SKILL.md

One line per finding, `path:line: rule: message`; exit 1 on any, 0 on none.
"""
import os
import re
import sys

NAME_MAX, DESC_MAX, LISTING_MAX = 64, 1024, 1536
BODY_LINES_MAX, BODY_CHARS_MAX = 500, 20000
REF_TOC_AFTER = 100
TOC_WINDOW = 25

LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
REF_MENTION = re.compile(r"(?<![\w/.-])(references/[\w.-]+\.md)")
XML_TAG = re.compile(r"<\s*/?\s*[A-Za-z][\w:-]*[^>]*>")


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def frontmatter(text):
    """({key: value}, {key: line}, body_start_line) for a simple YAML header;
    a value continued on indented lines (a folded scalar) is joined with spaces."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, {}, 0
    fields, where, key = {}, {}, None
    for i in range(1, len(lines)):
        line = lines[i]
        if line.strip() == "---":
            return fields, where, i + 1
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            key = m.group(1)
            val = m.group(2).strip()
            if val in (">", "|", ">-", "|-"):
                val = ""
            fields[key] = val.strip("\"'")
            where[key] = i + 1
        elif key and line.startswith((" ", "\t")):
            fields[key] = (fields[key] + " " + line.strip()).strip()
    return fields, where, 0


def local_target(target):
    """A link target that names a file in the plugin, or None."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith(("#", "/", "~")):
        return None
    return target.split("#", 1)[0] or None


def links_in(text):
    """(line_no, target) for markdown links and bare references/ mentions."""
    out = []
    for n, line in enumerate(text.split("\n"), 1):
        for m in LINK.finditer(line):
            t = local_target(m.group(1))
            if t:
                out.append((n, t))
        for m in REF_MENTION.finditer(line):
            out.append((n, m.group(1)))
    return out


def has_contents(lines):
    head = lines[:TOC_WINDOW]
    if any(re.match(r"^#{1,6}\s*(table of )?contents\b", l.strip(), re.I) for l in head):
        return True
    return sum(1 for l in head if re.match(r"^\s*[-*\d.]+\s*\[[^\]]+\]\(#", l)) >= 3


def lint_plugin(root, plugin):
    findings = []
    pdir = os.path.join(root, plugin)
    skill = os.path.join(pdir, "SKILL.md")
    rel = lambda p: os.path.relpath(p, root)

    def say(path, line, rule, msg):
        findings.append(f"{rel(path)}:{line}: {rule}: {msg}")

    with open(skill, encoding="utf-8") as fh:
        text = fh.read()
    fields, where, body_at = frontmatter(text)
    if not body_at:
        say(skill, 1, "frontmatter", "no --- frontmatter block")
        return findings

    name = fields.get("name", "")
    if not name:
        say(skill, 1, "name", "missing")
    else:
        if len(name) > NAME_MAX:
            say(skill, where["name"], "name", f"{len(name)} chars, over {NAME_MAX}")
        if not re.fullmatch(r"[a-z0-9-]+", name):
            say(skill, where["name"], "name", "only lowercase letters, digits and hyphens")
        if re.search(r"anthropic|claude", name):
            say(skill, where["name"], "name", "reserved word")

    desc = fields.get("description", "")
    if not desc:
        say(skill, 1, "description", "missing")
    else:
        dl = where["description"]
        if len(desc) > DESC_MAX:
            say(skill, dl, "description", f"{len(desc)} chars, over {DESC_MAX}")
        if XML_TAG.search(desc):
            say(skill, dl, "description", "contains an XML tag")
        if re.match(r"^(I|I'm|I'll|You|You're|You'll|We)\b", desc):
            say(skill, dl, "description", "write it in third person, not first or second")
        listing = len(desc) + len(fields.get("when_to_use", ""))
        if listing > LISTING_MAX:
            say(skill, dl, "listing", f"description + when_to_use is {listing} chars, over {LISTING_MAX}")

    body = "\n".join(text.split("\n")[body_at:])
    body_lines = body.rstrip("\n").count("\n") + 1
    if body_lines > BODY_LINES_MAX:
        say(skill, body_at + 1, "length", f"body is {body_lines} lines, over {BODY_LINES_MAX}")
    if len(body) > BODY_CHARS_MAX:
        say(skill, body_at + 1, "size",
            f"body is {len(body)} chars, over {BODY_CHARS_MAX} (about the 5,000 tokens kept after compaction)")

    linked = set()
    for n, target in links_in(text):
        path = os.path.normpath(os.path.join(pdir, target))
        if not os.path.exists(path):
            say(skill, n, "link", f"{target} does not exist")
        else:
            linked.add(path)

    refdir = os.path.join(pdir, "references")
    refs = []
    if os.path.isdir(refdir):
        for dp, _, fs in os.walk(refdir):
            refs += [os.path.join(dp, f) for f in sorted(fs) if f.endswith(".md")]
    for ref in sorted(refs):
        if ref not in linked:
            say(ref, 1, "orphan", "not linked from SKILL.md")
        with open(ref, encoding="utf-8") as fh:
            rtext = fh.read()
        rlines = rtext.split("\n")
        for n, target in links_in(rtext):
            base = pdir if target.startswith("references/") else os.path.dirname(ref)
            path = os.path.normpath(os.path.join(base, target))
            if path.startswith(refdir + os.sep) and path.endswith(".md") and path != ref:
                say(ref, n, "depth", f"links {os.path.relpath(path, pdir)}; link it from SKILL.md instead")
            elif not os.path.exists(path):
                say(ref, n, "link", f"{target} does not exist")
        if len(rlines) > REF_TOC_AFTER and not has_contents(rlines):
            say(ref, 1, "contents", f"{len(rlines)} lines and no contents list in the first {TOC_WINDOW}")
    return findings


def plugins_with_skill(root):
    return sorted(d for d in os.listdir(root)
                  if not d.startswith(".") and os.path.isfile(os.path.join(root, d, "SKILL.md")))


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    root = os.environ.get("SKILL_LINT_ROOT") or repo_root()
    plugins = argv or plugins_with_skill(root)
    findings = []
    for p in plugins:
        if not os.path.isfile(os.path.join(root, p, "SKILL.md")):
            print(f"{p}: no SKILL.md at the plugin root", file=sys.stderr)
            return 2
        findings += lint_plugin(root, p)
    for f in findings:
        print(f)
    print(f"skill lint: {len(plugins)} skill(s), {len(findings)} finding(s)", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
