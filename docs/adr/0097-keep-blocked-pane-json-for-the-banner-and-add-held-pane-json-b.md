# 0097. Keep blocked-<pane>.json for the banner and add held-<pane>.json beside it

Date: 2026-11-13

## Status

Accepted

## Context

ADR 0053 has bash-guard write blocked-<pane>.json, which the app's notifier posts as a macOS banner and then deletes. A held command has to last longer than that: until the person acts on it or the session moves on.

## Decision

On tmux, bash-guard writes two files per block. blocked-<pane>.json is unchanged and still feeds the notifier. held-<pane>.json holds the whole command (up to 16 KB), the session, the folder, the reasons, the kind and a force push's branch.

## Consequences

The notifier's take_blocked is unchanged. crew-core's held module owns held-<pane>.json. It deletes the record on Run, Dismiss or Allow, and when the pane's session changes or ends. A newer block replaces the record, and a block with nothing to offer removes it. Copy leaves it in place. Clearing only takes the record the person saw: it moves the file aside first and puts it back if it is not the one.

Alternatives considered: stop deleting blocked-<pane>.json and mark it posted; write the held command into the pane's own pane file.
