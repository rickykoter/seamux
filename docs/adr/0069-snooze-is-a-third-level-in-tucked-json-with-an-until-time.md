# 0069. Snooze is a third level in tucked.json, with an until time

Date: 2026-11-06

## Status

Accepted

## Context

Snooze needs a durable per-worktree record that survives app and cmux restarts (ADR 0024 puts durable crew state in ~/.claude/crew). tucked.json holds one entry per worktree root with a level, and only the app writes it.

## Decision

tucked.json is already the per-worktree store the app writes and the board reads; a level beside mute and tuck reuses its lock, its atomic save and the board's reader instead of starting a second store

## Consequences

A worktree has at most one level, so snoozing a muted row replaces the mute. Only the app and its Rust board read the file; the Python board never has and does not start. An older app that meets a snooze entry skips it (serde refuses the level) and drops it on its next save; an older board ignores it. The entry gains an optional until field, in ms since the epoch, that only snooze uses.
