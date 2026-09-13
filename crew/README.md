# crew

A cmux layer that answers one question at a glance: **which of my agents needs
me, and what was it doing?**

Twelve worktrees of one Ruby monolith, a dozen Claude sessions, and a habit of
walking away mid-turn. cmux already renders all of that; crew fills in what it
cannot know on its own — which branch's ticket a workspace belongs to, how far
through its plan Claude is, and whether a finished turn actually left something
worth looking at.

```
  Claude Code hooks ──▶ crew-hook.sh ──▶ cmux socket ──▶ sidebar / Dock / board
       │                                     ▲
       └── ~/.claude/tasks/<session>/*.json ─┘
              (authoritative plan state, read not parsed)
```

## Why these things and not others

Built against measured usage, not guesses. From `~/.claude/usage-data`
(67 sessions, 19.3M output tokens):

| Signal | Measured | What crew does about it |
|---|---|---|
| Time to answer Claude | median 203s, **40% >5min**, 76 >20min | Notification triage + the board, so coming back is cheap |
| Session length | median 238 min | Long-lived workspaces earn real names and progress bars |
| Worktrees | 12+ on one repo | Ticket naming, stable per-ticket color, group icons |
| Tool mix | Bash 2382, Edit 1130, Task\* 152 | Dock puts the verification loop on screen; plan goes to the sidebar |
| Subagents | 73 `Agent` calls | `suppressSubagentNotifications` on |

Everything is reversible in one command, and nothing here can fail a Claude
turn: every hook exits 0 and every cmux call is fire-and-forget.

## Opening the board

Any of:

| How | What it does |
|---|---|
| **`cmd+k c`** | mounts it as the left sidebar — its home |
| Right-click the **sidebar toggle button** → **crew** | same, by mouse |
| `cmux sidebar select crew` | same, from a terminal |
| `cmux sidebar open crew` | full-width pane instead |

`cmd+b` toggles the left sidebar itself. If the board does not appear after
selecting it, the sidebar is just hidden — there is no CLI to reveal it
(`right-sidebar show` only covers the right one), so that keystroke is the way.

The pane variant is for editing `sidebars/crew.swift` — it hot-reloads on save —
but the layout is tuned for sidebar width and reads very loose full-width.

## Layers

| Layer | What it does |
|---|---|
| `hooks/crew-hook.sh` | One entry point for every Claude hook event |
| `hooks/progress.sh` | Plan → progress bar, checklist, in-flight pill |
| `hooks/triage.py` | Decides which notifications earn a banner |
| `sidebars/crew.swift` | The board: Needs you / Planning / Working / Review / Idle |
| `config/cmux.jsonc` | Settings, workspace groups, actions, plus-button |
| `config/dock.json` | Checks / Git / Spec / DB, for the monolith |
| `bin/crew-diff` | Turn / branch / PR / per-commit diffs, one keystroke away |
| `bin/crew-code` | The VS Code desktop app, one window per worktree |
| `bin/crew-worktree` | New worktree in any repo, able to commit, + Claude |
| `bin/crew-spec` | The gems/core harness, prerequisites and all |

## What each Claude hook event does

| Event | Effect |
|---|---|
| `SessionStart` | Workspace → `PROJ-961 · graphql-db-schema-updates`, tab → `dir · branch`, color hashed from the ticket |
| `PreToolUse` | Release any lane override so cmux resumes inferring `working` |
| `PostToolUse` on `Task*` | `set-progress`, `todo set`, and a pill naming the task in flight |
| `Notification` | `phase:waiting` — the *only* thing that opens "Needs you" — lane → `needs-attention`, banner |
| `Stop` | Clear `phase`, so the row leaves "Needs you"; lane → `review` **only if** the tree is dirty or ahead of upstream; clear the pill; sidebar-only turn record |
| `SessionEnd` | Release the lane, clear the pill |

## Diffs

`cmd+k` is the prefix, free in both cmux's bindings and Ghostty's.

| Chord | Opens |
|---|---|
| `cmd+k d` | the picker — turn, branch, PR, and every commit on the branch |
| `cmd+k t` | changes since Claude's last turn |
| `cmd+k b` | branch vs merge base |
| `cmd+k u` | unstaged |
| `cmd+k p` | the open pull request |

cmux's own `cmux diff` has `--unstaged`, `--staged`, `--branch` and
`--last-turn` built in, but no per-commit source. Since it renders any unified
patch handed to it on stdin, `git show <sha> | cmux diff -` fills that in — which
is all `crew-diff <n>` is. Ranges work the same way: `2-4` in the picker diffs
the 4th-newest commit through the 2nd.

```
crew-diff                  the picker
crew-diff turn             since the last agent turn
crew-diff branch [base]    vs merge base (default origin/HEAD)
crew-diff pr               the open PR, vs its own base
crew-diff commit <ref>     one commit
crew-diff range <a> <b>
crew-diff <n>              the nth commit in the picker list
```

Two things it does that `cmux diff` alone does not: it refuses to open an empty
viewer on a clean tree, and `turn` still works from a Dock pane or a second
split. (`--last-turn` is scoped to the *calling* surface's baseline, so
`crew-diff` resolves the workspace's Claude session from the hook store and
passes `--session` explicitly.)

## Sessions

`cmd+k r`, or `crew-resume`. Also a **Sessions** Dock control.

Claude keeps one JSONL transcript per session under `~/.claude/projects/`.
There are **324 of them across 46 projects** here, which is well past what
`/resume`'s own list is comfortable for — so this is a searchable picker.

```
crew-resume              this repo's sessions
crew-resume --all        every project
crew-resume moto         open pre-filtered
crew-resume --reindex    force a full rebuild
```

| Key | Does |
|---|---|
| type | filter live — space-separated terms all have to match |
| `⏎` | resume in a **new workspace** at that session's cwd |
| `^T` | resume **here**, in the current tab |
| `⇥` | toggle this-repo / all-projects |
| `^R` | reindex |
| `esc` | out |

