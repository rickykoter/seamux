# 0016. Only the human closes a finding unless the plan opts the agent in

Date: 2026-10-09

## Status

Accepted

## Context

A gate that passes on the agent's word about its own fixes is the failure ADR 0006 removed. The agent may reply and mark a finding addressed; a click on the page moves it to resolved or dismissed. You asked to allow the agent to close findings too when a plan says so at planning time.

## Decision

Only the human closes a finding unless the plan opts the agent in

## Consequences

A finding has four states (open, addressed, resolved, dismissed); `lookout resolve|dismiss` from the CLI is refused unless the review's policy says agentMayClose, which only a plan's top-level `review.agentMayClose` (or `lookout open --agent-may-close`) sets; the page shows who closed each finding.
