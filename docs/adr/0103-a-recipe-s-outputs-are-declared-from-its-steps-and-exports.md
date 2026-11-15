# 0103. A recipe's outputs are declared from its steps and exports

Date: 2026-11-15

## Status

Accepted

## Context

(context not recorded)

## Decision

scripts stay plain shell that print a value; a step's stage label is timed by the engine and an outputs block maps exported variables onto the vocabulary

## Consequences

outputs reference exports as $NAME, and MERGE_SHA, PR and REPO are set for every step; a step with no stage is not drawn; a script that wants more stages splits into steps
