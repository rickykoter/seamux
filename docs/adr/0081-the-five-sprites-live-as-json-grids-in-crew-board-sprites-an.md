# 0081. The five sprites live as JSON grids in crew/board/sprites/, and one generator, seamux sprites, writes both the board's sprite sheets and the app's module from them, each with a --check. seamux cat_poses and its --from-swift link to crew.swift go.

Date: 2026-11-08

## Status

Accepted

## Context

ADR 0020 made the board's cat a copy of crew.swift's, with board-only poses added beside it. The new sprites are drawn on 2px cells and have frames the Swift sidebar never had, and cmux (the sidebar's host) is being phased out.

## Decision

Today the same cat is drawn twice and only the board copy is checked. One source with generated copies means a sprite change lands everywhere or the probe fails.

## Consequences

Supersedes ADR 0020. The Swift sidebar keeps today's 3px cat and nothing checks it against the board any more. A sprite change is an edit to its JSON and a run of seamux sprites; board.html's sprite block and app/ui/sprites.gen.ts are never edited by hand.
