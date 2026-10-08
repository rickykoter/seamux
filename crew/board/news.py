#!/usr/bin/env python3
"""The board's news: where the fleet stands, as sentences, in priority order.

    compose(rows, now, hours) -> {"hours", "lede", "items": [{id, tier, family, text}]}
    news.py --compose FIXTURE.json      pure composition over a fixture, for the probe

Rows in, sentences out. The rows are rank()'s, already in the board's order --
attend, wilt, running, done, quiet, with each family moved as one unit to its
most urgent member's place (families.py) -- so the paragraph reads in exactly
the order the board ranks, and cannot disagree with the rows above it. Nothing
here re-ranks.

Deterministic on purpose: no model writes this. It is rebuilt on every push,
which is only string building, because the one expensive input -- each
workspace's recent commits -- arrives on the row (`commits`, [{at, s}]) from
the full pass's cache. Timestamps rather than a count, so a fast pass recounts
against the sliding window instead of trusting a number from minutes ago.

The same sentences reach the terminal through crew-digest, which reads
`crew-board state --json`, so the wording lives here and nowhere else. Text
uses the two affordances render.js gives `said` back after escaping --
{{subject}} for bold and `x` for code -- and names and commit subjects are
stripped of both markers first, so a branch or a subject cannot open one.
"""
import json
import os
import re
import sys
import time

HOURS_DEFAULT = 5.0


def hours():
    """The lookback window, from CREW_NEWS_HOURS; a bad value falls back."""
    try:
        h = float(os.environ.get("CREW_NEWS_HOURS", HOURS_DEFAULT))
        return h if h > 0 else HOURS_DEFAULT
    except ValueError:
        return HOURS_DEFAULT


def _plain(s):
    """Text from a name, branch or subject, with the markup markers removed."""
    return re.sub(r"\{\{|\}\}|`", "", str(s or "")).strip()


def _hrs(h):
    return "%gh" % h


def _progress(r):
    """'d/t increments' as rank() writes it into meta, or ''."""
    m = re.search(r"(\d+)/(\d+) increments", r.get("meta") or "")
    return (m.group(1), m.group(2)) if m else None


def recent(r, now, h):
    """The row's commits inside the window, newest first."""
    cut = now - h * 3600
    out = []
    for c in r.get("commits") or []:
        try:
            if float(c.get("at", 0)) >= cut:
                out.append(c)
        except (TypeError, ValueError, AttributeError):
            continue
    return sorted(out, key=lambda c: -float(c.get("at", 0)))


def _commits_clause(r, now, h):
    cs = recent(r, now, h)
    if not cs:
        return ""
    n = len(cs)
    latest = _plain(cs[0].get("s"))[:72]
    return "%d commit%s in the last %s%s" % (
        n, "" if n == 1 else "s", _hrs(h),
        (", latest “%s”" % latest) if latest else "")


def state(r):
    """What this row's badge means, as a predicate with no subject and no stop:
    'needs your go-ahead on X'. '' for a quiet row, which has no state worth a
    sentence on its own."""
    b, subj = r.get("badge") or "", _plain(r.get("subject"))
    prog = _progress(r)
    if b == "asked you":
        return "is waiting on your answer"
    if b == "review":
        n = prog[1] if prog else ""
        if not n or n == "0":
            return "needs its alignment check taken"
        return "needs its alignment check taken; %s increment%s locked behind it" % (
            n, " is" if n == "1" else "s are")
    if b == "gate shut":
        return "needs your go-ahead on %s" % subj if subj else "needs your go-ahead"
    if b == "ci failed":
        br = _plain(r.get("branch"))
        return "is red on CI on `%s`" % br if br else "is red on CI"
    if b == "check failed":
        return "failed a check (%s)" % subj if subj else "failed a check"
    if b == "conflicts":
        return "conflicts with its base"
    if b == "changes":
        return "has review changes requested"
    if b == "blocked":
        return "is blocked on %s" % subj if subj else "is blocked"
    if b == "stuck":
        return "ended its last turn on an error it could not get past"
    if b == "working":
        s = "is working on %s" % subj if subj else "is working"
        return s + (" (%s/%s increments)" % prog if prog else "")
    if b == "merged":
        return "merged and can be reclaimed"
    if b == "plan done":
        return "finished every increment; its plan can be closed"
    return ""


def _sentence(r, now, h):
    """One row's full sentence, or '' when it has nothing to say."""
    name = _plain(r.get("name")) or _plain(r.get("id"))
    st = state(r) if r.get("kind") != "quiet" else ""
    cc = _commits_clause(r, now, h)
    if st and cc:
        return "{{%s}} %s, with %s." % (name, st, cc)
    if st:
        return "{{%s}} %s." % (name, st)
    if cc:
        return "{{%s}} is quiet, with %s." % (name, cc)
    return ""


def compose(rows, now=None, h=None):
    now = now if now is not None else time.time()
    h = h if h is not None else hours()
    items, quiet_n, i = [], 0, 0
    rows = list(rows or [])
    while i < len(rows):
        r = rows[i]
        fam = r.get("family") or ""
        if fam:
            # A family is one item: its members are contiguous (families.py),
            # and the item reads at the family's tier, not the first member's.
            members = []
            while i < len(rows) and rows[i].get("family") == fam:
                members.append(rows[i])
                i += 1
            parts, idle = [], 0
            for m in members:
                s = _sentence(m, now, h)
                if s:
                    parts.append(s.rstrip("."))
                else:
                    idle += 1
            if not parts:
                quiet_n += len(members)
                continue
            if idle:
                parts.append("%d more %s quiet" % (idle, "is" if idle == 1 else "are"))
            tier = members[0].get("famtier") or members[0].get("kind") or "quiet"
            items.append({"id": "family:" + fam, "tier": tier, "family": fam,
                          "text": "Family {{%s}}: %s." % (_plain(fam), "; ".join(parts))})
            continue
        i += 1
        s = _sentence(r, now, h)
        if not s:
            quiet_n += 1
            continue
        items.append({"id": r.get("id", ""), "tier": r.get("kind") or "quiet",
                      "family": "", "text": s})
    if quiet_n:
        items.append({"id": "quiet", "tier": "quiet", "family": "",
                      "text": "%d other workspace%s quiet." % (
                          quiet_n, " is" if quiet_n == 1 else "s are")})
    return {"hours": h, "lede": items[0]["text"] if items else "", "items": items}


def paragraph(news):
    """The items as one plain paragraph, markers removed, for a terminal."""
    return " ".join(_plain(it.get("text")) for it in (news or {}).get("items") or [])


def main(argv):
    if argv[:1] == ["--compose"] and len(argv) >= 2:
        with open(argv[1]) as fh:
            fx = json.load(fh)
        print(json.dumps(compose(fx.get("rows") or [], fx.get("now"), fx.get("hours"))))
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
