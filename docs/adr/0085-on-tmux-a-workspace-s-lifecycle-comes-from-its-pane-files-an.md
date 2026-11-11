# 0085. On tmux, a workspace's lifecycle comes from its pane files and the Claude process on each pane's terminal

Date: 2026-11-11

## Status

Accepted

## Context

workspaces.rs reads cmux's sessions_list, sidebar_state and tree for lifecycle and busy. On tmux all three are missing, so archive and crew-reclaim refuse every open workspace.

## Decision

cmux's session records and sidebar are the only sources today, so the tmux backend answers unknown and reclaim and archive refuse. Pane files already carry each agent's state, and tmux can name each pane's terminal for the process check.

## Consequences

Running means a pane file says working or needs_input and a claude process still runs on that pane's terminal. Idle means Claude runs and no pane file says it is mid-turn. None means no pane runs Claude. Unknown means tmux did not answer, and the guards still refuse on unknown. A hook that never wrote its state (a timed-out prompt hook) reads as idle, so the reclaim wizard's own y/N stays the last guard.
