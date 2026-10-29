#!/usr/bin/env python3
"""coverage — does every feature in FEATURES.md have its shot?

    python3 docs/demo/coverage.py

Reads each feature row's last column. A screenshot `S-name` must exist as
media/name.png (or docs/img/name.png); a scene `V1.4` must be a numbered row
in STORYBOARD.md. A row whose shot says "not filmed" or "FEATURES only" is
listed, not failed. Exit 1 when anything named is missing.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "..", "img")


def rows(path):
    for line in open(path, encoding="utf8"):
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and line.startswith("|") and not set(cells[0]) <= set("-") and cells[0] != "feature":
            yield cells


def main():
    board = open(os.path.join(HERE, "STORYBOARD.md"), encoding="utf8").read()
    scenes = set(re.findall(r"^\| (\d\.\d) \|", board, re.M))
    missing, skipped, n = [], [], 0
    for cells in rows(os.path.join(HERE, "FEATURES.md")):
        feature, shot = cells[0], cells[-1]
        n += 1
        if re.search(r"not filmed|FEATURES only", shot):
            skipped.append(f"{feature} — {shot}")
            continue
        named = re.findall(r"S-([a-z0-9-]+)", shot) + [f"V{v}" for v in re.findall(r"V(\d\.\d)", shot)]
        whole = re.findall(r"\bV(\d)\b(?!\.)", shot)
        if not named and not whole:
            missing.append(f"{feature}: no shot named ({shot})")
        for s in named:
            if s.startswith("V"):
                if s[1:] not in scenes:
                    missing.append(f"{feature}: scene {s} is not in STORYBOARD.md")
            elif not any(os.path.exists(os.path.join(d, s + ".png")) for d in (os.path.join(HERE, "media"), IMG)):
                missing.append(f"{feature}: media/{s}.png does not exist")
    print(f"{n} features, {n - len(skipped) - len(missing)} covered, {len(skipped)} not filmed (listed)")
    for s in skipped:
        print("  not filmed:", s)
    for m in missing:
        print("  MISSING", m)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
