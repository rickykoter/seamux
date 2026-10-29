# Demo media

Videos and screenshots of every seamux feature, made against a throwaway
world, never your own workspaces, plans or spend.

- [FEATURES.md](FEATURES.md) lists each feature and the shot that covers it.
- [STORYBOARD.md](STORYBOARD.md) has the videos, their cue cards, and how each
  scene is captured.
- Screenshots are in [media/](media/). Videos land in `~/Movies/seamux-demo/`
  and stay out of git.

## Record

```bash
cd docs/demo/reel && npm install
```

```bash
node docs/demo/reel/demo.mjs
```

That records all of it. Name videos to record fewer (`node demo.mjs v1 v5`).
`--keep` leaves the world folder in `~/Movies/seamux-demo/.world/` so you can
look around after a take. The app screenshots come from
[app/shoot.mjs](app/shoot.mjs).

Each video stages its own world with [stage.sh](stage.sh): a small shop repo
from [world/shop](world/shop), a bare remote beside it, and deep-plan, lookout
and restack state in the same folder. `SEAMUX_HOST=terminal` makes the plugins
serve their own pages on 127.0.0.1, so nothing reaches cmux.

Terminal scenes run the real commands. The agent's turns are real Claude
sessions (`claude -p`, Sonnet, low effort), run with this checkout's deep-plan
hooks through `--settings`. Their `deep-plan`, `lookout` and `restack` are
shims that carry the world's state, so a session cannot read your real plans.
A beat that doesn't happen fails the take: the gate doesn't refuse, a finding
isn't filed, a conflict is left in the file. The output is scrubbed of paths,
your user name and your host name before it is filmed. A full run costs a
dozen or so short Sonnet calls.

Pages are filmed off-screen with Playwright and
[testreel](https://www.npmjs.com/package/testreel). Nothing takes over your
screen. `stitch.mjs` puts each video's clips on one 1920x1080 canvas, with a
title card and the cue cards from `cards.mjs`.

## Files

| file | what |
|---|---|
| `stage.sh` | builds a world: the shop repo, its remote, the env, the hook wrappers and the CLI shims |
| `world/` | the shop, the coupon plan spec, the ask, the family, the restack stack, a draft PR |
| `reel/demo.mjs` | records the videos and screenshots in STORYBOARD.md |
| `reel/cast.mjs` | terminal scenes as data: real command output, live agent turns |
| `reel/term.html` | plays a cast back in xterm.js for filming |
| `reel/stitch.mjs`, `cards.mjs`, `cut.mjs` | the canvas, cue cards and editing, shared with the README Tour |
| `reel/record.mjs`, `take.md` | the README Tour's own scenes |
| `app/` | the seamux app's pages in a browser with a mocked Tauri backend |
| `board-preview.py` | the crew board from this checkout on a fixed cast |

## What is not filmed

Some features read or change your real machine, and some need a real account
or the real screen: `crew-resume`, `crew-sweep`, `crew doctor`, Remote
Control on the phone, ⌥Space over another app, and macOS notifications.
FEATURES.md marks each one. The seamux-mods shots (plan pane, gate band) come
from a real session and are kept in `docs/img/`.
