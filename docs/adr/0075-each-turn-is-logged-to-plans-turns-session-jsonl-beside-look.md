# 0075. Each turn is logged to plans/turns/<session>.jsonl beside lookout's reviews

Date: 2026-11-06

## Status

Accepted

## Context

(context not recorded)

## Decision

the Wake's indexers read stores, not git; one line per turn with the root, the prompt's first 120 characters, both shas and the changed-file count lets them build rows without walking refs in every repo

## Consequences

lookout writes a log that crew reads, across a plugin boundary, so its fields are a contract both indexers parse; a line is appended only on Stop, and a turn whose start was never taken is not logged.
