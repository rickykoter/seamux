#!/usr/bin/env python3
"""Claude Code status line: the worktree's colour, then whatever constrains you.

    ▊ my-project  ⏱ 42% of 5h window · 2h 10m left · ↗ 78% by reset
    ▊ my-project  💰 $1,288 of $3,000 (43%) · → $2,576 by Sep 30   (CREW_BILLING=usage)

Two billing models want different lines. On a subscription the constraint is the
5h window, so the line is tokens against a per-window budget. On usage-based
billing there is no window limit at all -- you are billed, not throttled -- and
the constraint is the month, so the line is month-to-date spend against
`CREW_MONTH_BUDGET` with a pace figure. `CREW_BILLING=usage` selects the second;
anything else keeps the first, so an install that sets nothing is unchanged.

Dollar figures are gone on purpose: on a subscription the real constraint is
the 5h usage window, so the line shows tokens spent as a share of a per-window
BUDGET. The budget is `CREW_BLOCK_BUDGET` (tokens) when set, else the largest
5h block on record — ccusage's own `--token-limit max` idea. Tokens come from
`ccusage blocks --json`, which reads the same transcripts the old dollar line
did; nothing here prices anything.

What stays here is the one thing ccusage has no reason to know: which worktree
this session is in, painted in that worktree's own colour. It is cmux's
`custom_color` -- the same hex crew-color hands to Peacock for the VS Code
window, the crew board rings the current card with, and crew-frame paints the
focused pane's border. One colour across five surfaces, so "which of these
terminals is the one I care about" is answerable at a glance.

To drop the colour and run ccusage bare, point settings.json straight at it:

    "statusLine": { "type": "command", "command": "ccusage statusline" }
"""

import calendar
import datetime
import json
import os
import shutil
import subprocess
import sys
import time

CMUX_COLORS = os.path.join(os.path.expanduser("~"), ".claude", "cache", "cmux-colors.json")
COLOR_TTL = 300


def _resolver():
    """cmux's path, without hardcoding a bundle: a stale path drives the OLD CLI
    against the NEW app after a build switch, and that fails silently."""
    r = os.path.join(os.path.expanduser("~"), ".config", "cmux", "crew", "bin",
                     "crew-cmux-bin")
    if os.access(r, os.X_OK):
        try:
            out = subprocess.run([r], capture_output=True, text=True, timeout=5).stdout.strip()
            if out and os.path.exists(out):
                return out
        except Exception:
            pass
    return shutil.which("cmux")


def workspace_color():
    """(hex, title) for the workspace this session runs in, or (None, None).

    The workspace id arrives free in the environment as CMUX_WORKSPACE_ID, so the
    only lookup needed is id -> colour. That costs a socket round trip (~27ms for
    the whole list), too much to spend on every render, so it is cached for
    COLOR_TTL and refreshed in the foreground only on a miss.
    """
    wsid = os.environ.get("CMUX_WORKSPACE_ID")
    if not wsid:
        return None, None

    cache = {}
    try:
        with open(CMUX_COLORS) as fh:
            cache = json.load(fh)
    except (OSError, ValueError):
        cache = {}

    hit = cache.get(wsid)
    if hit and (time.time() - hit.get("at", 0)) < COLOR_TTL:
        return hit.get("color") or None, hit.get("title") or None

    cmux = _resolver()
    if not cmux:
        return None, None
    try:
        out = subprocess.run([cmux, "workspace", "list", "--json"],
                             capture_output=True, text=True, timeout=6).stdout
        listed = json.loads(out).get("workspaces") or []
    except Exception:
        # Cache the miss too, or a cmux that is down costs a 6s timeout per render.
        listed = []
    now = int(time.time())
    for w in listed:
        wid = w.get("id")
        if wid:
            cache[wid] = {"at": now, "color": w.get("custom_color") or "",
                          "title": (w.get("title") or "").strip()}
    cache.setdefault(wsid, {"at": now, "color": "", "title": ""})
    try:
        os.makedirs(os.path.dirname(CMUX_COLORS), exist_ok=True)
        tmp = CMUX_COLORS + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(cache, fh)
        os.replace(tmp, CMUX_COLORS)
    except OSError:
        pass
    e = cache.get(wsid) or {}
    return e.get("color") or None, e.get("title") or None


def for_text(r, g, b):
    """Lift a Peacock colour into something readable as FOREGROUND text.

    These hexes are chosen to sit behind white text in a VS Code title bar, so
    they are deliberately dark -- #7D6608, #196F3D, #922B21. Printed as ink on a
    dark terminal they come out as mud. Raising lightness while holding hue keeps
    the identity, which is the whole point of the colour; the saturation floor
    stops a near-grey workspace colour lifting to a flat grey.
    """
    import colorsys
    h, l, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    return tuple(int(c * 255) for c in colorsys.hls_to_rgb(h, max(l, 0.62), max(sat, 0.45)))