Rows show age, branch (or repo when unscoped), and a title: the session's
`ai-title` when it has one, else its first prompt. Only 31 of 324 have a
generated title — it is a recent addition — so the first prompt carries most of
them.

Scoping is by **repo family**, not directory: from a worktree you still see
sessions from its siblings and the primary checkout. That is 293 of the 324
here.

**`no cwd` means the directory is gone.** 94 sessions — 29% — point at worktrees
that have since been removed. Those cannot be resumed, and the picker says so
rather than handing you a broken `--resume`.

Indexing 324 transcripts takes **0.39s** cold and 0.01s warm; the cache is keyed
on mtime and size, so only changed transcripts are re-read. Transcripts run to
tens of megabytes, so each is read as a slice from each end — the fields worth
having sit in the opening records (cwd, branch, first prompt) and near the close
(`ai-title`, `last-prompt`).

### Why this is not part of the board

The board would be the obvious home, and it cannot work there. The custom
sidebar interpreter has no `@State`, so `TextField` and every other input
control is unavailable — there is no way to express a search box. It also binds
only to cmux's own workspace data; arbitrary files like Claude transcripts are
not reachable. See FINDINGS.md.

## VS Code

```
crew-code           open or focus the window for this worktree   (cmd+k e)
crew-code <path>    the same, for a specific worktree
crew-code status    whether this worktree has a window, and what else is open
crew-code windows   one open window folder per line (machine readable)
```

The **desktop app**, one window per worktree. There is no server, no port, and
nothing to stop — closing the window is the whole teardown.

**Why not `serve-web`.** crew used to run `code serve-web` in a cmux browser
pane, which kept the editor beside the agent terminal. It cost too much:
serve-web runs out of its own extension directory carrying only VS Code's
built-in extensions, so every marketplace plugin was missing, and its
workspace-trust store shares nothing with the app, so every worktree asked to
be trusted again. Both are structural, not configuration. See FINDINGS.md.

**One call does everything:**

```sh
code <worktree-root> --goto <file>
```

No window on that root and a new one opens there; a window already has it and
that window is focused with the file added as a tab — no duplicate window, no
reload. ~1.2s either way.

Naming the root is not optional. `code --goto <file>` alone routes correctly
only when some window already contains the file; for a worktree with no window
it silently drops the file into whatever window was last active, so you get the
right file with another branch's Source Control beside it.

**Folder and branch.** `crew-code` resolves the worktree root, so running it
from `gems/core` still opens the whole repo. A git worktree carries its own
HEAD, so the folder is what selects the branch — open the PROJ-961 worktree and
VS Code's Source Control is on `dev/…-proj-961`, with no extra wiring. Routing is
path-exact rather than basename-matched: the primary checkout's `Rakefile` and a
worktree's `Rakefile` each land in their own window.

**Cmd-click.** `app.preferredEditor` points at `crew-code-open`, so Cmd-clicking
a path in a terminal — and double-clicking in the file explorer — opens that
file in its worktree's window. cmux appends only the path (see FINDINGS.md), but
`crew-code-open` also accepts a `:line` or `:line:col` suffix and carries it
through to `--goto`, which is what makes it useful by hand.

This needs `app.openSupportedFilesInCmux: false`, which crew sets. Otherwise
cmux previews every file type it can handle and `preferredEditor` only ever
sees the leftovers, so a `.rb` click would never reach VS Code. The cost is
that PDFs, images, and video go to VS Code too — it renders images fine and
PDFs poorly. Flip it back to `true` in `config/cmux.jsonc` if you miss the
built-in previews more than you want code in VS Code.

Files outside any git repo fall through to the macOS default app, deliberately:
cmux falls back on a nonzero exit, and `crew-code-open` uses that.

### Trust `~/code` once

Every worktree is a path VS Code has never seen, so an untrusted parent means a
**trust modal on every new worktree** — and declining leaves the window in
Restricted Mode with extensions disabled, which is the problem this was meant to
solve. Open any worktree once and choose:

> **Trust the authors of all files in the parent folder `code`**

That covers every worktree ever created under `~/code`. `crew doctor` checks for
it and warns while it is missing.

### Reclaimed worktrees leave their window behind

`crew-reclaim` deletes the directory, and any VS Code window still on it stays
open showing an empty tree. Nothing can close it from the CLI: VS Code ships no
`code --close`, and the osascript route needs accessibility access. So reclaim
warns and you close it by hand.

## One color per worktree

With twenty worktrees open, "which window am I looking at?" should be answerable
from across the room rather than by reading a title bar. So each worktree gets a
color and wears it in all three places you look at it:

| Where | How |
|---|---|
| cmux workspace | `custom_color`, set by `crew-sync` via `workspace-action set-color` |
| crew board | a 3pt sliver down the row's leading edge |
| VS Code window | title bar, activity bar and status bar, via Peacock |

**cmux's `custom_color` is the source of truth.** This is the one crew signal that
needs no `description` token: `custom_color` is a first-class writable workspace
field, and the sidebar DSL already binds it as `w.color` — the same field cmux
paints its own workspace strip with. The board reads it directly, so the color is
also right in cmux's native sidebar for free.

The palette is cmux's own sixteen workspace colors — the same set already in
`crew_ticket_color`, which turns out to be exactly cmux's named colors
(`Amber` really does resolve to `#7D6608`). There are twenty worktrees and sixteen
colors, so allocation prefers a hash-derived slot when it is free, and otherwise
takes the least-used one rather than piling onto whichever the hash liked.

**crew only ever fills a blank.** cmux's own picker offers exactly these sixteen
colors, so crew cannot tell its own assignment from one you chose by hand — and
guessing wrong would mean silently overwriting a deliberate choice. So a color
already set is *adopted*, never overruled, and it propagates out to VS Code like
any other. To move one deliberately: `crew color free`, clear it in cmux, sync.

