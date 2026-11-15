# 0098. Recipes report a fixed vocabulary, and the Lookout tab draws one landing view from it

Date: 2026-11-15

## Status

Accepted

## Context

(context not recorded)

## Decision

per-recipe UI is where a general framework gets expensive; stage times, the live version and links cover deploy time, what is live and a rollout notebook

## Consequences

a recipe's outputs are stages (from its steps), version {expect, live} and links [{label, url}]; the Land stage draws nothing else; a recipe that needs more puts it behind a link
