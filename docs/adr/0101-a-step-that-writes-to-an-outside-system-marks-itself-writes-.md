# 0101. A step that writes to an outside system marks itself writes: true, and a recipe's first writing run waits for the person's approval

Date: 2026-11-15

## Status

Accepted

## Context

deep-plan's observability rule says the plan never writes to a live API and the human imports or clicks. A land recipe is not the plan or the agent: it is code the project committed, run by the engine.

## Decision

a committed recipe is the developer's reviewed code, like a claim step, so it may create a notebook or start a deploy; the person still sees the first write before it happens

## Consequences

the approval is kept per repo and recipe, keyed by a hash of the recipe, so an edited recipe asks again; a skipped approval leaves that recipe skipped for the merge; the agent never approves