Peacock has no CLI and `code` cannot invoke an extension command, so the only way
in is `<worktree>/.vscode/settings.json`. That is safe because `.vscode/` is
gitignored by the monolith itself, inside worktrees too — the settings never dirty
the tree. `crew-code` writes them before launching, so a new window comes up
already colored, and VS Code picks the change up live on a window already open.

```
crew color list          the map — every color, who holds it, what was hand-set
crew color show [path]   this worktree's color and whether Peacock has it
crew color apply [path]  write the Peacock settings
crew color free [path]   release the color and remove the Peacock settings
crew color prune         drop entries whose worktree is gone
```

## Whimsy

There is no `@State` and no animation API, but the sidebar re-evaluates about
once a second and `clock` is bound — so anything that is a pure function of
`clock.second` animates. A 1Hz frame clock. That is also why none of this costs
anything: no timers, no state, just arithmetic, in the spirit of the Ghostty
engine's zero-idle-cost rule.

| | |
|---|---|
| **Breathing dot** | only a *working* row's dot breathes, so any motion on the board means something is genuinely running |
| **Wilt** | a row waiting on you fades as it ages — full for 5min, easing to a 0.72 floor over the next hour. Tuned to measured reply times so an ordinary reply never wilts and only forgotten rows reach bottom |
| **Progress ring** | `.trim` arc around the dot, replacing the old 150pt bar; reads at a glance and gives the row's width back to the message |
| **Idle recedes** | idle rows desaturate to grey at 50% so the board foregrounds what matters |
| **Color sliver** | the worktree's identity color down the row's leading edge. Applied *after* the idle desaturation on purpose — idle rows are exactly where you hunt for a worktree, so the sliver keeps its hue and only dims |
| **Tick spinner** | the ⠋⠙⠹ cycle on working rows. At 1Hz it ticks rather than spins — more heartbeat than throbber |
| **Planning diamond** | `◇` plan mode, `◈` a pending deep-plan — in the spinner's slot, not beside it. Both answer "what is this row doing" and planning is the more specific answer |
| **Merged twinkles, then nags** | ✦✧·✧ on shipped rows, decaying into "reclaim this worktree" after an hour |
| **Time of day** | header glyph and tint drift ★ → ☀ → ◑ → ☾ with `clock.hour` |
| **Refresh button** | `↻` in the header forces a full reconcile. It ticks continuously — the only "still alive" feedback available without `@State` |
| **Freshness** | the age beside `↻` is how long ago signals were last reconciled, tinted grey/amber/red as it drifts. See *How stale can the board be* |
| **Chime** | whimsy's own `chime.wav`, on good news only — CI back to green, approved, merged. Bad news already arrives as a banner, and a pleasant sound on a failure trains you to dread it |

Nothing wilts or breathes below full opacity zero: a view at opacity 0 is not
reliably hit-testable, which would punch holes in the click target.

## Signals on the board

cmux binds no CI, no review state and no agent lifecycle, so crew publishes all
of it as tokens in `description` — the one bindable, writable field — and the
board decodes them into badges.

### Planning rather than doing

A row shows a diamond in place of its spinner when the agent is thinking instead
of typing. Two independent sources, one glyph:

| Glyph | Token | Means |
|---|---|---|
| `◇` | `plan:mode` | Claude Code is in plan mode — proposing, not editing |
| `◈` | `plan:deep` | a `/deep-plan` is rendered and its alignment check has not passed |

`plan:mode` is read from the session transcript, where Claude Code appends a
`{"type":"permission-mode",...}` line every turn. It carries no timestamp, so the
*last* one is the current mode; crew tail-reads 256KB rather than the whole file,
because these transcripts reach 8MB and this runs on every turn end. It is gated
on the session being alive — the transcript keeps its last value forever, so
without that gate every session that ever planned would still look like it was.

`plan:deep` cannot be read from anything cmux or Claude Code exposes, so
`render_plan.mjs` leaves a marker in `~/.claude/deep-plan/active/` and
`grade_quiz.mjs` removes it when the check passes. That makes the badge's lifetime
exactly *a plan is on the table and nobody has signed off*. The marker records
both the session id and the git root, and crew matches either: the session id is
exact but dies on restart, the root survives `/compact` but is wrong if the
renderer ran from outside the worktree.

Two workspaces open on the same worktree both show the badge, which is correct —
the plan belongs to the worktree, not the pane.

Both states get their own section, **Planning · not editing yet**, sitting between
"Needs you" and "Working". They are exactly the two states where nothing is being
edited: plan mode is read-only by construction, and a deep-plan blocks edits until
its check passes. `plan:gate` and `plan:work` do *not* go there — those are
post-agreement, the plan is signed off and increments are being authorized, so
those rows belong with the work.

It outranks `phase:working` and not `phase:waiting`. An agent blocked on a
question is the more urgent fact, and the ◇/◈ glyph still rides along on the row
wherever it lands.

**A planning worktree cannot be reclaimed.** Both the section and the guard fall
out of the same rule: an open plan is unfinished work that `git status` cannot
see, and in the deep-plan case the plan outlives the worktree — delete the tree
and what you lose is the thing you were about to build, not the build.

```
  ✗ a deep-plan is awaiting its alignment check — sync-loan-purpose-ofs-to-pas (0/3 increments done)
    finish it, or if it is abandoned remove: …/deep-plan/active/sync-… …/deep-plan/state/sync-….json
  ✗ a session here is in plan mode: handle-purpose-change (workspace:19)
    leave plan mode there, or close it — crew-sync drops the token within 120s
```

