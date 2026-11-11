# 0092. Scouts return candidates in spec shape, and render still checks every citation

Date: 2026-11-11

## Status

Accepted

## Context

(context not recorded)

## Decision

a typed verdict with path:line evidence drops straight into verifiedFacts, risks or a hypothesis verdict, and nothing a scout says skips the render's evidence check

## Consequences

scout.js writes nothing and returns candidates; the agent still places each one in the spec, and an unconfirmed claim lands in risks
