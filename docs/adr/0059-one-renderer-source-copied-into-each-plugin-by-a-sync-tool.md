# 0059. One renderer source, copied into each plugin by a sync tool

Date: 2026-11-01

## Status

Accepted

## Context

Plugins cannot import across their roots (ADR 0004), and installs copy each plugin folder whole. tools/theme_sync.py already solves the same problem for the palette.

## Decision

The map's renderer has one source, `shared/plan-map.js`. `tools/map_sync.py` copies it byte for byte into `deep-plan/lib/plan-map.js` and `lookout/page/plan-map.js`, the files each plugin actually loads.

## Consequences

`shared/plan-map.js` is the file to edit, then run `python3 tools/map_sync.py`. The `map-sync` recipe (`python3 tools/map_sync.py --check`) fails when a copy drifts. Each plugin still installs as one self-contained folder, which ADR 0004 requires.

## Alternatives considered

- Lookout reads deep-plan's installed copy at run time, which breaks when only one plugin is installed.
- Two hand-kept copies.
