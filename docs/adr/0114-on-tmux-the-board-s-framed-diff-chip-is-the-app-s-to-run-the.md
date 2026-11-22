# 0114. On tmux, the board's framed diff chip is the app's to run: the app makes the review, brings the workspace forward and opens it in the Dock's side column

Date: 2026-11-22

## Status

Accepted

## Context

crew-board state.rs drops the diff chip on tmux because lookout's page, made from the intent server, has no pane to show beside. lookout's seamux host lists reviews in the Dock per pane, and the server is not one.

## Decision

You chose the Dock beside the terminal. The board's server has no pane, so a review it makes is listed nowhere anyone is looking. The app already takes the reclaim chip this way: the framed board posts a message, and the app acts in its own window.

## Consequences

The Dock advertises diff in the capabilities it sends the framed board, and intent.js posts {crew: diff, ws} for that chip. The app runs lookout through crew-board in-process, reads the review id from lookout open --json, selects the workspace and opens /review/<id> in its sheet. A board outside the app on tmux still gets the chip; its server makes the review and says it shows in the app's Dock.
