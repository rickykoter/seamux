# 0071. A turn opened from the Wake is a view-only lookout review, as a commit is

Date: 2026-11-06

## Status

Accepted

## Context

(context not recorded)

## Decision

wake.rs already opens a commit row with lookout open --range --view-only; a turn row does the same with --turn, and its review id is kept out of the Wake's review rows the way wake-<sha> ids are

## Consequences

lookout open gains --turn and --since-prompt as targets beside --base, --range, --worktree and --patch, and refuses a second target. A turn review from the Wake has an id of the form wake-t<session8>-<n>, which both indexers skip.
