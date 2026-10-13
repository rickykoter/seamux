# 0020. New cat poses are board-only, drawn as ASCII grids in cat_poses.py

Date: 2026-10-13

## Status

Accepted

## Context

board.html's cat is generated from crew.swift by cat_from_swift.py, and the probe fails if the two drift. New reactions (hop, stretch, perk, blink, tail flick) need new frames.

## Decision

New cat poses are board-only, drawn as ASCII grids in cat_poses.py

## Consequences

The six shared poses stay generated from crew.swift and keep their --check. Board-only poses live in crew/board/cat_poses.py as ASCII grids, generated into a second marker block in board.html with their own --check. The two cats can now diverge, and the sidebar will not show the new reactions unless someone ports them later.

As built, that second block sits inside the cat's own svg, so the new poses walk, turn and bob with the shared ones; cat_from_swift.py emits it empty, keeps its contents when it rewrites the sprite, and leaves it out of its --check.
