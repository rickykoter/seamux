# 0048. The tmux backend owns its own tmux socket and a registry under $XDG_STATE_HOME/seamux

Date: 2026-10-31

## Status

Accepted

## Context

The ownership is clean, and we stay off cmux's private ~/.cmux/local-tmux file format, which we don't control.

## Decision

The tmux backend owns its own tmux socket and a registry under $XDG_STATE_HOME/seamux

## Consequences

A session started on the tmux backend is not visible to cmux later. The registry (workspaces.json) is written under a lock with an atomic rename. A pane whose tmux session has gone is dropped when the registry is read.