def tint(hexcolor, text):
    """`text` in 24-bit colour. Claude Code passes the status line through with
    ANSI intact, and every terminal cmux runs in supports truecolor."""
    h = (hexcolor or "").lstrip("#")
    if len(h) != 6:
        return text
    try:
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return text
    r, g, b = for_text(r, g, b)
    return f"\033[38;2;{r};{g};{b}m{text}\033[0m"


def _fmt_tokens(n):
    n = int(n or 0)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


def window_line(payload):
    """The 5h window as a share of its budget. Short reason when it cannot.

    Deliberately no fallback numbers. A wrong figure rendered confidently is
    worse than a missing one, and the prefix still says where you are.
    """
    exe = shutil.which("ccusage")
    if not exe:
        return "ccusage not installed — npm i -g ccusage"
    try:
        p = subprocess.run([exe, "blocks", "--json"], capture_output=True,
                           text=True, timeout=10)
        blocks = json.loads(p.stdout).get("blocks") or []
    except Exception as exc:
        return f"ccusage: {exc.__class__.__name__}"

    real = [b for b in blocks if not b.get("isGap")]
    budget = 0
    try:
        budget = int(os.environ.get("CREW_BLOCK_BUDGET", "") or 0)
    except ValueError:
        pass
    if not budget:
        budget = max((b.get("totalTokens") or 0 for b in real), default=0)
    if not budget:
        return "⏱ no usage history yet"

    active = next((b for b in real if b.get("isActive")), None)
    if not active:
        return f"⏱ window quiet · budget {_fmt_tokens(budget)}"

    used = active.get("totalTokens") or 0
    pct = used / budget * 100
    proj = active.get("projection") or {}
    left = int(proj.get("remainingMinutes") or 0)
    bits = [f"⏱ {pct:.0f}% of 5h window ({_fmt_tokens(used)}/{_fmt_tokens(budget)})"]
    if left:
        bits.append(f"{left // 60}h {left % 60:02d}m left" if left >= 60 else f"{left}m left")
    ptok = proj.get("totalTokens") or 0
    if ptok > used:
        bits.append(f"↗ {ptok / budget * 100:.0f}% by reset")
    return " · ".join(bits)


def _fmt_usd(n):
    n = n or 0
    if n >= 1000:
        return f"${n:,.0f}"
    if n >= 100:
        return f"${n:.0f}"
    return f"${n:.2f}"


def month_line():
    """Month-to-date spend against a monthly budget, and whether it is on pace.

    For usage-based billing, where the 5h window is not a limit at all -- you
    are not throttled at the end of one, you are billed. The constraint is the
    month, so that is what the line shows.

    Pace is spend-per-elapsed-day extended to the whole month, which answers
    "am I on track" rather than only "what have I spent". It is deliberately
    absent on the first day: one day of history projected across a month is
    noise wearing a number's clothes.
    """
    exe = shutil.which("ccusage")
    if not exe:
        return "ccusage not installed — npm i -g ccusage"
    try:
        p = subprocess.run([exe, "monthly", "--json"], capture_output=True,
                           text=True, timeout=15)
        rows = json.loads(p.stdout).get("monthly") or []
    except Exception as exc:
        return f"ccusage: {exc.__class__.__name__}"

    now = datetime.datetime.now()
    period = now.strftime("%Y-%m")
    cur = next((r for r in rows if r.get("period") == period), None)
    if not cur:
        return "💰 nothing billed this month yet"

    spent = cur.get("totalCost") or 0
    try:
        budget = float(os.environ.get("CREW_MONTH_BUDGET", "") or 0)
    except ValueError:
        budget = 0

    days_in = calendar.monthrange(now.year, now.month)[1]
    elapsed = now.day
    projected = spent / elapsed * days_in if elapsed else 0

    if budget > 0:
        bits = [f"💰 {_fmt_usd(spent)} of {_fmt_usd(budget)} ({spent / budget * 100:.0f}%)"]
    else:
        # No budget set is a legitimate way to run: show the figure, and do not
        # invent a denominator the way the window line does.
        bits = [f"💰 {_fmt_usd(spent)} this month"]
    if elapsed > 1 and projected > spent:
        arrow = "↗" if not budget or projected > budget else "→"
        bits.append(f"{arrow} {_fmt_usd(projected)} by {now.strftime('%b')} {days_in}")
    return " · ".join(bits)


def usage_line(payload):
    """Which constraint this account actually has.

    `CREW_BILLING=usage` means pay-as-you-go: the month is the constraint and
    the 5h window is not a limit at all. Anything else keeps the subscription
    framing, so an install that sets nothing is unchanged.
    """
    if (os.environ.get("CREW_BILLING", "") or "").strip().lower() == "usage":
        return month_line()
    return window_line(payload)


def main():
    payload = sys.stdin.read()

    lead = ""
    color, title = workspace_color()
    if color:
        lead = tint(color, "▊") + " "
        if title:
            lead += tint(color, title) + "  "

    print(lead + usage_line(payload))


if __name__ == "__main__":
    sys.exit(main())
