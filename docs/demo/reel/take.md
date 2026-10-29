# Taking the Tour

The README Tour is the full-screen end-to-end take (2c below): three real
sessions planned, gated and checked, edited with `cut.mjs` and opened by a
feature tour.

`stitch.mjs` makes a shorter cut from seven clips in three acts: one agent,
then a plan family, then what it all costs.

| clip       | what it shows                                           | made by          |
|------------|---------------------------------------------------------|------------------|
| `terminal` | an agent finishes increment 2 and hits the gate on 3    | cmux-cua         |
| `board`    | a row finishes and re-ranks, `go 3`, a question arrives | `record.mjs`     |
| `plan`     | the question's plan: decisions, ADR, the quiz, Copy     | `record.mjs`     |
| `parent`   | a family's parent plan: its workstreams, what waits on what | `record.mjs` |
| `family`   | live: the ui agent edits api's file and is told; then hears api's news | cmux-cua + `live-family.sh` |
| `famboard` | the family on the board, in shades; its gate pulls it to the top | `record.mjs` |
| `usage`    | `/usage`: window budget, per-workspace dollars, cache   | `record.mjs`     |

Clips land in `~/Movies/seamux-reel/` (`--out` changes it), outside the repo,
like every other demo video.

## 1. Web clips

```sh
cd docs/demo/reel
npm install                                       # once
npx playwright-core install chromium-headless-shell   # once, if launch says so
deep-plan render deep-plan/examples/example.spec.json # the plan clip's page
node record.mjs                                   # or: node record.mjs board
```

Nothing touches your screen or the live board: each page renders off-screen
in Playwright. A UI change is a re-run, not a re-shoot. `parent` stages the
example family with `deep-plan/tools/family-fixture.sh` in a temporary folder
and opens the parent's review page from there, so it needs no render and
leaves your plan state alone. `famboard` is the last two scenes of the
`board-demo.py` cast.

## 2. Terminal clip

testreel only records browsers, so this one is a screen capture. cmux-cua's
`start_recording` captures the **whole main display**, so it takes your screen
for about 40 seconds. Let an agent drive it:

1. cmux-cua: `start_session`, bring cmux to the front, then
   `start_recording(output_dir: ~/Movies/seamux-reel/.cua, record_video: true)`.
2. Open a focused workspace running the scripted transcript. Nothing in it is
   a real session, and it stops at the gate. Recording starts first because
   the typing begins about a second after the workspace opens:

   ```sh
   cmux new-workspace --name checkout-flow --focus true \
     --command "$PWD/docs/demo/session-replay.sh; exec zsh"
   ```
3. Let the transcript run to the input box (about 25s), wait 2s more, then
   `stop_recording`. Copy `recording.mp4` to `~/Movies/seamux-reel/terminal.mp4`
   and close the workspace.
4. Pull a frame (`ffmpeg -ss 5 -i terminal.mp4 -frames:v 1 f.png`) and write:
   - `terminal.crop` as `w:h:x:y` in video pixels, around the terminal pane
     only. Leave the cmux sidebar out: it lists your real workspaces.
   - `terminal.trim` as `start end` in seconds: from just before the first
     typed line to about 2s after the input box appears.

   Three things leak your identity, so check for them in the frames:
   - before the script's `clear`: a `Last login` line and the launch command
     with your home path. Start the trim after the clear.
   - after the script ends, `exec zsh` prints your real `user@host` prompt
     right under the status line.
   - the cmux tab label switches to the command's path a second in.
   The last two can't be trimmed away, so paint over them (in the terminal's
   background colour) while converting, before writing the crop:
   `-vf "drawbox=x=0:y=124:w=470:h=54:color=0x1f292d:t=fill,drawbox=..."`.

If cmux-cua won't connect, macOS `screencapture -v -V 36 -x -m terminal.mov`
records the same full display, once cmux has Screen Recording permission.

## 2b. Family clip: a live take

Unlike the terminal clip, nothing here is scripted text: `live-family.sh
--cmux` opens real cmux workspaces on a throwaway deep-plan family, runs a
real interactive `claude` (haiku) in the ui workstream, and types two prompts
into it. The first writes a file the api workstream owns, and the guard's note
comes back. Then the api plan finishes an increment, and at the next prompt
the ui agent reports the news. The script asserts each beat as it happens
(the trespass is recorded, the agent names the owner, it quotes the news), so
a take that exits 0 is proof the scene really happened, not a mock-up. It
costs two short model calls.

```sh
bash deep-plan/tools/live-family.sh --cmux --lead 3 \
  --captions ~/Movies/seamux-reel/family.captions.json
```

- **Recording.** As for the terminal clip: cmux-cua `start_session`, bring
  cmux to the front, `start_recording`, then run the script. It can run from
  outside cmux (Terminal.app, so the session driving the take isn't in the
  footage) once cmux's `CMUX_SOCKET*` variables are carried over; it then
  opens in cmux's selected window, or the one `--window` names. From there,
  cmux-cua's recording isn't available (its `call` refuses outside cmux's
  Computer Use), and `screencapture` fails with "could not create image from
  display" unless Terminal has Screen Recording permission. ⌘⇧5 works: in its
  Options set Save to → Desktop and turn off Show Floating Thumbnail, or the
  file waits in a temporary folder and can be lost. Its name has a narrow
  no-break space before AM/PM, so match it with a glob.
