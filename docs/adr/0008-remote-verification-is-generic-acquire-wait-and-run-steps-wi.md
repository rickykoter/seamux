# 0008. Remote verification is generic acquire, wait and run steps, with provider templates

Date: 2026-10-07

## Status

Accepted

## Context

Nothing in seamux talks to Vercel, Firebase or RWX today, and provider CLIs change. The engine knows three steps: `acquire`, `wait` (poll a command until it prints a value or exits 0, with a timeout) and `run`. Values a step prints become env vars for the next step. Providers ship as templates that `verify init` copies into a recipe; they are not engine code.

## Decision

Remote verification is generic acquire, wait and run steps, with provider templates

## Consequences

Supporting a new host is a template file, not an engine release. A recipe that works today keeps working when a template changes, because the copied steps belong to the repo. The engine cannot tell a Vercel wait from any other command, so its errors are about exit codes and timeouts, never about the provider. GitHub deployments ship as one template among several, not as the integration.
