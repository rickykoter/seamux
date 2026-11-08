#!/usr/bin/env python3
"""Copy seamux's palette (theme/everforest.css) into every page that uses it.

    python3 tools/theme_sync.py           write it where it is out of date
    python3 tools/theme_sync.py --check   exit 1, naming each stale page,
                                          text token under 4.5:1, role
                                          fill under 3:1 or terminal slot
                                          under 4.5:1

The pages cannot read theme/ at run time: crew runs from a copy of crew/
(crew apply), the plugins from their own folders, and deep-plan inlines its
CSS into a self-contained page. So each page carries the palette between
two markers, and this writes it there:

    /* everforest:start */ ... /* everforest:end */

A dark-only page would take the dark block alone, so the OS's light mode
never reaches it; every page now carries both.

--check also holds every --ef-text-* token to WCAG's 4.5:1 against the
grounds words sit on in each mode (GROUNDS). Faint text is meta text on the
page itself, so it is held to the page grounds alone; it is not for code
in a diff, which sits on the tints.

The --role-* tokens say what a colour means (needs you, working, done,
broken, text, link, focus, the primary button). A role is a hex or a
var(--ef-*); --check resolves it, then holds each word colour (text,
text-quiet, link, every -t) to 4.5:1 and each fill (the states, focus,
primary) to GRAPHIC:1 on ROLE_GROUNDS, the primary's ink to 4.5:1 on the
primary, and the two light copies to the same values. Lines and edges are
separators and held to nothing.

The --term-* tokens are the app's terminal palette: ground, words, cursor,
selection and the 16 ANSI slots. --check holds the words and each slot a
program prints words in to 4.5:1 on --term-bg, the selection's words to
4.5:1 on the selection, the cursor to GRAPHIC:1 on the ground and the
letter under it to 4.5:1 on the cursor. A selection is a tint, held only
through its words. The slots a terminal
paints as grounds (TERM_GROUND_SLOTS) are held to nothing.
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
    ("crew/board/board.html", "both"),
    ("crew/board/usage.tmpl.html", "both"),
    ("crew/board/artifacts.tmpl.html", "both"),
]


FLOOR = 4.5
# Grounds a word can sit on: page, side bars, raised rows and cards, the
# selected row (card3), and the tints: green and red (diff lines, badges) and
# blue (a selected file, a hunk header).
GROUNDS = {
    "dark": ["bg-dim", "bg", "bg1", "card", "card3", "bg-green", "bg-red", "bg-blue"],
    "light": ["bg-dim", "bg", "bg1", "bg3", "card3", "bg-green", "bg-red", "bg-blue"],
}
FAINT_GROUNDS = {"dark": ["bg-dim", "bg", "bg1"], "light": ["bg-dim", "bg", "bg1"]}

GRAPHIC = 3.0
# A state's word or mark sits on a page, a side bar, a raised row or card, or
# the selected row; not on the diff tints.
ROLE_GROUNDS = {
    "dark": ["bg-dim", "bg", "bg1", "card", "card3"],
    "light": ["bg-dim", "bg", "bg1", "bg3", "card3"],
}
# Words also sit on the tints: lookout puts a gate pill or an addressed
# finding's status on a green, red or blue wash.
ROLE_WORD_GROUNDS = {m: g + ["bg-green", "bg-red", "bg-blue"] for m, g in ROLE_GROUNDS.items()}
ROLE_WORDS = {"text", "text-quiet", "link"}
ROLE_FILLS = {"attend", "working", "done", "broken", "focus", "primary"}
ROLE_FREE = {"line", "edge", "on-primary"}
STATES = ("attend", "working", "done", "broken")
# Every block carries every role, so no surface finds one missing in a mode.
ROLES = ROLE_WORDS | ROLE_FILLS | ROLE_FREE | {s + "-t" for s in STATES}

# The terminal's own colours, beside the 16 ANSI slots (--term-0 .. --term-15).
TERM_KEYS = {"bg", "text", "cursor", "cursor-text", "selection", "selection-text"} | {str(i) for i in range(16)}
# Slots programs paint as grounds rather than print words in: black in dark
# (Claude Code's dark-ansi theme fills its bash and inverse text with it),
# bright white in light (its light-ansi theme's bash background).
TERM_GROUND_SLOTS = {"dark": {"0"}, "light": {"15"}}


def tokens(css: str) -> dict[str, str]:
    return dict(re.findall(r"--ef-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", css))


def terms(css: str) -> dict[str, str]:
    return dict(re.findall(r"--term-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", css))


def term_failures(mode: str, t: dict[str, str]) -> list[str]:
    missing = sorted(TERM_KEYS - t.keys(), key=lambda k: (k.isdigit(), int(k) if k.isdigit() else 0, k))
    if missing:
        return [f"{mode}: missing --term-" + ", --term-".join(missing)]
    out = []
    pairs = [("text", "bg", FLOOR), ("selection-text", "selection", FLOOR), ("cursor", "bg", GRAPHIC), ("cursor-text", "cursor", FLOOR)]
    pairs += [(str(i), "bg", FLOOR) for i in range(16) if str(i) not in TERM_GROUND_SLOTS[mode]]
    for k, g, floor in pairs:
        r = ratio(t[k], t[g])
        if r < floor:
            out.append(f"{mode} --term-{k} {t[k]} on --term-{g} {t[g]} is {r:.2f}:1, under {floor}:1")
    return out


def roles(css: str, ef: dict[str, str]) -> dict[str, str]:
    """Each --role-* in a block, resolved to a hex (None when it names no palette hex)."""
    out = {}
    for k, v in re.findall(r"--role-([a-z0-9-]+):\s*([^;]+);", css):
        v = v.strip()
        m = re.fullmatch(r"var\(--ef-([a-z0-9-]+)\)", v)
        out[k] = ef.get(m.group(1)) if m else (v if re.fullmatch(r"#[0-9a-fA-F]{6}", v) else None)
    return out


def blocks(css: str) -> tuple[str, str, str]:
    """The dark block, the OS-light media block and the data-theme light block."""
    i, j = css.index("/* light */"), css.index(':root[data-theme="light"]')
    return css[:i], css[i:j], css[j:]


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
    # The data-theme="light" block repeats the media block; check that one,
    # and that the two say the same.
    dark, media, light = blocks(css)
    out = []
    same = lambda b: (tokens(b), re.findall(r"--role-[^;]+;", b), terms(b))
    if same(media) != same(light):
        out.append('light: the media block and :root[data-theme="light"] differ')
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
        out += role_failures(mode, t, roles(block_, t))
        out += term_failures(mode, terms(block_))
    return out


def role_failures(mode: str, ef: dict[str, str], rs: dict[str, str]) -> list[str]:
    out = []
    missing = sorted(ROLES - rs.keys())
    if missing:
        out.append(f"{mode}: missing --role-" + ", --role-".join(missing))
    for k, v in rs.items():
        if v is None:
            out.append(f"{mode} --role-{k}: not a hex or a var(--ef-*) with one")
            continue
        if k in ROLE_FREE:
            continue
        if k in ROLE_WORDS or k.endswith("-t"):
            floor = FLOOR
        elif k in ROLE_FILLS:
            floor = GRAPHIC
        else:
            out.append(f"{mode} --role-{k}: not a known word, fill or separator role")
            continue
        for g in (ROLE_WORD_GROUNDS if floor == FLOOR else ROLE_GROUNDS)[mode]:
            r = ratio(v, ef[g])
            if r < floor:
                out.append(f"{mode} --role-{k} {v} on --ef-{g} {ef[g]} is {r:.2f}:1, under {floor}:1")
    if rs.get("primary") and rs.get("on-primary"):
        r = ratio(rs["primary"], rs["on-primary"])
        if r < FLOOR:
            out.append(f"{mode} --role-on-primary on --role-primary is {r:.2f}:1, under {FLOOR}:1")
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
            print(f"theme sync: contrast: {w}", file=sys.stderr)
        if stale:
            print("theme sync: out of date, run python3 tools/theme_sync.py: " + ", ".join(stale), file=sys.stderr)
        if stale or weak:
            return 1
        print(f"theme sync: {len(TARGETS)} pages match theme/everforest.css; every text token, role word and terminal word slot is {FLOOR}:1 or better, every role fill {GRAPHIC}:1")
        return 0
    print(f"theme sync: wrote {len(stale)} of {len(TARGETS)} pages" + (": " + ", ".join(stale) if stale else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
