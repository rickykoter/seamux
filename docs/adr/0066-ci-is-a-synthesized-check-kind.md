# 0066. CI is a synthesized check kind

Date: 2026-11-02

## Status

Accepted

## Context

The human chose to put CI behind the same gate as every other proof, so done waits on a green PR the way it waits on a test

## Decision

CI is a synthesized check kind

## Consequences

A `ci` check takes no recipe, like `review`. Its run reads the branch's PR through gh, fails at once when the PR head is not local HEAD ("push first"), and otherwise polls `gh pr checks` until none is pending or its timeout passes. A failure names each failing check and prints the failed job's log tail, so fix-until-green has its input. It fits an auto plan whose between step is draft-pr.
