# 0054. The tmux notifier holds, merges and skips banners, and a banner can answer a single-choice question

Date: 2026-10-31

## Status

Accepted

## Context

ADR 0050's notifier posted three fixed lines ("Claude is waiting on you", "Claude finished its turn", "blocked: …"). It had no question text, no way to go to the pane, and a banner for the pane already on screen. The pane-status files already hold the open question, the turn-end judgment and the review flag. On macOS the notification plugin can play a named sound, show buttons and report clicks while a banner is on screen.

## Decision

`seamux-app/src/notify_app.rs` keeps a `Notifier` that turns each second's pane states into banners:

- A waiting banner shows the question (or the turn-end judgment's text). A finished banner says whether the turn left work to review.
- A finished turn is held for 3 s (at most 10 s while others keep finishing). A question in that window replaces it, and banners of one kind that come due together merge into one ("3 agents finished").
- A pane that has waited 5 minutes gets one reminder.
- Nothing is posted about the pane whose terminal has focus while the app is in front. The page reports that pane through `notify_looking`.
- Each title starts with the workspace's crew-color as a round emoji: the registry's color, else the palette color it hashes to. Each kind has its own sound: Ping (waiting), Purr (reminder), Glass (finished), Basso (blocked or failed answer).
- A click brings the app forward on the pane (`notify:jump`). A single-choice AskUserQuestion banner also offers its options. A pick goes through crew-board's `ask::deliver`, which types the digit only when that question is still on screen and still the pane's open one.

## Consequences

Open is always the first button. macOS reports a click on the Options menu's own button as the first action, so that click must never answer.

macOS reports clicks only while the banner is on screen. Once it moves to Notification Center, a click opens nothing. Setting seamux's alert style to Persistent keeps banners, and their buttons, live.

A merged banner offers no answers, and a click on it goes to the first pane.

Under cmux nothing changes: cmux still posts its own notifications.
