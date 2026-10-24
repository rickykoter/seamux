# 0029. A delegated child cannot authorize itself, and each go records who gave it

Date: 2026-10-24

## Status

Accepted

## Context

Without an engine check, an agent in a delegated child could simply go itself. The human chose refusing self-go over recording only.

## Decision

A delegated child cannot authorize itself, and each go records who gave it

## Consequences

`go` records `by`: human when run with `--by human` (the board, Desk and pane always send it) or from a shell outside any Claude session, parent when run from a Claude Code session inside the parent's root, and self otherwise. On a delegated child, `self` is refused. The log, `status --json` (`increments[].by`) and the working page show `by`. `--by human` is honoured as given; the skill forbids an agent passing it, and every use is logged.
