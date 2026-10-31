# 0053. bash-guard reports a block by writing blocked-<key>.json into crew's state folder, and the app's notifier posts it

Date: 2026-10-31

## Status

Accepted

## Context

bash-guard can only alert through cmux notify today, and ADR 0004 keeps plugins from calling each other, so a file is the handoff.

## Decision

bash-guard reports a block by writing blocked-<key>.json into crew's state folder, and the app's notifier posts it

## Consequences

Under tmux, a blocked command raises a macOS notification while the app runs. Under cmux, bash-guard keeps using cmux notify and writes no file. The app deletes each file once it has posted it.
