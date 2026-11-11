# 0093. Only lookout setup moves the engine pointer; any other run warns when its copy differs from the pointer

Date: 2026-11-11

## Status

Accepted

## Context

(context not recorded)

## Decision

every verb rewrote engine.json, so a probe or manual check from a worktree silently moved every session and the app onto that worktree's engine (note n3e5ce66c)

## Consequences

a worktree's lookout runs on its own copy without touching other sessions; switching engines is lookout setup, run on purpose; a pointer whose root is gone is still rewritten so the shim keeps working
