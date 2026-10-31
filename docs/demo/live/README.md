# Live app demo

A product video of the seamux app made from live Claude sessions (Sonnet, low
effort), not scripted terminal output. A second copy of the installed app runs
on a throwaway HOME, real Claude sessions work in its workspaces, and its
window is filmed and edited onto a 1920x1080 canvas with captions and a
synthesized soundtrack.

```bash
bash docs/demo/live/setup.sh          # build /private/tmp/seamux-demo (a HOME, the shop repo, crew applied)
bash docs/demo/live/app.sh            # start the demo app beside yours
bash docs/demo/live/take.sh           # one take: take/app.mp4 and take/beats.tsv
node docs/demo/live/cut.mjs docs/demo/live/edit.json --stills   # one still per shot, to check
node docs/demo/live/cut.mjs docs/demo/live/edit.json            # cut/seamux-app-demo.mp4, cut/poster.jpg
bash docs/demo/live/app.sh /private/tmp/seamux-demo --stop
```

Build the two Swift tools into `ROOT/tools` first (`swiftc -O winrec.swift -o
ROOT/tools/winrec`, and the same for a small window lister named `wins`, which
`lib.sh` uses to find the window id). `cut.mjs` uses the reel's
`ffmpeg-static` and `playwright-core` (`cd docs/demo/reel && npm install`).

## Families and the cloud

A second video: a deep-plan family (a parent, `auth-revamp`, and two
workstreams) where one workstream, `auth-api`, runs in a cloud session. The
cloud is simulated with a local repo: `ROOT/remote.git` stands in for
GitHub, and the cloud session is a live Claude in a fresh clone of it, with
its own HOME and `CLAUDE_CODE_REMOTE=true`, shown in a Terminal window. The
parent shares (`"share": true`), so each plan's state rides its
`seamux-state/<slug>` branch, and the cloud's `await-go` picks up the parent's
go from there.

```bash
bash docs/demo/live/setup.sh && bash docs/demo/live/family-setup.sh && bash docs/demo/live/app.sh
bash docs/demo/live/take-family.sh                                  # take-family/{app,cloud}.mp4, beats.tsv
node docs/demo/live/cut.mjs docs/demo/live/edit-family.json         # cut-seamux-family-demo/
bash docs/demo/live/cloud.sh /private/tmp/seamux-demo stop
```

`family-stage.sh` (run by the take) renders and grades the three plans once
the app's workspaces exist and clones the cloud's checkout. On one machine
the laptop's worktree path exists for the cloud too, so it names the clone as
the plan's root, as a real sandbox does by itself. The take records both
windows from one `winrec` process (two at once interrupt each other). The
cloud window's title bar carries your user name, so `cut.mjs` always crops it
off.

Things the takes ran into:

- One go per turn. The parent agent can't give a workstream its go in the
  same turn as its own; the person says yes twice.
- A go has to answer the agent's question: "go" inside the instructions that
  start the work is refused. Send the work, let it ask, then send "go".
- A deliverable check with a plain `run` (no recipe) is not run by
  `deep-plan check run`; the agents recorded those passes by hand.
- Asked to refresh a workstream's state, the parent agent said deep-plan has
  no command for it. `deep-plan state pull <slug>` is that command; the take
  names it.

## deep-plan and lookout up close

Two shorter videos from one world. `deep-dive-setup.sh` lays
`docs/demo/world/shop-web` over the shop: a checkout page, a small static
server, a browser-check script, and a `verify.json` with lint, unit and
browser recipes. Browser checks run in headless Chromium through a one-line
`playwright` that loads the reel's playwright-core, with your Playwright
browser cache, so nothing is downloaded.

```bash
bash docs/demo/live/setup.sh && bash docs/demo/live/deep-dive-setup.sh && bash docs/demo/live/app.sh
bash docs/demo/live/take-deep.sh        # a plan made live, its sections toured, go, check run
bash docs/demo/live/take-lookout.sh     # then, in the same world: a lookout review worked through
node docs/demo/live/cut.mjs docs/demo/live/edit-deep.json
node docs/demo/live/cut.mjs docs/demo/live/edit-lookout.json
```

The plan is made from scratch by the agent, so its sections and forks vary
from take to take; `answer` in `lib.sh` takes each fork's first
(recommended) option, and `answers.sh` reads the quiz key. The take widens
the Dock's page pane with a drag on its splitter and presses the board's go
chip with a real click, so the demo app comes to the front for a moment.
`cut.mjs`'s side layout shows a pane tall on the right with the section's
name and intent beside it. `LOOKOUT_PART2=1` picks a lookout take up from a
review whose findings are filed.

## What stays yours

The demo app, its tmux server, its intent server (port 7445) and every Claude
it starts run with `HOME=/private/tmp/seamux-demo/home`. Your workspaces,
plans, transcripts and spend are never read. Claude signs in through your
login keychain (a link to `~/Library/Keychains`). From `~/.claude.json` only
the "already seen" flags for tips and notices are copied. The plugins run from
a copy under the root, so no on-screen path has your user name in it.

The take drives the app through accessibility (`ui.applescript`) and types to
Claude through the app's tmux (`lib.sh`). It never moves your mouse or types
into another app, but the window has to stay on screen while it records.

## Files

| file | what |
|---|---|
| `setup.sh`, `app.sh` | the demo HOME and the second app |
| `lib.sh`, `ui.applescript` | drive the app and its sessions |
| `take.sh` | the beats: an ask with pictures, a plan and its gate, go, bash-guard, the Wake |
| `winrec.swift` | records one window with ScreenCaptureKit |
| `family-setup.sh`, `family-stage.sh`, `cloud.sh` | the family's specs, the simulated cloud and its window |
| `take-family.sh`, `edit-family.json` | the families + cloud take and its edit |
| `deep-dive-setup.sh`, `take-deep.sh`, `take-lookout.sh`, `answers.sh` | the deep-plan and lookout videos' world and takes |
| `edit-deep.json`, `edit-lookout.json` | their edits |
| `axfind.swift`, `click.swift` | find a control through accessibility (`--press` presses it, scrolled into view); a real click or drag |
| `axpress.swift`, `pidclick.swift` | experiments: neither reaches the board's chips (see below) |
| `cut.mjs`, `edit.json` | the edit: shots by beat name, crops, speed, captions, poster |
| `music.mjs` | the soundtrack, 96 BPM, cuts on the beat grid |

## Known gaps

- The board's chips (go, jump) are web content with no accessible button, so
  the take can't press them, and posted clicks don't reach them. On the tmux
  backend the go and jump chips also fail on their own: `/do` sends them as
  cmux notifications (`act.rs` `notify`), which don't exist there. The take
  says "go" in the terminal instead, the way the gate's own message suggests.
- The Dock keeps showing whichever workspace was picked or made last, so each
  beat opens its own workspace with the New workspace form.
