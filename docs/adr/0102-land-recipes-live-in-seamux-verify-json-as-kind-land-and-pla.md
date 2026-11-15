# 0102. Land recipes live in .seamux/verify.json as kind land, and plan checks never pick them

Date: 2026-11-15

## Status

Accepted

## Context

(context not recorded)

## Decision

one file per project says how its code is checked and how it lands, with the same nearest-file and match rules (ADR 0007) and the same step language

## Consequences

verify.mjs takes kind land with its own validation; resolution for a plan's checks skips it; a separate resolver gives a merge's land recipes; tools/probes.py already runs only kind test