Plan mode comes off the board's own `plan:mode` token, so it is at most one sync
stale. The deep-plan check reads `~/.claude/deep-plan` directly, from **two**
places, because each covers the other's blind spot: `active/<slug>` is written at
render time and its `CWD` is wherever the renderer ran — for a spec rendered from
the keys directory that is not the worktree at all — while `state/<slug>.json`
carries the plan's real `root`. One plan, one blocker: a plan in review has both
files, and they are merged by slug rather than reported twice.

Nothing is forced past it. If a plan really is abandoned the blocker names the
files to remove, because nothing prunes them today — a dropped plan otherwise
badges its worktree forever.

### What puts a row in "Needs you"

Exactly one thing: `phase:waiting`, which `hooks/crew-hook.sh` publishes on
Claude's own **Notification** event and clears on **Stop**. Nothing else opens
that bucket.

Two things used to, and both were wrong:

- **cmux's `needsInput` lifecycle.** `crew-sync` reconciled phase from it, but
  `needsInput` only means "Claude is sitting at its prompt" — equally true of an
  agent blocked on a question and one that finished an hour ago and was left
  open. It re-added the very token Stop had just cleared, so every idle Claude
  session parked itself in "Needs you" until you closed the terminal. It also
  outranked `gone:merged`, so shipped worktrees showed up as urgent instead of
  reclaimable. `crew-sync` now **keeps** a hook-published `phase:waiting` when
  the lifecycle is `needsInput`, but never mints one; `running` still reconciles
  to `phase:working`, which cmux really can vouch for.
- **The workspace's unread count.** Any pane can raise it — a shell bell, a
  finished command, output in a background split — none of which is Claude
  asking you anything. It no longer affects bucketing; it still shows as the
  header badge.

The `needs-attention` lane follows the same rule now: no `phase:waiting`, no
lane. Previously only a mid-turn agent released it, so a session that got
answered and then went quiet kept the lane indefinitely.

| Badge | From |
|---|---|
| `✗ CI` / `● CI` / `✓ CI` | the PR's check rollup — RWX, Buildkite, mergefreeze, all of it |
| `✓ approved` / `↻ changes` | `reviewDecision` |
| `⚠ conflicts` | `mergeable: CONFLICTING` |
| `draft` | `isDraft` |
| `⊙ in progress` / `⊙ in review` / `⊘ blocked` / `⊙ done` | the ticket's Jira status, via `acli` |
| `⇣ parent open` | stacked on a branch that has not merged yet |

Everything on a row is clickable, and each one **acts on that row's workspace,
not on the one you are standing in** — the workspace id rides along on the
notification and the hook resolves the worktree from it before firing anything.
Otherwise a tap on row 3 would act on whichever row you happen to be standing on:

| Tap | Does |
|---|---|
| the branch name | opens that worktree in the VS Code app — a new window, or focus for the one already on it |
| `#51158` | the PR, in your default browser |
| `✗ CI` | that PR's checks page, in your default browser |
| `▣ sandbox` / `▢ sandbox` | stops / starts the sandbox |
| `allow` / `deny` / `read it →` / `jump →` | answer or escape a live Feed ask |
| `shipped · reclaim this worktree` | opens a terminal where you are, dry-runs the reclaim in it, and asks |
| `↻` in the header | forces a full reconcile |
| anywhere else on the row | selects the workspace |

Links use `openURL`, which is a first-class action command in the sidebar DSL
alongside `cmux` and `log`, and which the host runs as `NSWorkspace.shared.open`
— so a PR or a checks page lands in the default browser that is already signed
into GitHub. The embedded cmux browser is a separate cookie jar; keeping PRs in
it meant re-authing against a session that lives somewhere else.

These are also the only taps that do **not** select the row's workspace first.
They used to have to — `browser.open_split` without a `workspace_id` puts the
split wherever you happen to be standing — but a system-browser handoff has no
workspace, so the select would only serve to yank you out of whatever you were
working in.

`config/cmux.jsonc` finishes the job for links reached some other way — a URL
clicked in a terminal, `open https://…` from a shell, cmux's own sidebar PR row.
`browser.hostsToOpenInEmbeddedBrowser` is an **allowlist** of hosts that stay
inside cmux, and it now holds only Jira and mergefreeze: things you read. GitHub,
`cloud.rwx.com` and Buildkite are off it, so anything needing that login leaves
cmux by every route.

Do not "turn it off" by emptying that list. `[]` means *no restriction* — every
link stays inside, the exact opposite. The off switch is
`openTerminalLinksInCmuxBrowser` / `interceptTerminalOpenCommandInCmuxBrowser`.

### The one tap that asks first

Every other chip performs its verb. `shipped · reclaim this worktree` does not:
it opens a terminal split in **the workspace you are looking at**, runs the dry
run there, and leaves a `y/N` at the bottom.

```
→ checking ~/code/main-repo.worktrees/auto-reconnect-db-failover
→ fetching origin
→ asking sbx about the sandbox

reclaim dev/auto-reconnect-db-failover
  worktree  …/main-repo.worktrees/auto-reconnect-db-failover
  branch    dev/auto-reconnect-db-failover
  size      715M
  sandbox   registered (absent)

  ✓ linked worktree, not the primary checkout
  ✓ merged: HEAD is an ancestor of origin/master
  ✓ clean tree, nothing uncommitted
  ✓ no plan is open on this worktree
  ✓ this shell is not inside it
  ✓ no other cmux workspace is open here
  ✓ sandbox is not running (absent)

Would remove
  · worktree   …/auto-reconnect-db-failover (715M)
  · branch     dev/auto-reconnect-db-failover (safe delete; kept if git declines)
  · sandbox    the microVM and its image cache

Proceed? [y/N]
```

Three reasons it works this way rather than deleting on the tap:

- **A chip is one stray click from a gigabyte.** The row is tappable too, and
  the two targets are millimetres apart.
