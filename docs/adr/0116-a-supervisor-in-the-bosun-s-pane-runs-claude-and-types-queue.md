# 0116. A supervisor in the Bosun's pane runs Claude and types queued work into it when idle

Date: 2026-11-22

## Status

Accepted

## Context

Auto-resume, the morning reset, Ask-the-Bosun questions and scheduled loops all need something that watches the clock and the Bosun's idle state. The pane already outlives the app.

## Decision

It lives in the tmux server, so resume, the morning reset, questions and loops keep working while the app is closed or restarting.

## Consequences

The pane runs `seamux bosun run`, not claude. It restarts Claude with --resume when it exits, and types the next queue item only while the pane file says idle. The app shows the pane and never drives it. Stopping the Bosun is `seamux bosun stop`.
