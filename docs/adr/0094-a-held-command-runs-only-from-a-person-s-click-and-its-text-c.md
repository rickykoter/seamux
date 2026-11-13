# 0094. A held command runs only from a person's click, and its text always comes from held-<pane>.json

Date: 2026-11-13

## Status

Accepted

## Context

When bash-guard refuses a command in a pane of the app's tmux, the person can run it themselves. The app types `!cmd` into Claude's prompt, which runs the command in bash mode, and no PreToolUse hook sees that. So the click is the whole approval. ADR 0041 already keeps pages from typing into a session except through the plugin's server.

## Decision

A held command runs only from a click in the pane's banner or on its Dock card. Its text is always read from held-<pane>.json at that moment. The board page and the Dock pass only the pane and the record's time, and the app reads the command again before it types anything. A page can't make the app run text it chose.

## Consequences

A Dock click names a record, never a command. If the pane no longer holds that record, or holds a newer one, the click does nothing and says why. bash-guard writes times in whole seconds, so the banner also checks that the command matches the one it showed. The app's own UI is the only thing that types.

Alternatives considered: posting the command text in the board's message; having the intent server type it as an ask option.
