# 0033. Close paths refuse a workspace that holds live family work; only a human at a terminal overrides

Date: 2026-10-24

## Status

Accepted

## Context

Closing a parent or child workspace mid-family loses the session that holds the work, and today nothing stops it. The human chose refuse-with-override over confirm-only and over hiding from the sweep.

## Decision

Close paths refuse a workspace that holds live family work; only a human at a terminal overrides

## Consequences

archive, the board's archive and reclaim chips, crew-reclaim (even with --yes), crew-sweep's candidates, crew-resume's ^A and `workspaces.py close` all refuse a workspace whose directory deep-plan says is protected, and the refusal names the plan and family. `--family-ok` is the override: it needs an interactive y/N that names the family, is refused without a tty, and is logged. The board chips never pass it, so a chip on a protected workspace only refuses and says why.
