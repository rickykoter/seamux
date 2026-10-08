# 0010. A family is a parent deep-plan spec whose `workstreams` block names its child plans; children never name their parent

Date: 2026-10-08

## Status

Accepted

## Context

Parallel agents serving one goal had no shared artifact. The human chose artifact-first coordination over a live orchestrator agent, put the family in a deep-plan spec, and asked that existing plans be adoptable after the fact.

## Decision

A family is a parent deep-plan spec whose `workstreams` block names its child plans; children never name their parent

## Consequences

Membership is one-directional: a child cannot tell from its own spec that it belongs to a family, so every reader (gate, news hook, status) resolves membership through the parent's index. A plan belongs to at most one family; rendering a second parent that lists the same child is refused. A parent's root must not equal or contain a child's root, because the board keys plans by root and `resolveSlugAt` takes the first containing root. A future orchestrator agent reads the same index rather than inventing its own.
