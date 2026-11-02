# 0067. A loop block expands into increments at render

Date: 2026-11-02

## Status

Accepted

## Context

Each batch of a refactor then gets the gate, checks, review and auto-go every increment already has, with no new runtime

## Decision

A loop block expands into increments at render

## Consequences

A deliverable may carry `loop: { targets: [...], batch: k }`. Render expands it into one increment per batch before validation, titled with its batch number and targets, each with the deliverable's checks, and archives the expanded spec with `loopOf` so a re-render does not expand twice. Targets that are paths join the increment's files. They are exempt from the read-before-plan floor, but at least one target must be cited by a verifiedFact.
