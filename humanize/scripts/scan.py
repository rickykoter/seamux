#!/usr/bin/env python3
"""Scan prose for mechanical AI-writing tells.

Usage:
    python3 scan.py FILE [FILE ...]       # or pipe text on stdin
    python3 scan.py --json FILE           # machine-readable output

Finds the tells a regex can find reliably: dashes, curly quotes, emoji,
boldface density, inline-header lists, title-case headings, watched words
and phrases, and candidates for some readability patterns. It skips YAML
frontmatter, fenced code blocks, and inline code.

Hits are candidates, not verdicts. Isolated hits mean little; clusters
matter (see references/false-positives.md). Grammar patterns that need a
parser (dropped "that", stacked nouns, long subject-verb gaps) are only
flagged loosely or not at all, so still read for them.
"""
import json
import re
import sys

WATCH = {
    "§1 significance puffery": [
        r"\bstands as\b", r"\bserves as\b", r"\bis a (testament|reminder)\b",
        r"\b(vital|significant|crucial|pivotal|key) (role|moment)\b",
        r"\bunderscores? (its|the) (importance|significance)\b", r"\breflects broader\b",
        r"\bsetting the stage for\b", r"\bmarks? a shift\b", r"\bturning point\b",
        r"\bevolving landscape\b", r"\bindelible mark\b", r"\bdeeply rooted\b",
    ],
    "§3 trailing -ing analysis": [
        r",\s+(highlighting|underscoring|emphasizing|ensuring|reflecting|symbolizing|"
        r"contributing to|cultivating|fostering|encompassing|showcasing|serving as|ensures?)\b",
    ],
    "§4 promotional language": [
        r"\bboasts\b", r"\bvibrant\b", r"\bnestled\b", r"\bin the heart of\b",
        r"\bgroundbreaking\b", r"\brenowned\b", r"\bbreathtaking\b", r"\bmust-visit\b",
        r"\bstunning\b", r"\bcommitment to\b",
    ],
    "§5 vague attribution": [
        r"\b(experts|observers|critics) (argue|believe|say|have cited)\b", r"\bindustry reports\b",
    ],
    "§7 AI vocabulary": [
        r"\badditionally\b", r"\balign(s|ed)? with\b", r"\bcrucial\b", r"\bdelve\w*\b",
        r"\benduring\b", r"\benhanc\w*\b", r"\bfoster\w*\b", r"\bgarner\w*\b",
        r"\bhighlights?\b", r"\binterplay\b", r"\bintricac\w*\b", r"\bintricate\b",
        r"\blandscape\b", r"\bpivotal\b", r"\bshowcas\w*\b", r"\btapestry\b",
        r"\btestament\b", r"\bunderscor\w*\b", r"\bvaluable\b",
        r"\brobust\b", r"\bseamless\w*\b", r"\bleverag\w*\b",
    ],
    "§9 negative parallelism": [
        r"\bnot only\b", r"\bit'?s not (just|merely|only) (about )?", r"\bnot merely\b",
    ],
    "§20 chatbot artifacts": [
        r"\bI hope this helps\b", r"\bCertainly!", r"\bOf course!", r"\byou'?re absolutely right\b",
        r"\blet me know if\b", r"\bwould you like me to\b", r"\bwant me to\b", r"\bhere is an? \w+",
    ],
    "§21 cutoff / gap-filling": [
        r"\bas of my (last|latest)\b", r"\btraining (data|update)\b", r"\bnot publicly available\b",
        r"\bmaintains a low profile\b", r"\bkeeps? personal details private\b", r"\bit is believed that\b",
        r"\bbased on available information\b",
    ],
    "§22 sycophancy": [r"\bgreat question\b", r"\bexcellent point\b"],
    "§23 filler": [
        r"\bdue to the fact that\b", r"\bat this point in time\b", r"\bin the event that\b",
        r"\bhas the ability to\b", r"\bit is important to note\b",
    ],
    "§25 generic upbeat ending": [r"\bthe future looks bright\b", r"\bexciting times\b", r"\bstep in the right direction\b"],
    "§27 authority tropes": [
        r"\bthe real question is\b", r"\bat its core\b", r"\bwhat really matters\b",
        r"\bthe heart of the matter\b", r"\bthe deeper issue\b",
    ],
    "§28 signposting": [
        r"\blet'?s (dive|explore|break (this|it) down)\b", r"\bhere'?s what you need to know\b",
        r"\bwithout further ado\b", r"\bnow let'?s look at\b",
    ],
    "§32 aphorism formula": [r"\bthe (language|currency|architecture) of\b", r"\bbecomes a trap\b"],
    "§33 rhetorical opener": [
        r"(^|[.?!]\s+)(Honestly\?|Look,|Here'?s the thing|The thing is|Let'?s be honest|Real talk)",
    ],
    "§34 personified code (check subject)": [
        r"\b(it|this|that|the \w+)\s+(swallow|eat|bite|hope|want|know|decide|forget|remember|"
        r"promise|lie|fight|complain|insist|trust|care)s\b",
    ],
}

EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF]")
SMALL = {"a", "an", "the", "and", "or", "but", "for", "nor", "of", "on", "in", "to", "at", "by",
         "with", "vs", "via", "as", "is", "from", "into", "per"}


def strip_noise(text):
    """Blank out frontmatter, fenced code, and inline code; keep line numbers."""
    lines = text.split("\n")
    out, in_fence = [], False
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                out = [""] * (i + 1)
                lines = lines[i + 1:]
                break
    for ln in lines:
        if ln.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            out.append("")
            continue
        out.append("" if in_fence else re.sub(r"`[^`]*`", "CODE", ln))
    return out


def scan(text):
    lines = strip_noise(text)
    hits = []

    def add(sec, n, snippet):
        hits.append({"pattern": sec, "line": n, "text": snippet.strip()[:120]})

    words = 0
    for n, ln in enumerate(lines, 1):
        if not ln.strip():
            continue
        words += len(ln.split())
        for ch, name in (("\u2014", "em dash"), ("\u2013", "en dash")):
            if ch in ln:
                add("§14 dashes (" + name + ")", n, ln)
        if re.search(r"\s--\s", ln):
            add("§14 dashes (double hyphen)", n, ln)
        if re.search("[\u201c\u201d\u2018\u2019]", ln):
            add("§19 curly quotes", n, ln)
        if EMOJI.search(ln):
            add("§18 emoji", n, ln)
        if re.match(r"\s*([-*+]|\d+\.)\s+\*\*[^*]+:\*\*|\s*([-*+]|\d+\.)\s+\*\*[^*]+\*\*:", ln):
            add("§16 inline-header list item", n, ln)
        m = re.match(r"\s*#{1,6}\s+(.*)", ln)
        if m:
            ws = re.findall(r"[A-Za-z][\w'-]*", m.group(1))
            content = [w for w in ws[1:] if w.lower() not in SMALL]
            if len(ws) >= 2 and len(content) >= 1 and all(w[0].isupper() for w in content):
                add("§17 title-case heading", n, ln)
        for sec, pats in WATCH.items():
            for p in pats:
                for mm in re.finditer(p, ln, re.IGNORECASE if not sec.startswith("§33") else 0):
                    add(sec, n, mm.group(0) + "  |  " + ln)
        for sent in re.split(r"(?<=[.?!])\s+", ln):
            if len(sent.split()) > 30:
                add("§37 long sentence (check subject-verb gap)", n, sent)
            # A long parenthetical or dash aside with more sentence after it
            for mm in re.finditer(r"\(([^()]*)\)|\u2014([^\u2014]*)\u2014", sent):
                inner = mm.group(1) or mm.group(2) or ""
                after = sent[mm.end():].strip(" .?!")
                if len(inner.split()) >= 8 and len(after.split()) >= 2:
                    add("§37 long interruption before the rest of the sentence", n, sent)

    bold = sum(len(re.findall(r"\*\*[^*]+\*\*", ln)) for ln in lines)
    summary = {}
    for h in hits:
        summary[h["pattern"]] = summary.get(h["pattern"], 0) + 1
    if words and bold / words * 100 > 1.5:
        summary["§15 boldface density"] = f"{bold} bold spans in {words} words"
    return {"words": words, "summary": summary, "hits": hits}


def main(argv):
    as_json = "--json" in argv
    files = [a for a in argv if a != "--json"]
    sources = [(f, open(f, encoding="utf-8").read()) for f in files] or [("stdin", sys.stdin.read())]
    results = {name: scan(text) for name, text in sources}
    if as_json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return
    for name, r in results.items():
        print(f"== {name} ({r['words']} words) ==")
        if not r["summary"]:
            print("No mechanical tells found. Still read for grammar patterns (§34 to §39).")
            continue
        for k, v in sorted(r["summary"].items(), key=lambda kv: int(re.match(r"§(\d+)", kv[0]).group(1))):
            print(f"  {k}: {v}")
        print()
        for h in r["hits"]:
            print(f"  L{h['line']:<5} {h['pattern']}: {h['text']}")


if __name__ == "__main__":
    main(sys.argv[1:])
