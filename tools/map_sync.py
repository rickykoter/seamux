#!/usr/bin/env python3
"""Copy the End state map's renderer (shared/plan-map.js) into each plugin.

    python3 tools/map_sync.py           write each copy that is out of date
    python3 tools/map_sync.py --check   exit 1, naming each copy that differs

Plugins cannot import across their roots (ADR 0004), and an install copies
each plugin folder whole, so each one carries the renderer as its own file.
shared/plan-map.js is the file to edit; the copies match it byte for byte.
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "shared" / "plan-map.js"
TARGETS = [
    "deep-plan/lib/plan-map.js",
]


def main(argv: list[str]) -> int:
    check = "--check" in argv
    src = SOURCE.read_bytes()
    stale = []
    for rel in TARGETS:
        dest = ROOT / rel
        if dest.exists() and dest.read_bytes() == src:
            continue
        stale.append(rel)
        if not check:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(src)
    if check:
        for rel in stale:
            print(f"map_sync: {rel} differs from shared/plan-map.js (run python3 tools/map_sync.py)")
        return 1 if stale else 0
    for rel in stale:
        print(f"map_sync: wrote {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
