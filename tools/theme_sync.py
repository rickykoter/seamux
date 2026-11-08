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

The Claude Code themes in seamux-mods/themes are generated here too (CLAUDE
below): seamux dark and seamux light in exact colours from one mode's block,
and seamux foam in ANSI slot names, so it follows the terminal's palette.
--check refuses a token Claude Code does not know, then holds each theme to
the floors in each mode it serves (dark and light one each, foam both),
resolving foam's slot names through the --term-* tokens. A foam token that
cannot pass in some mode is listed in FOAM_LIMITS (and seamux-mods' README);
--check names each, and fails on any other, or on a limit that now passes.

The --term-* tokens are the app's terminal palette: ground, words, cursor,
selection and the 16 ANSI slots. --check holds the words and each slot a
program prints words in to 4.5:1 on --term-bg, the selection's words to
4.5:1 on the selection, the cursor to GRAPHIC:1 on the ground and the
letter under it to 4.5:1 on the cursor. A selection is a tint, held only
through its words. The slots a terminal
paints as grounds (TERM_GROUND_SLOTS) are held to nothing. The 256-colour
slots seamux tints (TERM_TINTS) are held off the ground by TINT_FLOOR, with
the words held to 4.5:1 on them.
"""

import functools
import json
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
    ("crew/board/agent.html", "both"),
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
# 256-colour slots seamux tints per mode, keeping their usual sense: diff
# lines (dark green, dark red), changed words, raised bands. Each must stand
# off the ground by its floor and hold the words (text, white) at 4.5:1;
# the bands hold the quiet grey (bright black) too.
TERM_TINTS = {"22": "line", "52": "line", "28": "word", "88": "word", "236": "band", "237": "band"}
TINT_FLOOR = {"line": 1.2, "word": 1.4, "band": 1.08}
TERM_KEYS |= set(TERM_TINTS)
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
    for slot, kind in TERM_TINTS.items():
        pairs += [(slot, "bg", TINT_FLOOR[kind]), ("text", slot, FLOOR), ("7", slot, FLOOR)]
        if kind == "band":
            pairs.append(("8", slot, FLOOR))
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


# Claude Code themes ------------------------------------------------------

THEMES = ROOT / "seamux-mods" / "themes"

# Every token Claude Code 2.1.319 reads from a theme (its built-in tables all
# carry these 72). Claude Code ignores an unknown one, so a typo would only
# leave the base's colour: --check refuses it here instead. The list is
# pinned because CI has no Claude Code to ask. To refresh it after an
# upgrade, take the keys of the built-in light table (the object holding
# autoAccept: "rgb(135,0,255)") from the claude binary, and give any new
# token a value in EXACT and FOAM.
CLAUDE_TOKENS = """
autoAccept autoAcceptShimmer skill bashBorder claude claudeShimmer
claudeBlue_FOR_SYSTEM_SPINNER claudeBlueShimmer_FOR_SYSTEM_SPINNER permission
permissionShimmer planMode ide promptBorder promptBorderShimmer text
inverseText inactive inactiveShimmer subtle suggestion remember background
success error warning merged warningShimmer diffAdded diffRemoved
diffAddedDimmed diffRemovedDimmed diffAddedWord diffRemovedWord
red_FOR_SUBAGENTS_ONLY blue_FOR_SUBAGENTS_ONLY green_FOR_SUBAGENTS_ONLY
yellow_FOR_SUBAGENTS_ONLY purple_FOR_SUBAGENTS_ONLY orange_FOR_SUBAGENTS_ONLY
pink_FOR_SUBAGENTS_ONLY cyan_FOR_SUBAGENTS_ONLY professionalBlue chromeYellow
clawd_body clawd_background userMessageBackground userMessageBackgroundHover
composerSidebarBackground selectionBg bashMessageBackgroundColor
memoryBackgroundColor rate_limit_fill rate_limit_empty fastMode
fastModeShimmer effortUltra briefLabelYou briefLabelClaude rainbow_red
rainbow_orange rainbow_yellow rainbow_green rainbow_blue rainbow_indigo
rainbow_violet rainbow_red_shimmer rainbow_orange_shimmer
rainbow_yellow_shimmer rainbow_green_shimmer rainbow_blue_shimmer
rainbow_indigo_shimmer rainbow_violet_shimmer
""".split()

# What each token is, for the check. Words are printed on the terminal
# ground (4.5:1); graphics are borders, bars, spinners and shimmer (3:1).
# Bands are the grounds Claude Code lays under a message, where its text and
# quiet text must still read (BAND_WORDS); the selection and the diff grounds
# lie under text alone. The diff word colours double as the +N -M counts'
# colour, which this does not hold: no colour is both a ground under the
# text and a word on the terminal ground. Free tokens are held to nothing.
# Shimmer sweeps across its word as a highlight.
C_BANDS = ["userMessageBackground", "userMessageBackgroundHover", "bashMessageBackgroundColor",
           "memoryBackgroundColor", "composerSidebarBackground"]
BAND_WORDS = ["text", "inactive", "subtle"]
C_UNDER_TEXT = ["selectionBg", "diffAdded", "diffRemoved", "diffAddedDimmed", "diffRemovedDimmed",
                "diffAddedWord", "diffRemovedWord"]
# A band, or the selection, must stand off the ground too, or it doesn't show.
BAND_FLOOR = TINT_FLOOR["band"]
DIFF_FLOORS = {"diffAdded": 1.2, "diffRemoved": 1.2, "diffAddedDimmed": 1.08, "diffRemovedDimmed": 1.08,
               "diffAddedWord": 1.4, "diffRemovedWord": 1.4}
C_FREE = ["promptBorder", "promptBorderShimmer", "rate_limit_empty", "clawd_background"]
C_GRAPHIC = ["bashBorder", "rate_limit_fill", "background", "chromeYellow", "clawd_body"] + [
    k for k in CLAUDE_TOKENS if ("Shimmer" in k or k.endswith("_shimmer")) and k not in C_FREE]
C_WORDS = [k for k in CLAUDE_TOKENS if k not in set(C_BANDS + C_UNDER_TEXT + C_FREE + C_GRAPHIC + ["inverseText"])]
# inverseText is the word on a chip filled with one of these.
C_CHIPS = ["claude", "permission", "suggestion", "success", "error", "warning", "planMode",
           "autoAccept", "merged", "briefLabelYou", "briefLabelClaude"]


def shimmer(k: str) -> str:
    return f"mix:{k}:term:text:50"


# The exact themes: one source per token, read in the mode's own block, so
# the same names serve dark and light. A source is ef:<palette token>,
# role:<role>, term:<terminal token>, a hex, another Claude token, or
# mix:<a>:<b>:<percent of a> (a and b each a source of two parts).
EXACT = {
    "text": "term:text", "inverseText": "term:bg",
    "inactive": "ef:text-dim", "subtle": "term:8",
    "claude": "ef:text-orange", "briefLabelClaude": "ef:text-orange", "fastMode": "ef:text-orange",
    "suggestion": "role:link", "permission": "role:link", "remember": "role:link", "ide": "role:link",
    "professionalBlue": "role:link", "briefLabelYou": "role:link", "claudeBlue_FOR_SYSTEM_SPINNER": "role:link",
    "planMode": "ef:text-aqua",
    "autoAccept": "ef:text-purple", "skill": "ef:text-purple", "merged": "ef:text-purple",
    "effortUltra": "ef:text-purple", "bashBorder": "ef:text-purple",
    "success": "role:done-t", "error": "role:broken-t", "warning": "role:attend-t",
    "promptBorder": "role:edge", "promptBorderShimmer": "ef:dim",
    "userMessageBackground": "term:236", "userMessageBackgroundHover": "term:237",
    "composerSidebarBackground": "term:236", "bashMessageBackgroundColor": "mix:ef:purple:term:bg:12",
    "memoryBackgroundColor": "mix:ef:blue:term:bg:12", "selectionBg": "term:selection",
    "diffAdded": "term:22", "diffRemoved": "term:52",
    "diffAddedDimmed": "mix:term:22:term:bg:60", "diffRemovedDimmed": "mix:term:52:term:bg:60",
    "diffAddedWord": "term:28", "diffRemovedWord": "term:88",
    "rate_limit_fill": "role:working", "rate_limit_empty": "ef:bg3",
    "background": "role:working", "chromeYellow": "role:attend",
    "clawd_body": "ef:text-orange", "clawd_background": "term:bg",
    "red_FOR_SUBAGENTS_ONLY": "ef:text-red", "blue_FOR_SUBAGENTS_ONLY": "ef:text-blue",
    "green_FOR_SUBAGENTS_ONLY": "ef:text-green", "yellow_FOR_SUBAGENTS_ONLY": "ef:text-yellow",
    "purple_FOR_SUBAGENTS_ONLY": "ef:text-purple", "orange_FOR_SUBAGENTS_ONLY": "ef:text-orange",
    "pink_FOR_SUBAGENTS_ONLY": "mix:ef:text-red:ef:text-purple:50", "cyan_FOR_SUBAGENTS_ONLY": "ef:text-aqua",
    "rainbow_red": "ef:text-red", "rainbow_orange": "ef:text-orange", "rainbow_yellow": "ef:text-yellow",
    "rainbow_green": "ef:text-green", "rainbow_blue": "ef:text-blue",
    "rainbow_indigo": "mix:ef:text-blue:ef:text-purple:50", "rainbow_violet": "ef:text-purple",
}
for _k in [k for k in CLAUDE_TOKENS if k.endswith("_shimmer")]:
    EXACT[_k] = shimmer(_k[: -len("_shimmer")])
for _k, _of in [("claudeShimmer", "claude"), ("permissionShimmer", "permission"), ("warningShimmer", "warning"),
                ("inactiveShimmer", "inactive"), ("fastModeShimmer", "fastMode"), ("autoAcceptShimmer", "autoAccept"),
                ("claudeBlueShimmer_FOR_SYSTEM_SPINNER", "claudeBlue_FOR_SYSTEM_SPINNER")]:
    EXACT[_k] = shimmer(_of)

# Foam: terminal slots with their usual meanings, on Claude Code's
# light-ansi base, so a flip of the app's appearance repaints it at once.
# Text is white, the terminal's words in both of seamux's palettes. Bands
# and diffs take the 256-colour slots seamux tints per mode (TERM_TINTS), as
# ansi256(n): no 16-colour slot is a soft tint in both modes.
ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
ANSI = ANSI + [n + "Bright" for n in ANSI]
FOAM = {
    "text": "white", "inverseText": "whiteBright", "inactive": "blackBright", "subtle": "blackBright",
    "claude": "redBright", "claudeShimmer": "red", "briefLabelClaude": "redBright",
    "fastMode": "redBright", "fastModeShimmer": "red", "clawd_body": "redBright", "clawd_background": "whiteBright",
    "suggestion": "blue", "permission": "blue", "permissionShimmer": "blueBright", "remember": "blue",
    "ide": "blue", "professionalBlue": "blue", "briefLabelYou": "blue",
    "claudeBlue_FOR_SYSTEM_SPINNER": "blue", "claudeBlueShimmer_FOR_SYSTEM_SPINNER": "blueBright",
    "planMode": "cyan", "background": "cyan",
    "autoAccept": "magenta", "autoAcceptShimmer": "magentaBright", "skill": "magenta",
    "merged": "magenta", "effortUltra": "magenta", "bashBorder": "magenta",
    "success": "green", "error": "red", "warning": "yellow", "warningShimmer": "yellowBright",
    "chromeYellow": "yellow",
    "promptBorder": "blackBright", "promptBorderShimmer": "white", "inactiveShimmer": "white",
    "userMessageBackground": "ansi256(236)", "userMessageBackgroundHover": "ansi256(237)",
    "bashMessageBackgroundColor": "ansi256(236)", "memoryBackgroundColor": "ansi256(236)",
    "composerSidebarBackground": "ansi256(236)", "selectionBg": "ansi256(237)",
    "diffAdded": "ansi256(22)", "diffRemoved": "ansi256(52)", "diffAddedDimmed": "ansi256(22)",
    "diffRemovedDimmed": "ansi256(52)", "diffAddedWord": "ansi256(28)", "diffRemovedWord": "ansi256(88)",
    "rate_limit_fill": "blue", "rate_limit_empty": "blackBright",
    "red_FOR_SUBAGENTS_ONLY": "red", "blue_FOR_SUBAGENTS_ONLY": "blue", "green_FOR_SUBAGENTS_ONLY": "green",
    "yellow_FOR_SUBAGENTS_ONLY": "yellow", "purple_FOR_SUBAGENTS_ONLY": "magenta",
    "orange_FOR_SUBAGENTS_ONLY": "redBright", "pink_FOR_SUBAGENTS_ONLY": "magentaBright",
    "cyan_FOR_SUBAGENTS_ONLY": "cyan",
    "rainbow_red": "red", "rainbow_orange": "redBright", "rainbow_yellow": "yellow", "rainbow_green": "green",
    "rainbow_blue": "blue", "rainbow_indigo": "blueBright", "rainbow_violet": "magenta",
    "rainbow_red_shimmer": "redBright", "rainbow_orange_shimmer": "yellowBright",
    "rainbow_yellow_shimmer": "yellowBright", "rainbow_green_shimmer": "greenBright",
    "rainbow_blue_shimmer": "blueBright", "rainbow_indigo_shimmer": "cyan", "rainbow_violet_shimmer": "magentaBright",
}

# Foam's known failures, each "<token> <mode>": what no slot can give. The
# README lists them for people; --check fails on any failure not here, and
# on an entry here that now passes.
FOAM_LIMITS = {
    # A chip's word is bright white: in dark the chips are light word colours.
    "inverseText dark",
}

# (file, name, base, mode): one mode's exact colours, or None for foam,
# which serves both.
CLAUDE_THEMES = [
    ("seamux-dark.json", "seamux dark", "dark", "dark"),
    ("seamux-light.json", "seamux light", "light", "light"),
    ("seamux-foam.json", "seamux foam", "light-ansi", None),
]


@functools.lru_cache(maxsize=None)
def mode_tokens(mode: str) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """The --ef-*, --role-* (resolved) and --term-* tokens of one mode, read once."""
    dark, _, light = blocks(SOURCE.read_text())
    b = dark if mode == "dark" else light
    ef = tokens(b)
    return ef, roles(b, ef), terms(b)


def mix(a: str, b: str, pct: float) -> str:
    x, y = (tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in (a, b))
    return "#" + "".join(f"{round(p * pct / 100 + q * (100 - pct) / 100):02x}" for p, q in zip(x, y))


def resolve(src: str, mode: str, table: dict[str, str], seen: tuple = ()) -> str:
    ef, rs, tm = mode_tokens(mode)
    if re.fullmatch(r"#[0-9a-fA-F]{6}", src):
        return src.lower()
    kind, _, rest = src.partition(":")
    if kind == "mix":
        parts = rest.split(":")
        # a and b each name a source of two parts (kind:name) or a token.
        first = parts[0] + ":" + parts[1] if parts[0] in ("ef", "role", "term") else parts[0]
        second = ":".join(parts[len(first.split(":")) : -1])
        return mix(resolve(first, mode, table, seen), resolve(second, mode, table, seen), float(parts[-1]))
    pool = {"ef": ef, "role": rs, "term": tm}.get(kind)
    if pool is not None:
        if rest not in pool or not pool[rest]:
            raise KeyError(f"{src} is not a {mode} token")
        return pool[rest].lower()
    if src in table and src not in seen:
        return resolve(table[src], mode, table, seen + (src,))
    raise KeyError(f"{src} is not a source")


def claude_theme(name: str, base: str, mode: str | None) -> dict:
    """A theme file's content: exact colours for one mode, or foam's slot names."""
    if mode is None:
        over = {k: FOAM[k] if FOAM[k].startswith("ansi256(") else f"ansi:{FOAM[k]}" for k in CLAUDE_TOKENS if k in FOAM}
    else:
        over = {k: resolve(EXACT[k], mode, EXACT) for k in CLAUDE_TOKENS if k in EXACT}
    return {"name": name, "base": base, "overrides": over}


def theme_text(t: dict) -> str:
    return json.dumps(t, indent=2) + "\n"


def wanted_themes() -> dict[str, str]:
    out = {}
    for file, name, base, mode in CLAUDE_THEMES:
        out[file] = theme_text(claude_theme(name, base, mode))
    return out


def as_hex(v: str, mode: str) -> str:
    """A theme value as the hex the app's terminal draws it with."""
    if v.startswith("ansi:"):
        return mode_tokens(mode)[2][str(ANSI.index(v[5:]))].lower()
    m = re.fullmatch(r"ansi256\((\d+)\)", v)
    if m:
        return mode_tokens(mode)[2][m.group(1)].lower()
    return v.lower()


def theme_failures(over: dict[str, str], mode: str) -> list[tuple[str, str]]:
    """Each token of a theme under its floor in one mode, as (token, why)."""
    c = {k: as_hex(v, mode) for k, v in over.items()}
    g = mode_tokens(mode)[2]["bg"].lower()
    out = []

    def hold(k: str, ground: str, gname: str, floor: float) -> None:
        if k in c and ground:
            r = ratio(c[k], ground)
            if r < floor:
                out.append((k, f"{k} {c[k]} on {gname} {ground} is {r:.2f}:1, under {floor}:1"))

    for k in C_WORDS:
        hold(k, g, "the terminal ground", FLOOR)
    for k in BAND_WORDS:
        for b in C_BANDS:
            hold(k, c.get(b), b, FLOOR)
    for d in C_UNDER_TEXT:
        hold("text", c.get(d), d, FLOOR)
    # A diff tint must stand off the ground, or changed lines don't show;
    # a changed word's tint off it further than its line's.
    for d, floor in DIFF_FLOORS.items():
        if d in c:
            r = ratio(c[d], g)
            if r < floor:
                out.append((d, f"{d} {c[d]} is {r:.2f}:1 on the terminal ground, under {floor}:1: changed lines won't show"))
    for b in C_BANDS + ["selectionBg"]:
        if b in c:
            r = ratio(c[b], g)
            if r < BAND_FLOOR:
                out.append((b, f"{b} {c[b]} is {r:.2f}:1 on the terminal ground, under {BAND_FLOOR}:1: the band won't show"))
    for word, line in (("diffAddedWord", "diffAdded"), ("diffRemovedWord", "diffRemoved")):
        if word in c and line in c and ratio(c[word], g) <= ratio(c[line], g):
            out.append((word, f"{word} {c[word]} stands off the ground no further than {line} {c[line]}"))
    for k in C_GRAPHIC:
        hold(k, g, "the terminal ground", GRAPHIC)
    for chip in C_CHIPS:
        if chip in c:
            r = ratio(c["inverseText"], c[chip])
            if r < FLOOR:
                out.append(("inverseText", f"inverseText {c['inverseText']} on {chip} {c[chip]} is {r:.2f}:1, under {FLOOR}:1"))
    return out


def claude_failures() -> tuple[list[str], list[str]]:
    """(failures, the FOAM_LIMITS entries seen failing). --check fails when
    the first list is not empty; the second is only reported."""
    bad, limits = [], []
    for table, label in ((EXACT, "exact"), (FOAM, "foam")):
        unknown = sorted(set(table) - set(CLAUDE_TOKENS))
        if unknown:
            bad.append(f"{label} themes: tokens Claude Code does not know: " + ", ".join(unknown))
        missing = sorted(set(CLAUDE_TOKENS) - set(table))
        if missing:
            bad.append(f"{label} themes: no value for " + ", ".join(missing))
    for v in FOAM.values():
        m = re.fullmatch(r"ansi256\((\d+)\)", v)
        if m and m.group(1) not in TERM_TINTS:
            bad.append(f"foam: {v} is not a slot seamux tints per mode (TERM_TINTS)")
        elif not m and v not in ANSI:
            bad.append(f"foam: ansi:{v} is not one of the 16 slot names")
    if bad:
        return bad, limits
    found = set()
    for file, name, base, theme_mode in CLAUDE_THEMES:
        over = claude_theme(name, base, theme_mode)["overrides"]
        foam = theme_mode is None
        for mode in ("dark", "light") if foam else (theme_mode,):
            for k, why in theme_failures(over, mode):
                if foam and f"{k} {mode}" in FOAM_LIMITS:
                    found.add(f"{k} {mode}")
                else:
                    bad.append(f"{name} ({mode}): {why}")
    for gone in sorted(FOAM_LIMITS - found):
        bad.append(f"seamux foam: '{gone}' is in FOAM_LIMITS but passes now: drop it (and from the README)")
    return bad, sorted(found)


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
    for file, want in wanted_themes().items():
        path = THEMES / file
        rel = str(path.relative_to(ROOT))
        if (path.read_text() if path.exists() else "") != want:
            stale.append(rel)
            if not check:
                THEMES.mkdir(exist_ok=True)
                path.write_text(want)
    if check:
        weak = contrast_failures()
        claude_bad, limits = claude_failures()
        weak += [f"Claude theme {w}" for w in claude_bad]
        if limits:
            print("theme sync: seamux foam's known limits (seamux-mods README): " + ", ".join(limits), file=sys.stderr)
        for w in weak:
            print(f"theme sync: contrast: {w}", file=sys.stderr)
        if stale:
            print("theme sync: out of date, run python3 tools/theme_sync.py: " + ", ".join(stale), file=sys.stderr)
        if stale or weak:
            return 1
        print(f"theme sync: {len(TARGETS)} pages and {len(CLAUDE_THEMES)} Claude themes match theme/everforest.css; every text token, role word and terminal word slot is {FLOOR}:1 or better, every role fill {GRAPHIC}:1")
        return 0
    print(f"theme sync: wrote {len(stale)} of {len(TARGETS) + len(CLAUDE_THEMES)} files" + (": " + ", ".join(stale) if stale else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