- **Every guard is worth seeing even when it passes.** `crew-reclaim` used to
  print the first reason it refused and exit; now it evaluates all of them and
  reports the lot, so "why won't it?" is answered in one pass instead of by
  fixing one thing at a time and re-tapping.
- **The terminal has to be somewhere else.** Reclaiming *closes* the workspace
  before it deletes the directory, so a prompt living inside it would be
  SIGHUPed halfway through. The hook picks the focused workspace, and falls back
  to any other one if that happens to be the target.

Same thing by hand, and the same report either way:

```bash
crew-reclaim --dry-run <path|workspace-id>   # report only, exit 1 if blocked
crew-reclaim <path|workspace-id>             # report, then ask
crew-reclaim --yes <path|workspace-id>       # report, then go
```

Without a tty there is nobody to ask, so it reports and proceeds — which is what
any script or detached caller still gets.

The pane is respawned into the command rather than typed into a shell: this zsh
takes ~3s to be ready, and text sent before that gets echoed raw and then redrawn
under the prompt, so the command appears twice and reads like a bug. It `exec`s
a login shell when the reclaim finishes, so the output stays on screen and you
have a prompt for whatever the report told you to do next.

### Telling clickable from decorative

The sidebar **cannot change the mouse cursor** — the interpreter has no hover and
no `pointerStyle`, and the host attaches nothing but a tap handler to a tappable
node (FINDINGS: *The sidebar cannot change the mouse cursor*). So the board draws
the affordance instead, and the rule is uniform:

| looks like | means |
|---|---|
| a **chip** — tinted rounded rectangle | tapping it does something |
| **underlined** text — the branch, `#51158` | tapping it opens something outside the board |
| bare coloured text — `✓ approved`, `⚠ conflicts`, the Jira badges | status only, inert |

Every tappable also has a tooltip naming the action, so hovering still tells you
what a tap will do. Tooltips are not a click signal, though: the inert badges
carry them too, because `⇣ stacked` and `↻ changes` need explaining. The one place
with no tooltip is the row background itself — a whole-row tooltip would fire
whenever the pointer rested anywhere on the board.

### Which section a row lands in

The row lands in exactly one section, first match wins:

| Section | What puts a row there |
|---|---|
| **Needs you** | `phase:waiting`, from the Notification hook and nothing else |
| **Planning · not editing yet** | `plan:mode` or `plan:deep` — see *Planning rather than doing* |
| **Working** | `phase:working`, or any activity in the last 90s |
| **Review** | an open PR, a dirty tree, or a plan at 100% |
| **Merged · can clean up** | PR merged/closed, or the branch is already an ancestor of `origin/master` |
| **Idle** | none of the above |

Merged is the cleanup signal for a worktree fleet: the branch shipped, so
the worktree is safe to remove. Worth having — 94 of the Claude sessions on this
machine already point at directories that were removed without anything noticing.

Jira rides one **batched** JQL search covering every ticket on the board —
~1.5s regardless of count, versus ~0.9s each one at a time — on a 15-minute
clock (`CREW_JIRA_INTERVAL`). The ticket key already lives in every branch name,
so nothing extra has to be configured.

The rest comes from **one** `gh pr view --json` call per PR (checks, review,
draft and mergeable together — no second `gh pr checks`). It costs ~1.6s, so it
runs only for workspaces that have a PR, on a 5-minute clock of its own
(`CREW_GH_INTERVAL`), in parallel. A full sync with GitHub lands around 3.5s;
without it, well under one.

**Notifications fire on transitions only** — green→red, a review landing,
conflicts appearing, the PR merging. Steady state is silent, which is the point:
with a dozen worktrees, "notify while bad" would fire constantly and get muted.
The first observation seeds the baseline without shouting. A failed refresh
keeps the previous signals rather than reading as "CI went green".

## Answering a blocked agent

A row that is waiting shows the ask. What it offers depends on whether crew can
*prove* the ask is still answerable:

| State | Board offers |
|---|---|
| live — pending, inside 120s, agent `needsInput` with a live pid | countdown, `deny`, and `allow` if it passes the gate |
| live but gated | countdown, `deny`, `read it →` |
| anything else | `jump →` |

**Why so conservative.** Feed's window is 120s and the median reply here is
203s, so the window is usually shut. And `status: pending` cannot be trusted —
two items in `feed.list` were marked pending at 61 and 33 days old. A button
that replies into a dead semaphore silently does nothing while looking like it
worked, which is worse than no button. See FINDINGS.md.

**What gates `allow`**, all four agreed up front:

- the command is run through `~/.claude/hooks/cmux/guard_bash.sh` first — if
  that guard would block it, the board shows `read it →` instead. Reuses a
  policy already trusted rather than inventing a second one.
- if the ask does not fit the row untruncated, no `allow`. A 40-character
  preview of a shell command looks identical whether or not something hostile
  is appended after it.
- `ExitPlanMode` is never one-tap. A plan is prose; approving it from a row is
  approving something you demonstrably have not read.
- every board-initiated reply is appended to
  `~/.cache/cmux-crew/feed-audit.jsonl`, refusals included.

`deny` is offered whenever the row is live, because denying into a closed
window is harmless — the worst case is a no-op and the agent keeps waiting.
Questions and plans are jump-only for now: their content cannot be rendered in
a row without the truncation the gate exists to prevent.

## The morning digest

`cmd+k m`, or `crew-digest`. Where the fleet stands, in one screen.

```
crew-digest              since 17:00 yesterday
crew-digest --hours 4
crew-digest --week
crew-digest --size       include the disk total (adds ~12s; du walks 20GB)
crew-digest --notify     post a one-line summary as a notification
```

Sections, each degrading to silence rather than failing the run: commits grouped
by branch, PRs merged / red / approved / awaiting review, sessions still sitting
waiting on you with how long, and worktrees that shipped and can be reclaimed.

It runs in ~10s. Three things got it there from 64s:

