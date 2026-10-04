# 0005. The crew plugin installs the cmux layer; it is not its runtime

Date: 2026-10-04

## Status

Accepted

## Context

A plugin's install path carries its version, so it changes on every update. cmux, launchd and the intent server need a path that does not.

## Decision

The crew plugin is the installer of the cmux layer, not its runtime. `crew apply` copies the tree from the plugin root into `~/.config/cmux/crew`, which stays the live tree for the board, intent server, launchd jobs and CLI. Claude hooks run from the plugin root via `hooks/hooks.json`; `crew-hook.sh` is already a no-op outside cmux.

## Alternatives considered

- Run in place from the plugin root, with `~/.config/cmux/crew/current` as a
  symlink `crew apply` rewrites. One copy instead of two, but every outside
  path would go through a link that moves on each update, and the drift check's
  model would move with it.

## Consequences

A plugin update is inert until `crew apply` runs again; `crew doctor` reports that as drift. Hooks and the outside-Claude processes execute from two copies of the same files, so the drift check is what keeps them one. `settings.json` carries no crew hook entries any more. With a folder marketplace the plugin root is the checkout's `crew/`, so the drift check compares exactly what it compares today: repo against live tree.

Two things implementation added. A folder marketplace's `installPath` in
`installed_plugins.json` names a cache snapshot, while Claude reads the plugin
from the folder (`claude plugin list` says "Read from"); copying the snapshot
would have installed a tree that edits never reach, so `crew/bin/crew-plugin-root`
resolves the folder. And `crew apply` run from the live tree (the way a person
types it) re-copies from the plugin first, so "run crew apply again" is all an
update needs.
