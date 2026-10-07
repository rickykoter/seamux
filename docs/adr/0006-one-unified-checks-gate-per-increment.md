# 0006. One unified checks gate per increment

Date: 2026-10-07

## Status

Accepted

## Context

deep-plan gated `done` only on per-deliverable observability checks; the per-deliverable `verification` list was display-only and never enforced, so increments closed on the agent's word.

## Decision

One unified checks gate per increment

## Consequences

Spec authors write `deliverables[].checks`; the legacy `observability.checks` and `verification` fields are still read and turned into checks, so old specs keep rendering. State moves from `inc.obs` to `inc.checks`, with `obs` kept as an aggregate in `status --json` for one release so the seamux-mods pane keeps working. `deep-plan obs` stays as an alias for observability-kind checks. Every later gate feature extends this one list instead of adding a verdict of its own.
