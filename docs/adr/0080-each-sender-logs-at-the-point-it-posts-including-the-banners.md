# 0080. Each sender logs at the point it posts, including the banners it skips

Date: 2026-11-08

## Status

Accepted

## Context

On cmux the hooks post through Hook::notify, and triage then strips the banner and sound from crew:turn. On tmux, Hook::notify is a no-op and the app's notifier holds, merges and skips banners itself. resume_watch posts on both backends. The person asked for skipped banners in the log, greyed.

## Decision

Only the sender knows whether a banner reached the screen. On tmux the hooks post nothing and the app's notifier posts everything, so logging at both points never counts a banner twice.

## Consequences

Hook::notify logs every call. crew:turn is logged as not shown, since cmux shows no banner for it. The tmux notifier logs one entry per pane before merge, so "3 agents finished" is three entries. A banner skipped because its pane was on screen is logged as not shown. A finish superseded by a question, or followed by more work, is not logged. A reminder skipped while you look is not logged, since it would retry every tick. crew-sync and the other cmux senders stay unlogged.