- **One `git log --all`, not one per worktree.** Worktrees share an object store
  and a ref namespace, so `--all` from the primary checkout already sees every
  branch. The 22-way fan-out was 22 scans of the same history for the same
  answer — 8s versus 0.4s.
- **`git status --untracked-files=no`** for the reclaimable check: 137ms per
  worktree instead of 613ms. Deliberately looser than `crew-reclaim`, which does
  the strict check and refuses — the digest lists candidates, not promises.
- **`du` is opt-in.** Walking 20GB of monolith checkouts was ~12s of the
  original 64.

## When state gets stuck

crew publishes on hook events, so anything that stops the events arriving leaves
published state pinned — and the event that would fix it is exactly the one that
never comes:

| Stuck | Because |
|---|---|
| pill and lane never clear | the agent was killed, hibernated, or crashed, so `Stop` never fired |
| progress sits at 3/7 forever | the plan was abandoned, or its task files were cleared while the session kept running |
| workspace named a raw path | the session predates `crew apply` |
| name is a lie | you checked out a different branch |

`crew sync` reconciles every workspace against state that is true regardless of
hooks: `agentLifecycle` and pid from cmux's own wrapper, the task directory, and
git. Every write is conditional on the current value being wrong, so a converged
system produces no output and no calls.

```sh
crew sync              reconcile now
crew sync --dry-run    say what would change
crew sync --prune      also drop stale crew state files
crew timer on|off      periodic reconcile via launchd (opt-in, 5 min)
```

**It runs itself.** The `Stop` hook triggers a throttled background sync at most
once every 120s. That is hung off turn-end rather than the `PreToolUse` hot
path — `Stop` fires once per turn instead of thousands of times, and because
sync reconciles *every* workspace, one active agent unsticks all the others. The
only gap is "everything idle and something is stuck", where nothing is changing
anyway; `crew timer on` closes that if you would rather not think about it.

### The reconciler

One always-on process does both jobs: it reconciles the instant a workspace is
created, closed, renamed or selected, and it ticks every 120s for everything crew
can only learn by asking — CI, review, Jira.

```
crew listen status | on | off | log
```

It is started by the **SessionStart hook**, not launchd, and that is not a style
choice. The cmux socket authorizes a caller by the `CMUX_SOCKET_CAPABILITY` it
inherits, and a launchd job has none — so `com.crew.sync` sat loaded for days
reconciling exactly nothing, silently, because crew-sync swallows failed cmux
calls. A hook runs inside a cmux terminal, so its detached child keeps the token.
`crew timer` is retired and will offer to remove the dead job.

The ticker runs on its own thread, deliberately independent of the event stream:
if cmux restarts or the stream dies, the board still reconciles on a clock instead
of freezing. The stream itself is retried with backoff rather than being allowed to
end the process.

The tick is aligned to the 120s throttle because a faster tick cannot reconcile
more often — it would just re-check the stamp. A converged `crew-sync` costs about
4.5s, nearly all of it subprocess spawns (`sidebar-state` and `workspace status`
are one call per workspace), so that is the lever if it ever needs to be quicker.

### Why badges used to flicker

Signals disappearing and coming back was one bug with three faces, all in how
crew-sync decided whether to *ask*:

- **It only asked gh when cmux already thought there was a PR.** cmux's `pr` field
  comes from its own snapshot-then-diff watch; when it blipped to `none`, crew
  skipped the probe, published a description with every `ci:`/`review:`/`pr:`
  token missing, and — because skipping also stopped the cache refreshing — stayed
  wrong until the field came back. Measured: 11 lost-then-restored cycles over two
  days, one gap of 17 minutes. It now asks whenever the cwd is a git checkout.
- **A failed fetch refreshed the cache timestamp.** One blip pinned the stale
  answer for another full TTL, and since the next run then read it as fresh it
  never retried. Found at five days old. Only a real answer earns a fresh
  timestamp now; a failure backs off to a 60s retry.
- **"No PR on this branch" was read as a failure**, which fell back to the
  previous cache — so a merged or deleted PR haunted its branch forever. That is
  how `master` wore a `gone:merged` badge from a PR closed days earlier. `gh` exits
  1 for both cases, so crew reads the message, not the exit code.

The rule underneath all three: **"I could not find out" is never published as
"there is nothing".** When a probe genuinely fails, crew now carries the previous
signal tokens forward and says so in the change log.

### How stale can the board be

Three different clocks, and telling them apart is the difference between reading
the board correctly and trusting a badge that has not moved in an hour:

| what | cadence | source |
|---|---|---|
| Re-render — the clock, `elapsed()`, the cat, the spinner | **~1s** | the sidebar interpreter, off `clock` |
| `phase:working` / `phase:waiting` | **immediate** | Claude's own hook events, no sync needed |
| Branch, dirty, PR presence | cmux's git watcher and PR poll | cmux, not crew |
| **CI, review, Jira, sandbox, `gone:merged`** | **only when `crew-sync` runs** | crew |

And `crew-sync` runs on turn-end (≥120s apart) or when you tap `↻` — nothing
else, unless `crew timer on`. So on a quiet afternoon with no agent finishing a
turn, the bottom row of that table simply stops moving.

Even when it does run, two caches sit behind it: GitHub results are cached for
`CREW_GH_INTERVAL` (**300s**) and Jira for `CREW_JIRA_INTERVAL` (**900s**). A
fresh sync can legitimately serve CI state five minutes old and a Jira status
fifteen minutes old.

**Which is why the header says so.** Next to `↻` is the age of the last
reconcile — grey under 4 minutes (the normal turn-end cadence), amber past it,
red past 15 minutes, and `never` if `crew-sync` has not completed a run since
these workspaces were opened. It reads the `synced:` stamp crew-sync publishes;
see FINDINGS for why exactly one workspace carries it.

Two rules keep it from doing harm:

