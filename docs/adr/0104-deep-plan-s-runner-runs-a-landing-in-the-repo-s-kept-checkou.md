# 0104. deep-plan's runner runs a landing in the repo's kept checkout, detached from the app

Date: 2026-11-15

## Status

Accepted

## Context

(context not recorded)

## Decision

one step engine (timeouts, exports, claims) for checks and landings; the kept checkout is what the person runs from, never a feature worktree; seamux's own recipe restarts the app mid-landing

## Consequences

a new deep-plan land verb resolves, runs and records; the app starts it as a detached process and reads its state file; a landing outlives an app restart; the kept checkout must be clean and on its default branch, or the recipe's first step fails and says so
