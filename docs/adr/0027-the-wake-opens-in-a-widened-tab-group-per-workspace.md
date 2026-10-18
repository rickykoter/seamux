# 0027. The Wake opens in a widened tab group per workspace, not in the Dock

Date: 2026-10-18

## Status

Accepted

## Context

The Wake opened in a Dock tab, and what it opened went into a second one. The person wanted both to take most of the screen, about 80%. cmux has no supported way to widen the Dock. Its width (`fileExplorer.width`) is read from user defaults once, at launch. `sidebar.rightMaxWidth` is only a cap. `resize-pane` answers "Pane not found" for a Dock pane. Main-area panes do resize: `resize-pane -L --amount` moves a divider by points, but only the divider of the nearest split holding that pane on its right side, and it never passes the rest on to the next one.

The Dock tab also never came forward. `_dock_tab`, `open_plan`, `open_ask` and `crew-board usage` called `cmux focus --surface`, a command this cmux does not have. The failure was logged and then reported as "focused".

## Decision

The Wake opens in a browser split at the right of the workspace in front, cut from its rightmost pane. Each open, `_wake_tab` focuses it and widens it to `WAKE_SHARE` (0.8) of the main area. Widening first moves the pane's own left divider. Once that divider is spent, it moves the left divider of each pane beside it, nearest first, which is the divider of the split that holds both. A pass that moves nothing ends it. The Wake's view (the files, reviews and pages it opens) is a second tab in the same pane. That pane is the workspace's Wake tab group, and only the Wake and its view open there. Each workspace has its own group, kept in `wake-surface-<tab>-<workspace id>`. A group in another workspace is left alone, and a tab dragged out of the group stays where it was put while the next open goes to the group. The single Dock tab an older crew kept is closed and its file dropped. A row's Wake first switches to that row's workspace (`workspace select`), so it opens where the row's work is. That is also the only workspace with frames to widen, since one off screen has none. The workspace in front is read from `tree --json`'s `active`, because `current-workspace` answers for the caller and stays there after a select. `active` follows a select only a moment later, and a new pane or a resize shows in `list-panes` only a moment later too, so `_settle` waits up to 1.5s for each, and fakecmux lags the same way. Focus goes through `focus-panel --panel`, which works on Dock tabs too.

## Consequences

The Wake takes room from the panes beside it, and the next click takes it again if they were widened by hand in between. The Dock and the other Dock tabs (board, usage, plans, asks) keep their place. A plan the Wake opens now lands in the Wake's view tab rather than the plan's own Dock tab. When cmux grows a way to set the Dock's width, this can move back into the Dock. fakecmux models the split tree, and `crew/tools/wake_split_probe.py` holds the widening to 80% through nested splits.