- **Clock.** Without cmux-cua you don't know when the recording started.
  Find the frame where the take's workspace opens: that is `--lead` seconds on
  the take's clock, so the difference is what to add to each caption's `at`.
  The first take used `family.trim` `11.9 40.2` (after the launch command's
  `clear`, before the workspace closes and your own prompt returns) and
  `family.crop` around the title bar and the top of the pane, which holds the
  whole exchange at twice the text size of the full pane. `--lead 3`
  holds 3s before the first workspace opens. The ui workspace opens focused.
  When the script prints its result, `stop_recording` and copy the file to
  `~/Movies/seamux-reel/family.mp4`. `--pace S` (default 4) holds each beat
  longer for reading.
- **Captions.** `--captions` writes one per beat, timed in seconds since the
  script started. The recording started earlier, so add that gap to each `at`
  before stitching.
- **`--real-state`** also opens workspaces for the parent and the api
  worktree, and renders the family into your real plan state. The crew board,
  the sidebar and `/plan-pane` then show it, and the family's colours land on
  its workspaces. Grouping and shades need crew applied at a version with
  families (`crew apply` from your kept checkout). The script warns when it
  isn't. It refuses if a plan named `example-auth-*` already exists, and
  removes the three plans and their workspaces when it finishes. Use
  `--keep` to look around first; it prints how to close them.
- **Hooks.** The session runs this checkout's hooks through `--settings`,
  whatever plugin version is installed. Its status line is replaced with
  `example-auth-ui`, because the usual one shows your usage window.
- **What still leaks.** The cmux sidebar lists your other workspaces. Crop it
  out, as for the terminal clip, unless the sidebar is the point of the take
  (`--real-state`); then close or hide the others first. The first take in
  the fixture folder answers Claude Code's trust prompt (the script presses
  Down, then Enter, because the default is "No, exit"). The fixture stays at
  `~/.cache/seamux-demo/live-family` so later takes skip that prompt. A
  Claude Code "Update available" banner can appear above the prompt.

`stitch.mjs` places it between `parent` and `famboard`. A crop and trim work
the same way as for the terminal clip (`family.crop`, `family.trim`).

Without `--cmux`, the same script is the headless e2e (`family-live` in
`.seamux/verify.json`): two `claude -p` calls, nothing on screen.

## 2c. Family end to end: a full-screen take

A standalone clip, not part of the Tour. `docs/demo/family-e2e.sh` builds a
throwaway shop repo with two worktrees and opens three real Claude Code
sessions (Sonnet, low effort). Then it plays your part:

1. Both workstream sessions plan their child plans with deep-plan, in
   parallel.
2. The parent session adopts them (`family init`) and plans the shared type
   and an end-to-end test.
3. `go` runs on each increment in turn, with each quiz answered from its key.

The agents implement, run the checks, and record a mocked observability
check (`node scripts/metrics.mjs`) by hand. There's no GitHub step. Plans
render into your real state so the board and sidebar show the family, and
they're removed afterwards. Every beat is asserted, and a missed one ends the
take.

```sh
bash docs/demo/family-e2e.sh --lead 5 --captions ~/Movies/seamux-reel/e2e.captions.raw.json
```

- **Recording.** Start a ⌘⇧5 full-screen recording first (see 2b). The take
  switches workspaces itself. The first take took 6.6 minutes: about 3 to
  plan the family, under 1 to build it.
- **Cutting.** `node cut.mjs e2e` reads `~/Movies/seamux-reel/e2e.cut.json`
  and writes `e2e.mp4` at 1920x1080. The file is a list of shots, joined with
  short crossfades:
  - a title card;
  - a span of the recording, with a speed (planning runs at 8×), a punch-in
    `view` rectangle (16:9 fills the frame), a caption, and spotlight
    `highlight`s that dim everything outside a box. A highlight's `hold`
    pauses on that frame for a few seconds, so there's time to read it;
  - a `freeze`, which holds one frame beside a panel with a title and bullets;
  - a `callout` freeze: the whole frame with one spotlight and a small card
    naming what it shows. A run of these on one frame makes the feature tour
    that opens the clip, crossfading from feature to feature.

  The header of `cut.mjs` documents the fields. To place a rectangle, pull
  the frame with a grid over it (`drawgrid=w=100:h=100`). To place a time,
  find the recording's offset from the moment a prompt the script typed
  appears. Check every freeze frame: the script switches workspaces between
  beats, so a frame a second late can show another session. Hold on a frame
  where the layout has settled: a transcript still scrolling leaves the box
  off its target.
- **What shows.** Your other workspaces appear in the sidebar and on the
  board. Sessions print their scratchpad paths, which contain your user name.
  Claude Code's header shows the plan tier.
- **Found live.** The gate refuses a `git commit` once `done` has closed the
  increment, so the prompts commit first, then close.
  Unexpected permission or question prompts get their first option, and the
  log says which.

## 3. Captions

The Tour opens on a title card and puts a caption over every beat, like the
original. The web scenes write their own (`say(...)` in `record.mjs`, stamped
as each beat happens, saved as `<name>.captions.json`). The terminal clip's
are written by hand, timed on the untrimmed clip's clock:

```json
[{ "at": 3.6, "text": "An agent works a deep-plan, one approved increment at a time" }]
```

Wrap a term in backticks (`` `go 3` ``) to show it in green like a board chip.
The title and the card styling live in `cards.mjs`.

## 4. Stitch

```sh
node stitch.mjs            # → ~/Movies/seamux-reel/tour.mp4
```

Every clip is placed at 1:1 (never scaled up) on one 1920x1080 gradient, with
rounded corners and short crossfades. A missing clip is skipped, so the web
clips can be stitched on their own.

## 5. Publish

Drag `tour.mp4` into a GitHub comment or PR description to get a
`user-attachments` URL, and swap it into the README's Tour section.
