# 0114. The Bosun is a registry workspace marked kind bosun, and TmuxBackend leaves it out of its lists

Date: 2026-11-22

## Status

Accepted

## Context

The tmux registry's workspace rows hold only id, title and cwd, and nothing filters them. The wall, the feed, notifications, landings, crew-sync, the migrator and the board all list them through TmuxBackend, and sync_watch reads the file itself.

## Decision

It stays an ordinary pane, so hooks, pane files and the terminal attach work unchanged. One filter where the registry is listed hides it from all of the app's readers, instead of a filter in each of them.

## Consequences

workspaces(), panes() and gone() skip kind bosun rows; bosun_row() and target() still find them. Doctor reads the raw registry, so it still checks the Bosun's pane like any other. A future reader that parses workspaces.json directly must skip the kind itself, as sync_watch now does.
