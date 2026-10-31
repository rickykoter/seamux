# 0049. A workspace is a registry record (id, title, folder); each pane is its own tmux session tagged with SEAMUX_WORKSPACE_ID

Date: 2026-10-31

## Status

Accepted

## Context

You asked to keep the idea of a workspace. One tmux session per pane is what the app's terminal already attaches to and draws.

## Decision

A workspace is a registry record (id, title, folder); each pane is its own tmux session tagged with SEAMUX_WORKSPACE_ID

## Consequences

A workspace holds several panes, its folder is not its id, and it can be renamed. The board's rows and the Dock's grouping read the registry under tmux and cmux's workspace.list under cmux, through the same Backend trait.
