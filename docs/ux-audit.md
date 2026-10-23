# seamux app: UX audit

The working list for plan `seamux-ux-harden`. Each finding names its view,
how to reach it, what happens, what should happen and where the code is.
**How found** says whether it was read in the code or seen in the running
app. Each finding belongs to the increment that fixes it, and its status
changes when that increment lands.

Statuses: `open`, `fixed (inc N): what was seen`, `follow-up`.

## Terminals: history and input (increment 2)

| # | View | Steps | What happens | Should | Code | How found | Status |
|---|------|-------|--------------|--------|------|-----------|--------|
| T1 | sheet, Desk card | Scroll the wheel over a Claude pane's live terminal | Nothing moves. The wheel scrolls a div that holds exactly one screen, and the pane keeps no history on the alternate screen | Claude's transcript scrolls, as it does in cmux | `app/ui/term.ts:99` (keydown and paste only) | code, probe | fixed (inc 2): the wheel sent SGR wheel events and Claude's transcript moved 75 -> 49 and back |
| T2 | sheet, Desk card | Click inside a focused Claude terminal (a fold, a menu row) | The click only focuses. Claude never sees it, though it has SGR mouse reporting on | A focused click reaches Claude. The first click into an unfocused terminal only focuses | `app/ui/term.ts:99` | code, probe | fixed (inc 2): a focused click sent press and release to Claude; the first click into an unfocused terminal only focused it; Shift-click stays in the app |
| T3 | sheet, Desk card | Scroll over a shell pane with history | Nothing moves. The replay is the viewport only | Older lines show, and new output follows the bottom again | `app/crates/seamux-app/src/term_app.rs:25` | code, probe | fixed (inc 2): a shell's 240 rows of scrollback draw above its screen in colour and the wheel scrolls them; terminal.scroll was tried and moves nothing |

## Terminals: one look and size (increment 3)

| # | View | Steps | What happens | Should | Code | How found | Status |
|---|------|-------|--------------|--------|------|-----------|--------|
| T4 | Mosaic, opened pane | Open a tile | The pane shows as re-flowed text from `read_text`, with no cursor or colours, and you can't type into it | The same live terminal as the sheet, with the text as its fallback | `app/ui/wall.ts:253` | code | fixed (inc 3): the opened pane shows the live terminal (55 rows), its text hidden; keys and the wheel reached the pane |
| T5 | sheet fallback, wall preview, Mosaic tile | Compare one agent across views | The text is 11.5px in the app's `--term` colours; the live terminal is 12px in the pane's own theme and padding | One font size, padding and theme everywhere a pane is drawn | `app/ui/index.html:130`, `app/ui/wall.css:88`, `app/ui/mosaic.css:48` | code | fixed (inc 3): sheet, Desk and Mosaic pane all 12px/15px, 8px padding, rgb(39,49,54) on rgb(242,255,252); a tile's text wears the same |
| T6 | Desk card | Open a card's terminal | A fixed 340px box, whatever the window's height | Sized like the sheet's terminal and resizable (increment 4) | `app/ui/desk.css:132` | code | fixed (inc 4): a grip along the bottom; dragged 120px the box went 342 -> 462px (1px borders), kept through frames; double-click back to 340 |
| T7 | sheet, Desk card, Mosaic pane | Look at a wide pane (165 columns) in a half-width view without clicking it | Unfocused, the terminal shrinks to fit the pane's own width, down to 8px; it is held at 12px only once focused | Readable unfocused too. But holding the pane whenever it's shown would resize it in cmux just for looking, which the live-terminal plan ruled out | `app/ui/term.ts` `scale()` | harness screenshot | fixed (after): while shown, an unfocused terminal that would draw below 10.5px holds the pane at its own size (99 -> 65 cols in a 500px chat, drawn at 12px, steady); focus then blur kept the hold; closing gave the pane its policy back; a view that already reads well holds nothing; two views of one pane hold it once |

## Resize zones (increment 4)

