#!/usr/bin/env python3
"""Copy seamux's palette (theme/everforest.css) into every page that uses it.

    python3 tools/theme_sync.py           write it where it is out of date
    python3 tools/theme_sync.py --check   exit 1, naming each stale page
                                          or text token under 4.5:1

The pages cannot read theme/ at run time: crew runs from a copy of crew/
(crew apply), the plugins from their own folders, and deep-plan inlines its
CSS into a self-contained page. So each page carries the palette between
two markers, and this writes it there:

    /* everforest:start */ ... /* everforest:end */

A dark-only page (the board's, which has no light colours of its own) takes
the dark block alone, so the OS's light mode never reaches it.

--check also holds every --ef-text-* token to WCAG's 4.5:1 against the
grounds words sit on in each mode (GROUNDS). Faint text is meta text on the
page itself, so it is held to the page grounds alone; it is not for code
in a diff, which sits on the tints.
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


FLOOR = 4.5
# Grounds a word can sit on: page, side bars, raised rows and cards, and the
# green and red tints (diff lines, badges).
GROUNDS = {
    "dark": ["bg-dim", "bg", "bg1", "card", "bg-green", "bg-red"],
    "light": ["bg-dim", "bg", "bg1", "bg3", "bg-green", "bg-red"],
}
FAINT_GROUNDS = {"dark": ["bg-dim", "bg", "bg1"], "light": ["bg-dim", "bg", "bg1"]}


def tokens(css: str) -> dict[str, str]:
    return dict(re.findall(r"--ef-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", css))


def luminance(hex_: str) -> float:
    def ch(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def ratio(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def contrast_failures() -> list[str]:
    css = SOURCE.read_text()
    dark = css[: css.index("/* light */")]
    # The data-theme="light" block repeats the media block; check that one.
    light = css[css.index(':root[data-theme="light"]') :]
    out = []
    for mode, block_ in (("dark", dark), ("light", light)):
        t = tokens(block_)
        texts = [k for k in t if k == "text" or k.startswith("text-")]
        if not texts:
            out.append(f"{mode}: no --ef-text tokens")
        for k in texts:
            grounds = FAINT_GROUNDS[mode] if k == "text-faint" else GROUNDS[mode]
            for g in grounds:
                r = ratio(t[k], t[g])
                if r < FLOOR:
                    out.append(f"{mode} --ef-{k} {t[k]} on --ef-{g} {t[g]} is {r:.2f}:1")
    return out


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
        weak = contrast_failures()
        for w in weak:
            print(f"theme sync: text under {FLOOR}:1: {w}", file=sys.stderr)
        if stale:
            print("theme sync: out of date, run python3 tools/theme_sync.py: " + ", ".join(stale), file=sys.stderr)
        if stale or weak:
            return 1
        print(f"theme sync: {len(TARGETS)} pages match theme/everforest.css; every text token is {FLOOR}:1 or better")
        return 0
    print(f"theme sync: wrote {len(stale)} of {len(TARGETS)} pages" + (": " + ", ".join(stale) if stale else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
