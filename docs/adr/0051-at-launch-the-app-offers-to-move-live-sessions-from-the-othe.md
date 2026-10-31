# 0051. At launch, the app offers to move live sessions from the other backend onto the one it picked

Date: 2026-10-31

## Status

Accepted

## Context

You asked for a migrator that runs at startup based on the backend picked, so switching backends doesn't strand running sessions.

## Decision

At launch, the app offers to move live sessions from the other backend onto the one it picked

## Consequences

A cmux native session moves to the tmux backend in place: the registry records its pane with its own socket and keeps cmux's workspace and surface ids as the SEAMUX ids, so the running Claude and its hooks keep their keys. A tmux-backend session moves to cmux by resume: Claude starts again with --resume in a new cmux native session, and the old tmux session closes once the new one is up. A working session is never moved; the prompt waits until it is idle. Each move is confirmed by the person. crew apply does not migrate.