| # | View | Steps | What happens | Should | Code | How found | Status |
|---|------|-------|--------------|--------|------|-----------|--------|
| R1 | sheet | Drag the chat divider across the framed page beside it | The drag drops: no pointer capture, and the iframe swallows the moves and the release | The drag keeps going until release, wherever the pointer goes | `app/ui/sheet.ts:457` | code | fixed (inc 4): splitter.ts captures the pointer and turns off framed pages' pointer events; a drag released over the page landed at 0.657 with the pointer at 0.658, and later moves did nothing |
| R2 | sheet | Aim for the divider | A 5px target with a -3px margin and no hover line | At least 8px, with a visible line on hover | `app/ui/index.html:125` | code | fixed (inc 4): a 9px target with an accent line on hover, focus and drag |
| R3 | sheet | Drag the divider to an edge and reopen | The drag clamps at 0.2–0.7, but 0.15–0.75 is accepted when read back | One range for both | `app/ui/sheet.ts:40`, `app/ui/sheet.ts:461` | code | fixed (inc 4): one 0.2–0.7 range for drag and read-back; dragged to the edge it stopped at 0.7 and reloaded as 0.7 |
| R4 | Mosaic, opened pane | Try to widen the agent list | Fixed at 220–290px, with no handle | A handle, saved like the sheet's | `app/ui/wall.css:13` | code | fixed (inc 4): a grip on the list's edge; 290 -> 410px, kept after a reload, never over 60% of the width |
| R5 | Desk card | Try to make the terminal taller | Fixed at 340px | A height handle | `app/ui/desk.css:132` | code | fixed (inc 4): a grip along the bottom; dragged 120px the box went 342 -> 462px (1px borders), kept through frames; double-click back to 340 |
| R6 | every handle | Keyboard, or a double-click | Nothing: no keys, no reset | The arrow keys nudge it and a double-click resets it | `app/ui/sheet.ts:457` | code | fixed (inc 4): ArrowLeft twice took the sheet split 0.70 -> 0.66; a double-click reset it to 0.5, and the Desk terminal to 340px |

## Dead clicks (increment 5)

| # | View | Steps | What happens | Should | Code | How found | Status |
|---|------|-------|--------------|--------|------|-----------|--------|
| D1 | Mosaic | While an agent is printing, open a tile's ⋯ menu, or press and release on a tile | The whole grid is rebuilt on every frame where any tile's text changed, about once a second. The open menu vanishes, hover flickers, and a click whose press and release straddle a rebuild is lost | A frame that changes only text updates the tiles in place; nothing is rebuilt while a menu is open or the pointer is down | `app/ui/mosaic.ts:143` (shape includes every tile's lines), `app/ui/mosaic.ts:177` | code | fixed (inc 5): with text changing every frame the tile stayed the same element for 3 frames while its text moved in place; its ⋯ menu stayed open; a press held across 2 frames still opened the tile. On the pre-fix UI the same run failed all three |
| D2 | Timeline | Open a lane's ⋯ menu, or click a waiting span, while agents work | Lanes are rebuilt on every wall frame and views frame, with no change check and even while the tab is hidden. The menu closes by itself and clicks are lost | Redraw only when what Timeline shows changed, and never under an open menu or a held pointer | `app/ui/timeline.ts:79`, `app/ui/timeline.ts:110` | code | fixed (inc 5): a lane stayed the same element across 3 text-only frames and its ⋯ menu stayed open; hidden, Timeline drew nothing, and showed again it drew the change at once |
| D3 | Mosaic | Click the "+ N terminals" tile | It is drawn as a tile, a card like the ones that open (its own cursor is the default, the audit first said pointer), but has no handler | Either it opens the shells or it stops looking clickable | `app/ui/mosaic.ts:175`, `app/ui/mosaic.css:21` | code | fixed (inc 5): now a button; "+ 1 terminal" opened Mosaic's pane on the shell |
| D4 | every ⋯ menu | Open a menu, press Esc | Esc does not close it; only a click elsewhere does | Esc closes the menu and gives focus back to its button | `app/ui/tuck.ts:132` | code | fixed (inc 5): Esc closed the menu and put focus back on ⋯, and the window stayed up |
| D5 | Timeline | Click a lane's name | Nothing happens | Opens that workspace's pane, as a Mosaic tile does | `app/ui/timeline.ts:167` | code | fixed (inc 5): a lane's name opened Mosaic on that workspace's agent pane |

## Checked, nothing found

- **Wake**: a views frame redraws only when the tucked list or the newest row changed (`app/ui/wake.ts:205`).
- **Lookout**: each review card keeps what it last drew and redraws only on a change (`app/ui/review.ts:81`).
- **Desk**: the redraw check leaves out pane text, and nothing redraws while an input or the terminal has focus (`app/ui/desk.ts:302`).
- **Wall list** (Mosaic's opened pane): rebuilt only when sections, order or counts move (`app/ui/wall.ts:470`).
- **Tucked palette**: re-lists on a views frame, which is only when the tucked rows change.

## Not yet seen live

The audit was meant to drive the installed worktree build with computer use.
At the time, computer use was held by another Claude session and the cmux
Computer Use helper was not running. Every finding above was read from the
code, and T1–T3 were also probed against cmux. Each fixing increment re-runs
its findings in the installed build where a GUI driver is available, and
says so in its status.
