# 0111. The app and crew-listen share one rule for when crew-sync may start: a public claim function in crew-cli's listen.rs

Date: 2026-11-22

## Status

Accepted

## Context

(context not recorded)

## Decision

crew-listen's due check and stamp write already hold the rule: the shared sync-stamp, CREW_SYNC_INTERVAL, and crew being off. A second copy in the app could drift and run crew-sync twice as often.

## Consequences

crew-listen's reconcile and the app's watcher both call it, so a change to the throttle, the stamp or the crew-off rule changes both at once. The Stop hook's sync_maybe keeps its own copy for now and reads the same stamp.
