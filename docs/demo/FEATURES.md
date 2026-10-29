# seamux features, for the demo media

Every user-visible feature, grouped by plugin, taken from the READMEs and the
code. Each row names the shot that covers it: a screenshot in
`docs/demo/media/` (`S…`) or a scene in a video (`V…`). The storyboard in
[STORYBOARD.md](STORYBOARD.md) has the cue cards and how each is captured.

## The line (README: How a change runs)

| feature | shot |
|---|---|
| Plan → Align → Go → Build → Prove → Review → Ship, one station at a time | V1 (whole video) |

## deep-plan

| feature | source | shot |
|---|---|---|
| Challenge the goal: restated goal, assumptions, strongest case against | deep-plan/README.md §1 | V1.1 |
| Forks asked as questions before anything is written | §2 | V1.1 |
| Sub-agents check unsure claims; confirmed ones become cited facts | §3, review page | S-dp-evidence, V1.2 |
| Review page: context, decisions, evidence, diagrams, increments, section rail | The review page | S-dp-review, V1.2 |
| Highlight + ⌘M comment in the margin, click to edit | The review page | S-dp-comment, V1.2 |
| Narrow pane: rail as a top bar, comment opens inline | The review page | S-dp-narrow |
| Drafts kept in the browser across reloads | The review page | V1.2 (card) |
| `/` find: plain, word, regex, fuzzy, ranked hits by section | The review page | S-dp-find, V1.2 |
| Diagrams: plain-words Overview tab, Detailed tab, zoom, full screen | The review page | S-dp-diagram, S-dp-diagram-full |
| Alignment quiz + **Copy for session** | The review page | S-dp-quiz, V1.3 |
| `grade` refuses undecided risks / contract without a question | Risks, Contracts | V1.3 (terminal) |
| Working page: increment status, checks, `go` / `done` buttons, live refresh | The working page | S-dp-working, V1.5 |
| Amendments: comments on the working page, **Copy amendments** | The working page | V1.5 |
| `redraw --all`, `overviews <slug>` | The working page | FEATURES only (maintenance verbs, no visible page change) |
| Questions with pictures: `deep-plan ask` page, options with diagram + sample | Questions with pictures | S-dp-ask, V1.1 |
| Ask answer typed into the terminal and read back | Questions with pictures | V1.1 (card) |
| Contracts block: owner decision, scouted users, ADR or waiver for cross-service | Contracts | S-dp-contracts |
| Risk cards: accept / mitigate / spike / promote | Risks | S-dp-risks, V1.3 |
| ADRs: flagged decision → draft ADR card, Edit with live preview, add an ADR, `adr apply` | ADRs | S-dp-adr, V1.2 |
| The gate: no edits until quiz passes and `go`; one increment at a time | §5 | V1.4 (terminal) |
| Checks before done: test, e2e, observability, manual step; `done` refused until all pass | Checks before done | S-dp-checks-review, S-dp-checks-working, V1.5 |
| Recipes in `.seamux/verify.json`, inferred per increment | Checks before done | S-dp-checks-review |
| Background runner, remote QA (preview → wait → test), `variant ready` | Checks before done | S-dp-checks-working |
| A pass goes stale when the file changes | Checks before done | V1.5 (card) |
| Review check: increment waits on its lookout review | Checks before done | V1.7 |
| `deliver`: delivery review of all increments | Checks before done | V1.8 |
| `verify init`: drafts recipes from package.json / CI with TODOs | Setting up checks | S-dp-verify-init (terminal) |
| Families: parent plan with `workstreams`, `family init` | Families | S-dp-family, V2.1 |
| Overlap noted (sibling owns the file), `family check` | Families | V2.3 |
| `after`: child's go waits on the parent increment | Families | V2.2 |
| Each session hears what changed at its next prompt | Families | V2.4 |
| Family reads as one on the board and sidebar | Families | S-crew-family, V5.1 |
| `go: "parent"`: parent agent gives child its go | README Working as a team | V2.2 |
| Shared plan state on `seamux-state/<slug>`, push per transition, pull at start, merge on race | Sharing a plan's state | V3.2 |
| `state push|pull|status|list`, unsynced status, archive tag on deliver | Sharing a plan's state | V3.2 (terminal) |
| `export-state` / `import-state` by hand | README Shared plan state | V3.2 (card) |
| Hosts: cmux pane, desktop browser pane, terminal link, cloud (no page), CI | README Where it runs | V3.1 |
| `served at <url> (host: …)`, `doctor`, `SEAMUX_HOST` | README Where it runs | V3.1 |
| `install-repo` for cloud sessions, `--check` | README Where it runs | V3.3 |
| Observability stack read before planning (Datadog/Splunk/Grafana) | README Integrations | S-dp-checks-review (Datadog check) |
| TypeSafe citation check on render | README Integrations | S-dp-evidence (warning, if shown) |

