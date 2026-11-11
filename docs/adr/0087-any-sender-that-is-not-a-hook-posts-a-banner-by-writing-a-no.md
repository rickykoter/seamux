# 0087. Any sender that is not a hook posts a banner by writing a note-<id>.json file that the app's notifier posts

Date: 2026-11-11

## Status

Accepted

## Context

crew-sync's PR banner, the digest's --notify and cachefacts' stale-cache warning post through cmux notify, which does nothing on tmux.

## Decision

You chose one general handoff. bash-guard's blocked-<key>.json (ADR 0053) already works this way, and the notifier keeps its merging, its on-screen skip and the notifications log (ADR 0080).

## Consequences

One helper in crew-core posts through cmux notify on the cmux backend and writes a note file on tmux. A note carries kind, title, body, and ws and pane when known. The notifier reads, posts and deletes each file once, and deletes unreadable ones so they are never retried. blocked-<key>.json stays as it is.
