#!/usr/bin/env python3
"""Copy seamux's palette (theme/everforest.css) into every page that uses it.

    python3 tools/theme_sync.py           write it where it is out of date
    python3 tools/theme_sync.py --check   exit 1, naming each stale page

The pages cannot read theme/ at run time: crew runs from a copy of crew/
(crew apply), the plugins from their own folders, and deep-plan inlines its
CSS into a self-contained page. So each page carries the palette between
two markers, and this writes it there:

    /* everforest:start */ ... /* everforest:end */

A dark-only page (the board's, which has no light colours of its own) takes
the dark block alone, so the OS's light mode never reaches it.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "theme" / "everforest.css"
START, END = "/* everforest:start */", "/* everforest:end */"

# (page, "both" | "dark")
TARGETS = [
    ("deep-plan/deep_plan.mjs", "both"),
    ("lookout/page/review.css", "both"),
    ("app/ui/everforest.css", "both"),
    ("crew/board/board.html", "dark"),
    ("crew/board/usage.tmpl.html", "dark"),
    ("crew/board/artifacts.tmpl.html", "dark"),
]


def palette(mode: str) -> str:
    css = SOURCE.read_text()
    # The header comment stays in theme/; pages get the rules.
    css = re.sub(r"^/\*.*?\*/\s*", "", css, count=1, flags=re.S)
    if mode == "dark":
        css = css[: css.index("/* light */")]
    return css.strip()


def block(mode: str) -> str:
    return f"{START}\n{palette(mode)}\n{END}"


def synced(text: str, mode: str) -> str:
    if START not in text or END not in text:
        raise ValueError("no everforest markers")
    head, rest = text.split(START, 1)
    _, tail = rest.split(END, 1)
    return head + block(mode) + tail


def main(argv: list[str]) -> int:
    check = "--check" in argv
    stale = []
    for rel, mode in TARGETS:
        path = ROOT / rel
        if rel == "app/ui/everforest.css":
            # The app's copy is a whole file of its own.
            want = "/* Generated from theme/everforest.css by tools/theme_sync.py: edit that, not this. */\n" + block(mode) + "\n"
            have = path.read_text() if path.exists() else ""
        else:
            have = path.read_text()
            try:
                want = synced(have, mode)
            except ValueError as e:
                print(f"theme sync: {rel}: {e}", file=sys.stderr)
                return 2
        if have != want:
            stale.append(rel)
            if not check:
                path.write_text(want)
    if check:
        if stale:
            print("theme sync: out of date, run python3 tools/theme_sync.py: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"theme sync: {len(TARGETS)} pages match theme/everforest.css")
        return 0
    print(f"theme sync: wrote {len(stale)} of {len(TARGETS)} pages" + (": " + ", ".join(stale) if stale else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
