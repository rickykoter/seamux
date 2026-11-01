# 0054. Draw the map from the spec plus one hop of neighbours, frozen at render

Date: 2026-11-01

## Status

Accepted

## Context

A map of only the plan's own files is the file tree the page already has. The value is seeing what touches the change. Neighbours are found once, when the plan renders, and stored in state, so rehydrate stays byte-identical after the planned files appear on disk.

## Decision

A plan's End state map is drawn from its spec plus one hop of neighbours, and is built once, at render. `deep-plan/lib/map.mjs` makes one card per planned path (its increments, whether it is new, modified or removed, the facts that cite it, the contracts placed on it) and finds the files that reference it (used by: one `git grep` over tracked code with lookout's reference forms) and the files its own imports name (uses). Each side keeps six and counts the rest; paths that do not exist are dropped, and outside a git repo the map says why it has no neighbours. Render stores the model as `st.map` and writes `~/.claude/plans/<slug>.map.json`.

## Consequences

Plan state gains a `map` field. Every surface draws from that stored field and never reads the repo again, so `rehydrate` stays byte-identical after the planned files appear on disk. A re-render refreshes the neighbours; rehydrate never does. A whole-codebase map stays out of scope. The data stays portable for later multiplayer planning: it lives in state (share and export carry it), paths are repo-relative, and a card's id is its path.

## Alternatives considered

- Spec data only, with no neighbours: the plan's file tree, which the page already had.
- A full floorplan-style scan of the repo into parts.
