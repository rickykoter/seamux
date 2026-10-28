# 0037. A workspace is pinned to one worktree by a root: token set once

Date: 2026-10-28

## Status

Accepted

## Context

Board rows, sync's probes and plan lookups used the workspace's current_directory; tuck used the first Claude pane's root; the app's plan lookup used the plan's owner or any pane under the root. The same workspace could map to different worktrees in different views.

## Decision

A workspace is pinned to one worktree by a root: token set once

## Consequences

crew_core::worktree::create writes root:<git toplevel> into the new workspace's description; the first SessionStart in a workspace without one writes it from its cwd; nothing overwrites it. crew sync carries the token through its description rewrite. Readers use root: and fall back to current_directory only when it is missing. A pane whose cwd leaves the pinned root is marked outside. The human chose this over a durable map file and over the owner pane's cwd.
