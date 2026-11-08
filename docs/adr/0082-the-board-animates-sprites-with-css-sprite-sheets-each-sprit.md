# 0082. The board animates sprites with CSS sprite sheets: each sprite is one generated SVG sheet of its 18 frames as a data: image, and CSS steps() picks the frame. The frame order is the same for every sprite, so one set of rules drives all five and only the background image changes with data-sprite.

Date: 2026-11-08

## Status

Accepted

## Context

The board now always runs with render.js and intent.js inlined when crew-board serves /board, so a shared JS sprite engine became possible. Today's sprite is one SVG group per pose, shown and hidden by visibility keyframes.

## Decision

The person chose to keep the board's motion script-free. render.js still sets only a mood class and at most one reaction, and the board_probe rule that the cat lives in the page holds.

## Consequences

Each move's timing is written twice, as CSS keyframes on the board and as timers in panecat.ts, and the probe holds the board's half. Sheets are data: URIs in board.html, so the page grows by tens of kilobytes.
