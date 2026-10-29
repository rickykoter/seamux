# Storyboard

Six short videos and a set of screenshots. Every feature in
[FEATURES.md](FEATURES.md) maps to a scene (`V…`) or a screenshot (`S-…`).
Cue cards are the words on screen, in the order `reel/demo.mjs` shows them.
Everything runs against throwaway repos and temporary plan state; nothing
reads your workspaces, plans or spend.

The "how" column says how each scene is captured:

- A `page` scene films the shipped page off-screen in Playwright. deep-plan
  and lookout serve it from the world's state folder
  (`SEAMUX_HOST=terminal`); the board and `/usage` are static renders.
  Nothing takes over your screen.
- A `term` scene runs real `deep-plan`, `lookout` and `restack` commands on
  throwaway repos, scrubs paths and names from the output, and plays it back
  in an xterm.js page. A `live` beat is a real Claude session (Sonnet, low
  effort) on the same repo, with this checkout's hooks.
- An `app` scene runs the seamux app's pages from `app/ui` in Vite, with
  Tauri's `mockIPC` standing in for a cmux of five workspaces
  (`docs/demo/app/`).
- Each video is stitched onto one 1920x1080 canvas and lands in
  `~/Movies/seamux-demo/`, outside git. Screenshots land in
  `docs/demo/media/` and are committed.

## V1. One change, start to finish (deep-plan + lookout)

| # | cue card | shows | how |
|---|---|---|---|
| 1.1 | Ask for a deep plan. | the agent restates the goal, argues against it, lists the forks | term, live |
| | A hard choice comes with pictures. | `deep-plan ask` prints its page | term |
| | Each option shows what it would do. | the ask page: a diagram, three options with samples | page |
| | Pick here, or answer in the terminal. | | page |
| 1.2 | The plan is a page you read. | `deep-plan render`, served at a local URL | term |
| | Context, decisions, cited facts, risks. | the review page and its rail | page |
| | Highlight a line to comment. | a comment pinned in the margin | page |
| | Press / to search the plan. | fuzzy find with ranked hits | page |
| | Changes to an API or a table are named. | contracts, verified facts | page |
| 1.3 | Decide each risk. | accept, mitigate, spike, promote | page |
| | Big decisions become ADRs. | the ADR editor | page |
| | Each diagram starts in plain words. | overview tab, then detailed | page |
| | Every step lists the checks it must pass. | increments and their checks | page |
| | A short quiz checks you agree. | four answers | page |
| | Copy your answers back to the agent. | Copy for session | page |
| | The agent grades your answers. | `deep-plan grade` passes | term |
| 1.4 | No edits until you say go. | the agent's write is refused by the gate; it stops and asks | term, live |
| | You say go. One step opens. | `deep-plan go`, then the agent builds increment 1 | term, live |
| 1.5 | Done waits for its checks. | `check run`: lint and unit pass, the preview needs a person; `done` refused | term |
| | You do the steps a person must. | the metric checked by hand, the preview check | term |
| | Commit what passed. It stays valid. | | term |
| | Change the code and the pass goes stale. | `check list` shows stale; undo; `done` | term |
| | After the quiz, the page tracks the work. | the working page | page |
| 1.6 | A fresh reviewer reads the diff. | increment 2 built live; `check run` opens its review | term, live |
| | | the reviewer subagent files findings; `lookout gate` holds | term, live |
| 1.7 | Answer first, then read the reviewer. | lookout's overview quiz | page |
| | Riskiest files come first. | risk order | page |
| | Findings sit on their lines. | a major finding and its thread | page |
| | You close blockers, not the agent. | Resolve | page |
| 1.8 | Ship a reviewed branch. | gate passes, `done`, `deep-plan deliver` | term |
| | One review reads every step together. | the delivery review | page |

## V2. One goal, several agents (families)

| # | cue card | shows | how |
|---|---|---|---|
| 2.1 | Split a big goal into workstreams. | the parent plan page | page |
| | Each one has its own plan, agent and files. | its Workstreams section | page |
| 2.2 | A workstream waits for the parent. | the ui `go` refused, `family status` (parent goes / a person goes), then allowed | term |
| 2.3 | Step on a sibling's file and you're told. | the ui agent writes into api's files and reports the note; `family check` | term, live |
| 2.4 | Each agent hears what changed. | the agent quotes the sibling's news | term, live |

## V3. Where it runs, and with whom

| # | cue card | shows | how |
|---|---|---|---|
| 3.1 | No cmux? It serves its own page. | `deep-plan doctor`, `served at …` | term |
| 3.2 | Share a plan through git. | `go` pushes `seamux-state/demo-coupons`; a second clone pulls it | term |
| 3.3 | Carry it into cloud sessions. | `install-repo` for both plugins | term |
| 3.4 | Review from the cloud, too. | `lookout export-artifact`, `lookout pull` | term |

## V4. Small tools

| # | cue card | shows | how |
|---|---|---|---|
| 4.1 | Rebase a stack. Let generated files rebuild. | `restack plan`, `run` regenerates the route table and stops on the tax rate; the agent settles it; `continue`, `check`, `push` prints | term, live |
| 4.2 | Risky commands stop at the guard. | the agent tries a force push; bash-guard blocks it | term, live |
| 4.3 | Make prose read like a person wrote it. | `scan.py`, then the agent humanizes a PR description | term, live |

## V5. The crew board (cmux)

| # | cue card | shows | how |
|---|---|---|---|
| 5.1 | Who needs you comes first. | the board, ranked | page |
| | Approve the next step from the board. | `go 3`, the row moves to working | page |
| | A family is one card. | a workstream opened inside its family | page |
| | The footer says it in sentences. | the news footer | page |
| 5.2 | See what you're spending. | `/usage` | page |
| | Dollars per workspace. | | page |
| | Know when the cache goes cold. | the cache panel | page |

## V6. The seamux app

| # | cue card | shows | how |
|---|---|---|---|
| 6.1 | Every agent, one hotkey away. | the Dock: board, the agent's terminal, its Wake | app |
| 6.2 | Start a workspace in one form. | New workspace, then it appears | app |
| 6.3 | Reply without switching. | Mosaic: answer a question from its tile | app |
| | See who waited, and how long. | Timeline | app |

## Screenshots (`docs/demo/media/`)

| file | shows | how |
|---|---|---|
| dp-review, dp-comment, dp-narrow, dp-find, dp-diagram, dp-diagram-full, dp-quiz, dp-contracts, dp-risks, dp-adr, dp-evidence | review page pieces | page |
| dp-working, dp-checks-review, dp-checks-working | working page and checks in every state | page |
| dp-verify-init | `deep-plan verify init` drafting recipes | still |
| dp-ask, dp-family | ask page, parent plan | page |
| lo-quiz, lo-overview, lo-risk, lo-findings, lo-diff | lookout review | page |
| crew-board, crew-family, crew-news, crew-usage, crew-usage-billing, crew-cache, crew-statusline | crew | page, still |
| app-dock, app-newws, app-reclaim, app-mosaic, app-wall, app-timeline, app-wake, app-lookout, app-palette | the app | app |
| plan-pane, gate-band (in `docs/img/`) | seamux-mods in Claude Code | kept from a real session |

## Not filmed

- Remote Control on the phone, and ⌥Space over another app: they need a real
  account or the real screen.
- crew's terminal tools (`crew-digest`, `crew-resume`, `crew-sweep`,
  `crew doctor`): they read your real repos, transcripts and setup. The news
  footer shows the digest's sentences, and the app's reclaim wizard shows
  reclaim.
- Graphite stacks, `redraw` and `overviews`: no visible change worth a shot.
