# 0036. The pane is the unit of agent status, rolled up in one place

Date: 2026-10-28

## Status

Accepted

## Context

Hooks wrote lane-<ws>, question-<ws>, asked-<ws> and the phase: token per workspace. crew sync read one active session per workspace. The app's wall read per pane, but its timeline, Desk and mosaic matched the first tile in a workspace. With two Claudes, or a Claude and a terminal, these disagreed.

## Decision

The pane is the unit of agent status, rolled up in one place

## Consequences

A pane's hooks write only its own ~/.cache/cmux-crew/pane-<surface>.json, under one lock, with a hold-<surface> marker beside it while a tool use has something to release. crew_core::status::rollup is the only code that turns panes into a workspace state (waiting > working > idle > ended). The roll-up keeps the workspace files older readers use (question-<ws>, its .json and asked-<ws>) in step, and the hook sets the lane and the phase: token from it. crew sync and the feed read every session of a workspace from cmux's session store, and sync prunes pane files whose workspace or Claude is gone. A new reader calls the roll-up rather than reading markers. The human chose this over history-as-source and over suffixing the old files.
