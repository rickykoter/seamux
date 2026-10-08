# 0011. The family guard never refuses: an edit into a sibling's claim is allowed, the agent sees a factual note through `additionalContext`, and the trespass is recorded on the family

Date: 2026-10-08

## Status

Accepted

## Context

Workstreams are meant to run unattended in parallel. A hard refusal would stop an agent until a person intervenes, which is the failure the family exists to avoid. The human asked for a soft guard.

## Decision

The family guard never refuses: an edit into a sibling's claim is allowed, the agent sees a factual note through `additionalContext`, and the trespass is recorded on the family

## Consequences

Overlap is discouraged, not prevented, and a determined or careless agent can still edit a sibling's files. What the guard guarantees is that the overlap is seen, by the agent at edit time and by the owner and the human afterwards. Bash writes are not inspected at edit time, so `family check` (a git diff against each sibling's claims) is the backstop. A future `strict` flag would be a new decision, not a config tweak.
