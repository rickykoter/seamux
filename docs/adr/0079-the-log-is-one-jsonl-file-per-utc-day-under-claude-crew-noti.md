# 0079. The log is one JSONL file per UTC day under ~/.claude/crew/notifications, written like state history

Date: 2026-11-08

## Status

Accepted

## Context

Notifications are posted by short-lived hook processes on cmux and by the app on tmux, so no single process can hold the log in memory. The board, crew-digest and the app's palette all need to read it. Clearing ~/.cache/cmux-crew should not erase what you were told.

## Decision

Several processes write it (every hook, the app), and history.rs already shows how to do that without locks: one append under 512 bytes is atomic. ADR 0024 puts durable crew state in ~/.claude/crew, and the person chose it over the cache folder.

## Consequences

A new crew-core module, notifications.rs, owns the format: record, read_since and prune, with a 14-day keep. A line over 512 bytes has its body cut. Readers skip lines they cannot parse. CREW_NOTIFICATIONS_DIR points tests elsewhere. The app prunes it hourly beside history.