- **It never renames a workspace you named.** Only titles that are clearly
  cmux's own fallback — a path, or the shell's `user@host` prompt — are
  eligible.
- **It never creates duplicate names.** Two workspaces can legitimately sit on
  the same branch; the second keeps its existing title rather than becoming a
  second row with an identical name. A workspace in a subdirectory gets the
  subdirectory appended (`PROJ-961 · graphql-db-schema-updates / playwright`).

## A session that started before crew

Claude Code binds hooks **at session start**. A session already running when
`crew apply` ran will never publish anything — no name, no progress, no lane —
and it fails silently, which is worse than failing loudly.

`crew status` tells you which case you are in:

```
this session
  hooks: not live — this session predates crew apply.
         run crew adopt to back-fill it now, or restart it
```

Two ways out:

```sh
crew adopt      # back-fill this workspace once: name, colour, plan, progress
crew-resume     # pick the session, ^T to restart it in place — hooks bind
```

`crew adopt` is a one-shot catch-up. It cannot make *future* turns publish;
only a restart does that, and `--resume` keeps the conversation, so restarting
costs almost nothing. Adopt deliberately skips the notification and lane events
— back-filling should not fire a banner or claim the workspace is blocked on
you.

## Commands

`crew apply` symlinks these into `~/.local/bin`, which is already on your PATH,
so they are plain commands — no shell-config edit. `crew uninstall` removes only
the links that still point back into the package.

```
crew status      what is installed and live right now
crew doctor      check the install; non-zero exit if something is wrong
crew apply       render config, install sidebar + Dock, wire Claude hooks
crew on | off    runtime kill switch (hooks stay wired, become no-ops)
crew uninstall   restore the pre-crew cmux.json, unwire the hooks
crew demo        fire each hook synthetically and show what changed
crew color       list | show | assign | apply | free | prune — identity colors
```

`crew-watch <seconds> <cmd...>`, `crew-spec [rspec-args]`, and
`crew-worktree [--repo <name|path>] [branch] [base]` are usable on their own.

### Which repo

`crew-worktree` is no longer monolith-only. It picks a repo in this order:

1. `--repo <name|path>` — a bare name resolves under `$CREW_CODE_ROOT` (`~/code`)
2. the current directory, when it is a **primary checkout**
3. a picker listing every checkout under `$CREW_CODE_ROOT`

Rule 2 is what makes the per-repo context menus work: cmux opens the action in a
tab that inherits the workspace's directory, so right-clicking a repo and asking
for a worktree gets you one for *that* repo with no prompt. A worktree is never
offered as a base for another worktree — its `.git` is a file rather than a
directory, which is how the two are told apart.

Worktrees land in `<repo>.worktrees`, the convention already on disk.
`CREW_WORKTREES` still overrides it for the monolith so existing setups keep
working, and is deliberately ignored for every other repo — otherwise choosing a
different repo would drop its worktrees into the monolith's directory.

The base branch comes from `origin/HEAD` rather than a hardcoded `master`, then
falls back to `origin/main` and `origin/master`. `eDSCR` is `main`; most of the
rest are `master`.

The commit-hook fixups stay guarded, so they no-op for repos that do not use
husky or node_modules — and the "run npm install" warning now fires only when a
repo *has* `.husky` but is missing its generated directory, which is the failure
it was written for.

## Sandboxed worktrees

`crew-worktree --sandbox [branch] [base]` builds the worktree exactly as usual,
then runs the agent — and its service stack — inside a Docker Sandboxes microVM
instead of on the host. Without the flag nothing changes.

```
crew-sandbox up      [path]      create if absent, register
crew-sandbox attach  [path]      run the agent inside (the workspace command)
crew-sandbox exec    [path] -- … run a command inside
crew-sandbox status  [path]      state + the mount set, or --json
crew-sandbox down    [path]      stop, keep the sandbox and its state
crew-sandbox rm      [path]      destroy it
crew-sandbox base                build/refresh the template image
crew-sandbox prune               drop registry entries and config dirs with no worktree
```

Requires `sbx` — the standalone CLI, **not** the deprecated `docker sandbox`
Desktop plugin:

```sh
brew tap docker/tap && brew trust docker/tap
brew install --cask docker/tap/sbx
sbx login
crew-sandbox base                # once, or every sandbox pays a full bundle install
```

Two things worth knowing, both measured in `FINDINGS.md`:

**The primary checkout is mounted read-write, on purpose.** A worktree's `.git` is
a pointer file into it, so without it the agent has no git at all — and sbx
v0.38.0 refuses to mount the monolith `:ro`. So the agent can write the primary
checkout and every worktree's history. The boundary that does hold is the outer
one: unmounted paths (other repos, `~/.ssh`, `~/.aws`) are invisible.

**`~/.claude` is never mounted read-write.** It would come back writable, letting
a sandboxed agent rewrite the hook entries the *host* Claude runs. Each sandbox
gets its own config directory at `~/.cache/cmux-crew/sandbox/claude/<name>`,
wired up through `CLAUDE_CONFIG_DIR` — which is needed regardless, since `$HOME`
inside is `/home/agent`.

### Carrying your Claude setup in

`crew-worktree --sandbox` asks; `crew-sandbox --claude=<mode>` sets it directly;
`CREW_SANDBOX_CLAUDE` changes the default for non-interactive runs.

| Mode | What the sandbox gets |
|---|---|
| `link` *(default)* | your `CLAUDE.md`, `commands/`, `skills/`, `agents/`, `plugins/`, and your login |
| `isolated` | nothing of yours; a clean Claude that has to `/login` on first use |

`link` mounts `~/.claude` as a **read-only** workspace and symlinks the
read-only parts of it into the per-sandbox config dir. Verified from inside: a
write there fails with `Read-only file system`, so the escape vector that ruled
out an rw mount is closed, and edits you make on the host show up inside with no
re-seed. Everything Claude writes — `projects/`, history, todos — stays in the
per-sandbox directory.