## lookout

| feature | source | shot |
|---|---|---|
| `lookout open`: branch, `--worktree`, `--range`, `--patch`; never touches the index | lookout/README.md | V1.7 |
| Source-Control layout, split/unified (`v`), `j`/`k`, whole-file highlighting, word marks | The page | S-lo-diff |
| Generated / lockfiles collapsed | The page | S-lo-diff |
| Path tree vs Risk order: high/medium/low bands, related-file rail with reason | The page | S-lo-risk |
| Findings from a fresh reviewer: severity, failure scenario, under its line, `n`/`p` | Findings and threads | S-lo-findings, V1.7 |
| Threads: comment on a line, reply, resolve, dismiss; agent replies live | Findings and threads | S-lo-findings, V1.7 |
| Only you close a finding unless `--agent-may-close` | Findings and threads | V1.7 (card) |
| Group notes + Overview (`o`) | Group notes | S-lo-overview |
| `--quiz`: question per risky group, note hidden until answered; wrong answer reaches the agent | Group notes | S-lo-quiz, V1.7 |
| `plan-drift` finding | Group notes | S-lo-findings (if in fixture) |
| `lookout gate` holds an increment while a blocker/major is open | Reviews in a plan | V1.7 |
| Cloud: `export-artifact` → Artifact, `lookout pull` brings comments back unverified | README, Reviews across machines | V3.4 |

## restack

| feature | source | shot |
|---|---|---|
| `restack plan`: stack, base, colliding generated artifacts | restack/README.md | V4.1 (terminal) |
| `restack run`: regenerates generated conflicts, stops only for yours (exit 2, hunk counts) | restack/README.md | V4.1 |
| Expensive artifacts marked stale; `check`/`push` refuse | restack/README.md | V4.1 (card) |
| `restack check --deep` | restack/README.md | V4.1 |
| `restack push` prints, never pushes; bash-guard blocks force pushes | restack/README.md | V4.1 |
| Graphite aware | restack/README.md | FEATURES only (needs a Graphite repo) |

## humanize

| feature | source | shot |
|---|---|---|
| Rewrite a draft: strip AI tells, untangle hard sentences | humanize/README.md | V4.3 (before/after) |
| `scan.py` flags mechanical tells with line numbers | humanize/README.md | V4.3 (terminal) |
| Other skills run it on their prose | humanize/README.md | V4.3 (card) |

## bash-guard

| feature | source | shot |
|---|---|---|
| Blocks destructive commands, `--no-verify`, force pushes from agents | bash-guard/hooks | V4.2 (terminal) |

## seamux-mods

| feature | source | shot |
|---|---|---|
| `/plan-pane`: increments, checks, `go next` / `done` / `run checks` / `variant ready`, `open plan` | seamux-mods/README.md | S-plan-pane |
| Gate band above the prompt with `go next`, `open plan`, `dismiss` | seamux-mods/README.md | S-gate-band |
| Status entry: progress, open increment, running checks, cache clock | seamux-mods/README.md | S-plan-pane |
| Ask toast | seamux-mods/README.md | FEATURES only (README: not visible while the dialog is up) |

## crew

