# 0089. A panel review is one lead, three dimension finders and one skeptic per blocker or major finding, capped at ten agents

Date: 2026-11-11

## Status

Accepted

## Context

lookout's rule was one fresh reviewer per review, so the reviewer is never the context that wrote the change. A panel keeps that rule: every agent in it is fresh.

## Decision

the lead keeps everything today's reviewer writes (notes, edges, quiz), the finders add depth on correctness, security and performance with smells, and a skeptic that tries to refute each serious finding stops a plausible but wrong one from holding the gate

## Consequences

the one-reviewer rule becomes one fresh review run: a single reviewer or a panel; findings a skeptic refutes are dropped and listed in the run's result for the human; a survivor is marked CONFIRMED; past five serious findings the rest stay PLAUSIBLE and the run says how many went unchecked
