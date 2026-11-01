# 0056. A plan may auto-go its increments: `done` gives the next go when every check passed

Date: 2026-11-01

## Status

Accepted

## Context

Outside families, a person gives every increment's go, even when the step between two increments is only "commit, open a draft PR, carry on". ADR 0028 removed that bottleneck for delegated family children only. The human wanted the same for any plan, decided at planning time. Increments that need more than that step should still stop for a person.

## Decision

A spec may set `go: "auto"` (or `{ "mode": "auto", "between": "commit" | "draft-pr" }`). When `done` closes an increment and every check passed, the engine authorizes the next pending increment in the same locked write and records `by: auto`. An increment with `go: { "human": "<why>" }` stops the chain, as do a `done --force`, an increment already open, and a family child whose go is its parent's, held or waiting. The first go after the alignment check stays a person's.

We rejected the other option, letting the agent run `go next` on an auto plan. It would need an exception to the gate's rule that an agent's `go` is the human's word, which allows one per turn and none after a refusal.

## Consequences

No agent runs `go` on its own word. The gate's human-word levers (ADR 0029 and `onHumansWord`) are unchanged. `by` gains a fourth value, `auto`, shown wherever `by` already is. Render refuses an auto plan where a reviewed increment is followed by one that auto-goes, unless `review.agentMayClose` is true (ADR 0016). Otherwise the chain would wait on a person closing findings that nobody asked them to close. `between` only changes what `done` tells the agent to do before starting. The engine does not push or open PRs itself.
