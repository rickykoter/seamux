# 0071. Typing continue unattended follows ADR 0003's read, type once, confirm rule

Date: 2026-11-06

## Status

Accepted

## Context

Wall::reply types any text after checking only that an agent is present. The resume watcher types with nobody watching, possibly hours after the stop, into a session the person may have moved on from.

## Decision

ADR 0003 says any page-to-session action, free text included, reads the screen before typing and again after as proof, and never sends Enter blind; an unattended resume is the riskiest case of that rule, so it follows it rather than Wall::reply's unverified path

## Consequences

The watcher types only into the pane and session recorded at the stop, only into a worktree armed in resume.json, and only when the screen shows no turn running and no question. It types the text once, presses Enter once, and counts the resume as landed only when the pane's own hook writes working within 30 seconds. A failed or unconfirmed resume is never retried blind: it notifies and leaves the row stopped.
