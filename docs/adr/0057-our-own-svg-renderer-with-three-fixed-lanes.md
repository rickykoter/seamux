# 0057. Our own SVG renderer with three fixed lanes

Date: 2026-11-01

## Status

Accepted

## Context

The lanes (used by, the plan, uses) are the layout, so no graph engine is needed. Hover and click behaviour, and the fact pins on each card, are ours to control. Lookout can carry the same file.

## Decision

The map is drawn by our own SVG renderer in three fixed lanes: what uses the plan's files, the plan's files, and what they use. It is plain browser JavaScript with no dependency, builds every node with DOM calls, and brings its own styles from the shared `--ef-*` palette, so a page only loads it and calls `PlanMap.mount(el, model, opts)`. Hover lights a card's links, a click fills a panel with its facts and contracts, chips filter by increment, and the options let lookout recolour cards by how the diff compares.

## Consequences

About 500 lines of client code, shared by two plugins (see 0059). In a dense plan (more than 14 cards) a folder with more than four cards folds to one row until it is clicked. Mermaid stays for the hand-written diagrams, and no new library is vendored.

## Alternatives considered

- Generate a mermaid flowchart into the existing diagram card.
- Vendor elkjs 0.9.3 (1.6 MB, EPL-2.0) for layout, as floorplan does.
