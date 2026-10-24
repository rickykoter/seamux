# 0032. A family's delivery review is opt-in: with review.family, one lookout review per member must pass before the parent finishes

Date: 2026-10-24

## Status

Accepted

## Context

Each child's increments are reviewed alone, and nothing looks at the seams between them. A review per member costs a reviewer per member, so the human made it opt-in rather than always on. lookout reviews one worktree at a time, which rules out one concatenated patch.

## Decision

A family's delivery review is opt-in: with review.family, one lookout review per member must pass before the parent finishes

## Consequences

A parent spec may set `review.family: true` (default false). With it, `deep-plan deliver <parent>` waits until the family is done, then opens `<parent>-family-<member>` for each member: that member's work since its first start sha, at its root, with a context file naming the parent's contracts and who consumes them (lookout `open --context-file`). The parent stays in delivery until every review has no blocker or major open. Without it, the parent's delivery review is the one it has today.
