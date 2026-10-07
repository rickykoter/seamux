# 0009. The human runs acquire steps; the engine starts at wait

Date: 2026-10-07

## Status

Accepted

## Context

Acquiring a variant pushes a branch, creates a channel or starts a remote run. Those act outside this machine, so the engine never performs them. `check run` stops at an acquire step, prints the command for the human, and continues with `check run --from wait` once the variant exists.

## Decision

The human runs acquire steps; the engine starts at wait

## Consequences

Every remote e2e check has one human step per run, even with a `go` in hand, so remote QA is never fully unattended. The surfaces label acquire steps with what they would do. Waiting on a deploy and running tests against it are automated, since they read remote state rather than change it. A later plan can relax this per recipe only by superseding this record.