| feature | source | shot |
|---|---|---|
| Board ranked in tiers: needs you, broken, working, done, quiet | crew/board/README.md "The ranking is the product" | S-crew-board, V5.1 |
| Card: tier rail (click jumps), worktree color, last message, chip row, branch/PR/spend footer, folds | "Reading a card" | S-crew-board |
| Family card: parent with workstreams nested, pips, `all N done` | "Reading a card" | S-crew-family, V5.1 |
| Signal badges: CI, review state, conflicts, draft, Jira, `⇣ parent open`, `stuck`, unpriced spend | crew/README.md "Signals on the board" | S-crew-board |
| Chips: `go N`, plan, diff, pr, checks, sandbox, allow/deny with reply window, jump, reclaim, archive | "Parity with the Swift sidebar" | S-crew-board, V5.1 |
| Whimsy: cat and sky by hour | board README "Whimsy" | V5.1 |
| News footer: one sentence per workspace or family | "The news footer" | S-crew-news, V5.1 |
| `/plan/<slug>` served into the Dock | "Serving a plan" | V1.2 (cmux route card) |
| `/usage`: 5h window, daily bars, week by model, dollars per workspace | "The spend dashboard" | S-crew-usage, V5.2 |
| Usage-billing layout: month card and pace | README Usage-based billing | S-crew-usage-billing |
| Cache: status-line freshness clock, `/usage` cache panel | README Cache | S-crew-cache, S-crew-statusline, V5.2 |
| Cache: desktop stale warning, break report after a turn | README Cache | not filmed: a macOS notification and a live session |
| Status line: title, usage, cache segment | crew/claude/statusline.py | S-crew-statusline |
| Notifications on transitions; TypeSafe promotes a turn-end question to Needs you | "What puts a row in Needs you" | V5.1 (card) |
| `crew-digest` and `--paragraph` | "The morning digest" | S-crew-news (the digest prints the same sentences; not filmed, it reads your real repos and `gh`) |
| `crew-resume`: fuzzy finder over live / archived / past sessions | "Sessions" | not filmed: reads your real transcripts |
| `crew-sweep`: one card at a time cleanup | "Sweep" | not filmed: reads your real worktrees |
| Reclaim: dry-run report with its guards | "The one tap that asks first" | S-app-reclaim |
| The Wake: artifact log, keep / publish | "The Wake" | S-app-wake |
| Diff chords and `crew-diff` picker | "Diffs" | S-crew-board (the `diff` chip); the picker needs real cmux |
| One color per worktree everywhere; `crew-code` | "One color per worktree" | S-crew-board (card) |
| Sandboxed worktrees (`crew-sandbox`) | "Sandboxed worktrees" | S-crew-board (the sandbox chip on search-index) |
| Integrations: Jira chip, GitHub Issues chip, observability, main repo | "Options" | S-crew-board |
| Remote Control: board and approvals in the Claude phone app | "Remote Control" | not filmed: needs a real account and phone |
| `crew status`, `doctor`, `on`/`off`, `adopt`, `sync` | "Commands" | not filmed: they read and change your real setup |

## The seamux app

| feature | source | shot |
|---|---|---|
| ⌥Space overlay over any app, tray icon, no Dock icon | README, shell.rs | V6 (card) |
| Header: `cmux · N workspaces` pill, ⋯ menu | app/ui/main.ts | S-app-dock |
| Dock tab: board, the selected agent's terminal, Wake and open pages, splitters | dock.ts | S-app-dock, V6.1 |
| New workspace form (⌘N): repo, branch, first prompt, live steps | newws.ts | S-app-newws, V6.2 |
| Reclaim wizard: guard checks, what goes, Reclaim | reclaim.ts | S-app-reclaim |
| Mosaic: every pane a tile sized by urgency, reply, mute/tuck | mosaic.ts, wall.ts | S-app-mosaic, V6.3 |
| Wall: ranked panes, reply box, Jump, `j`/`k` | wall.ts | S-app-wall, V6.3 |
| Timeline: two-hour lanes of who waited, families grouped, reply inline | timeline.ts | S-app-timeline |
| Wake tab | wake.ts | S-app-wake |
| Lookout tab: review jobs with live steps, findings | review.ts | S-app-lookout |
| Tucked chip, ⌘K palette, undo toast | palette.ts, tuck.ts | V6.3 |
| Pane chips `[plan]` / `[outside]`; links open in VS Code, Dock, PR hover cards | panechips.ts, panelinks.ts | S-app-dock (card) |
| Decision cards, answer by digit, plan go/check | mosaic.ts, decisions.ts | V6.1 |

## Team rollout (docs/ADOPTING.md)

| feature | source | shot |
|---|---|---|
| Install, `--check`, first plan | §1 | V3 (card) |
| Committed `.seamux/verify.json`, `check run` in CI, `proof --attach` | §2 | V3.3 (terminal) |
| Cloud: `install-repo` for both plugins, the remote-only hooks | §3 | V3.3 |
| lookout `export-artifact` / `pull` | §3 | V3.4 |
| Families across people, `go: "parent"` | §4 | V2 |
| Shared state branches, `state status`, `SEAMUX_STATE_*` | §5 | V3.2 |