`settings.json` is copied and filtered rather than linked: `hooks` and
`statusLine` name host paths that do not exist inside, and a dangling hook makes
Claude report an error on *every* event. `mcpServers` goes for the same reason —
those are host processes.

The mode is fixed when the sandbox is created, because that is when its mounts
are. `crew-sandbox up` on an existing sandbox keeps the recorded mode and says
so; `rm` then `up` is how you change it. Sandboxes predating the flag report
`isolated (predates --claude)`.

**What `link` costs.** Your login is extracted from the macOS Keychain and
written to `<config-dir>/.credentials.json`, mode 600. That is the only way to
carry it — there is no credential file on disk to mount — and it means a working
OAuth token sits in plaintext on the host, readable by any process running as
you, and inside a sandbox whose agent could send it anywhere. `crew-sandbox rm`
deletes it; `prune` collects it with the directory. Subtler: Claude refreshes
that token in place when it expires and the Keychain never learns about the
rotation, so a long-lived sandbox can log you out on the host.
`--claude=isolated` never creates the file.

The board shows `▣ sandbox` when one is running and `▢ sandbox` when it is
stopped; both are tappable and toggle it through the notification-hook RPC.
`crew-spec` runs inside the sandbox automatically when one exists, which is the
real payoff — the sandbox has its own Docker daemon, so Postgres comes up
per-worktree and parallel worktrees stop fighting over 5432. `crew-reclaim`
refuses while a sandbox is still running.

## The one thing to know if it misbehaves

```sh
crew off
```

Hooks stay wired but become no-ops immediately — no reload, no restart, no
Claude restart. To go further back:

```sh
crew uninstall     # restores the newest ~/.config/cmux/cmux.json.*.bak
```

`~/.claude/hooks/cmux/guard_bash.sh` is **not** part of crew and neither command
touches it. It blocks force-pushes, `--no-verify`, `rm -rf`, and destructive SQL,
and `crew doctor` fails loudly if it ever stops being wired.

`crew uninstall` does **not** re-wire the v1 cmux bridge crew superseded. Those
scripts are untouched at `~/.claude/hooks/cmux/` — `on_session_start.sh`,
`on_stop_notify.sh`, `on_notification.sh`, `set_status_running.sh`,
`clear_status.sh`, `flash_on_edit.sh` — so restoring them is a matter of adding
their entries back to `settings.json`. crew intentionally does not do it for
you: it strips its own hooks surgically rather than restoring settings.json
wholesale, because that file also accumulates permissions over time.

## Cost

| Hook path | Cost | Fires |
|---|---|---|
| `pretool`, nothing to release | 9.1 ms | every tool use |
| `session` | 193 ms | once per session |
| `set_status_running.sh` (what crew replaces) | 51.5 ms | every tool use |

crew is ~5.7× cheaper per tool use than the bridge it replaces: the old hook
made an unconditional socket call every time, crew makes none unless a lane
override is actually outstanding. The `pretool` path short-circuits before
`lib.sh` is even sourced — see FINDINGS.md.

## Deliberate choices

**`automation.workspaceAutoNaming` stays off.** cmux can AI-name workspaces from
conversation content. With a dozen worktrees of one repo, a deterministic
`PROJ-961 · …` beats a prose summary — you can find a ticket by scanning, and the
name doesn't drift between turns. Auto-naming would also fight `crew-hook.sh`
on every turn end.

**The `review` lane is conditional.** Pinning `review` on every `Stop` would park
question-answering turns in review and suppress cmux's own live inference.
crew checks for a dirty tree or unpushed commits first.

**The board reads a phase crew publishes, not the lane.** The sidebar
interpreter cannot read the workspace lane, and it cannot see whether an agent
is running: there is no `agentLifecycle` binding, and `latestAt` is the last
*message*, which stands still for minutes while Claude thinks. So crew mirrors
the phase into `description` — the one bindable, writable field — and the board
buckets on that, falling back to `unread`/`latestAt` only when no phase is
published. See FINDINGS.md.

**`flash_on_edit` is gone.** At 1130 Edits per sample it fired constantly, which
trains you to ignore the flash — the opposite of the point.

## Not tracked in git

Neither this nor `~/.config/ghostty/whimsy` is under version control yet. If you
ever make a dotfiles repo, take both at once.

## Remote Control — the crew from your phone

Every `crew-worktree` session starts with `--remote-control "<repo>/<branch>"`
(added 2026-09-12; `CREW_REMOTE=0` opts out). That attaches the local session to
your claude.ai account: execution stays on this machine, the phone is a window.

What you get, with zero custom code:

- **claude.ai/code and the Claude iOS/Android app** list your sessions by
  worktree name — the session list reads like the board's ranking, minus the cat.
- From the phone you can **send prompts, approve permission prompts, stop
  tasks, view uncommitted diffs, and switch model/effort**.
- Phone pushes when an agent needs you: `agentPushNotifEnabled` (task done) and
  `inputNeededNotifEnabled` (permission prompts / questions), both wired by
  `merge_settings.py`. Pushes are skipped while you are at the terminal.
- Sessions started before this change: type `/remote-control` in them.
- On another machine, `claude --teleport` resumes one of your remote sessions.

Limits, measured against the docs rather than hoped: there is **no API** for
listing or driving Remote Control sessions, so the crew board cannot act as a
remote controller — the claude.ai app is the remote surface. Sandboxed
workspaces (`crew-worktree --sandbox`) do not get the flag: the sandbox mounts
~/.claude read-only and remote control needs the host login; crew says so at
create time. Requires a claude.ai subscription login on this machine.

Plan sharing is a separate feature: see the deep-plan skill's "Share for
annotation" step — a plan published as a claude.ai artifact that invited
colleagues can annotate, with annotations pulled back into the working surface.
