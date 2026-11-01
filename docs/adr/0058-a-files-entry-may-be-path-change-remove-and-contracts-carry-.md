# 0058. A files[] entry may be {path, change: 'remove'}, and contracts carry an optional at

Date: 2026-11-01

## Status

Accepted

## Context

The spec cannot say today that a file goes away or where a contract lives. Authors may keep writing plain strings. Render normalises the archived spec to {path, change} objects, but change stays null unless the author declared it. Everything render infers (new or modify, neighbours, facts and contracts per file) lives in plan state, not the spec. A contract with no at goes in an unplaced tray.

## Decision

A deliverable's `files[]` entry is a path, or `{ "path": ..., "change": "remove" }` for a file the increment deletes. A contract may carry `at`, a list of repo-relative paths where it lives. Render archives every files entry as `{path, change}`, with `change` null unless the author declared it, and never rewrites the author's spec file. `planFiles(d)` in `deep-plan/lib/state.mjs` is the one reader of `deliverables[].files`.

## Consequences

The archived spec holds only what the author said, in one shape. What render infers lives in `st.map`, not the spec. Whether a path is new or modified is decided by the commit the plan's first increment started from, recorded once in the map so a reset or a later `go` cannot move it; before any `go`, the first render's look at the disk is kept. A removal must be cited by a fact, which also catches a mistyped path. Each `at` must name a path a deliverable lists or a fact cites; a contract with no `at`, or whose `at` names a file with no card, sits in the map's unplaced tray.

## Alternatives considered

- Write the inferred new or modify into the archived spec.
- Keep plain strings in the archived spec.
- A separate removes[] list on each deliverable.
- Infer everything: never draw removals, and place contracts by fuzzy-matching their surface text.
