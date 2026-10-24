# 0030. A delegated child waits for its go with a blocking `deep-plan await-go`; nothing is typed into it

Date: 2026-10-24

## Status

Accepted

## Context

An idle child only hears news at its next prompt. The human chose a pull-only wait over cross-session messaging, which keeps ADR 0003 and ADR 0012 as they stand.

## Decision

A delegated child waits for its go with a blocking `deep-plan await-go`; nothing is typed into it

## Consequences

`deep-plan await-go <slug> [--timeout S]` exits 0 printing the increment number once one is authorized, 2 at its timeout (run it again), and 3 when delegation was taken back or the plan is done. A delegated child runs it in the background between increments and resumes on exit. While it waits, the child's session reads as idle to crew, so family-close-guard's protection is what keeps it from being archived. A child whose wait ended without a go (a crash or restart) also hears "increment N is authorized" in its news at the next prompt or session start. A sleeping machine loses nothing: the go is in the state file, and a timeout that fires on wake means run it again.
