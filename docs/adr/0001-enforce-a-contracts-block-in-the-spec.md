# 0001. Enforce a contracts block in the spec

Date: 2026-09-15

## Status

Accepted

## Context

an advisory block (like observability) is skippable exactly when it matters; contract mistakes are the expensive, hard-to-reverse kind, so the renderer refuses a spec whose declared contract surfaces lack a linked decision

## Decision

Enforce a contracts block in the spec

## Consequences

every future spec that touches a declared schema, API, or method-signature surface must carry a contracts entry with a decisionRef or be refused; external-scope entries additionally require the linked decision to be ADR-flagged or carry an explicit written waiver; --force remains the logged escape hatch; any consumer of the spec shape (board, artifact export) sees a new optional top-level key
