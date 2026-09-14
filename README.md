# seamux

Run a fleet of Claude Code agents from one screen. seamux adds two things to
[cmux](https://cmux.io):

- **crew** — a Dock board that ranks your worktrees by who needs you right
  now, so a dozen parallel agents stay legible.
- **deep-plan** — a Claude Code skill that turns "make a plan" into a
  reviewable page with a quiz, then blocks the agent from editing until you
  approve each increment.

It scales with you. Out of the box it needs nothing but git and GitHub — a
laptop of hobby repos is fully served. When your projects have more — Jira,
GitHub Issues, a Datadog or Splunk stack — setup asks, and the board and the
planner put them to work. With Remote Control on, the same fleet shows up in
the Claude phone app.

## What it looks like

**The board.** One row per worktree, ordered by urgency: waiting on you,
broken, working, done, quiet. Each row shows its plan's gate, a progress
dial, the branch and PR (both clickable), today's spend, and one-tap chips —
`go 3` approves a plan increment without leaving the Dock. The cat naps when
nothing needs you.

![the crew board: four ranked rows with gate state, progress dials, cost facts and action chips](docs/img/board.png)

**Usage.** Tokens against your 5-hour and weekly budgets, a 21-day history,
and per-workspace dollars — so the worktree quietly burning money stands out.

![the /usage dashboard: window budget, daily bars, weekly budget by model, per-workspace dollars](docs/img/usage.png)

**A plan under review.** deep-plan renders the agent's plan as a page:
context, decisions, cited evidence, diagrams, increments — and a short quiz
that checks you and the plan actually agree. Answer on the page, highlight
text to pin comments, hit **Copy for session**, paste it back. Until the quiz
passes and you say `go`, the agent cannot edit anything in that worktree.

![a deep-plan review surface: the alignment quiz with selectable options](docs/img/plan-review.png)

*(Real renders of the shipped pages, loaded with demo data.)*

## Setup

### What you need

| | why | without it |
|---|---|---|
| macOS | cmux and the Dock are mac-only | nothing works |
| [cmux](https://cmux.io) nightly | the board lives in cmux's web Dock | files install, nothing shows |
| `python3` + `node` | board, intent server, probes, deep-plan | install refuses |
| Claude Code | the agents this is all for | not much point |
| `gh` *(optional)* | PR and checks chips on rows | those chips stay blank |
| `ccusage` *(optional)* | spend on rows and `/usage` | cost surfaces are absent |

### Install

```sh
git clone https://github.com/rickykoter/seamux ~/code/seamux
cd ~/code/seamux
./install.sh
```

It asks which repo your worktrees come from (or pass `--main-repo PATH`),
copies everything into place (an existing install is backed up first),
fetches a pinned, checksum-verified `mermaid.min.js`, and wires the cmux
config and Claude settings. The settings merge is additive — it never
rewrites anything it didn't add, and backs up `settings.json` first.

On an interactive first run it also asks which integrations this machine
uses; answers stick across re-installs, and everything stays off until you
say otherwise. Scripted installs use flags: `--with-jira=your.atlassian.net`,
`--with-github-issues`, `--with-observability=datadog`, `--no-integrations`.

Useful flags: `--dry-run`, `--check`, `--uninstall`, `--force`, and
`--no-<piece>` to skip parts (`--no-crew`, `--no-deep-plan`, …).

### Integrations (all optional)

- **Jira** — rows already badge `jira:<state>` from ticket-keyed branches;
  with a site configured the badge becomes a chip that opens `PROJ-123` in
  Jira. `crew doctor` checks `acli` only if you enabled this.
- **GitHub Issues** — rows link the PR's closing issue (or a `123-…` branch)
  as its own chip, riding the `gh` poll crew already makes.
- **Observability-aware planning** — point seamux at your Datadog/Splunk
  (`.seamux/observability.json` in a repo, or the machine-wide answer), and
  deep-plan reads your monitors, dashboards and runbooks before drafting:
  what exists gets cited, what's missing becomes plan deliverables — new
  instrumentation, an importable monitor definition, a runbook section.
  Reads only: changes ship as reviewable artifacts you import, never direct
  API writes.

Declined integrations cost nothing: no nags in doctor, no dead chips, no
config to maintain.

### Check it worked

```sh
crew doctor                                      # everything green
node ~/.config/cmux/crew/board/board_probe.mjs
node ~/.claude/skills/deep-plan/probe.mjs
```

Open the board with `cmux sidebar open crew` or the Dock button. New Claude
Code sessions pick up the hooks; already-running ones don't.

Then try it: ask Claude for a "deep plan" of any change. You'll get the
review page, the quiz, and the per-increment gate.

### Uninstall

```sh
./install.sh --uninstall
```

Puts cmux's config back, moves the crew tree to a timestamped backup, removes
the skill and shim, and unwires only the settings it added. It deliberately
keeps `guard_bash.sh` (a safety rail should outlive its installer) and all
your plan state.

## The repo is the source of truth

Edit here, then `./install.sh` to sync. If you edited a live file instead,
`./install.sh --check` finds it — copy the change back into the repo, commit,
reinstall. (The five `crew/bin` files that bake your main-repo path get it
reverse-substituted to `__MAIN_REPO__`.)

You don't have to remember this: the installer records the repo path, and
`crew doctor` runs the drift check every time — drift is a red check, not a
discipline.

## Computer Use (optional)

cmux's Computer Use driver lets agents drive the browser and other apps in
the background. crew works fine without it; `crew doctor` just notes whether
it's set up.

1. In the cmux desktop app, open **Settings → Computer Use** (or the
   onboarding banner). A half-finished setup shows up to agents as "Computer
   Use onboarding is still in progress".
2. Approve the two macOS permission prompts for the cmux helper —
   **Accessibility** and **Screen Recording**. Approve them from cmux's own
   dialogs; if one was dismissed earlier, flip it in System Settings →
   Privacy & Security. Restart cmux if Screen Recording doesn't register.
3. Finish the wizard's self-test, then re-run `crew doctor`.

## Layout

| path | what |
|---|---|
| `crew/` | installed to `~/.config/cmux/crew` (see `crew/README.md`) |
| `deep-plan/` | installed to `~/.claude/skills/deep-plan` (see its `SKILL.md`) |
| `claude/` | statusline, guard hook, settings merger |
| `bin/deep-plan.shim` | installed to `~/.local/bin/deep-plan` |
| `docs/` | dev history, test notes, adoption audit, README images — not installed |

Never committed: rendered cmux configs, deep-plan state and keys, the mermaid
blob, your `~/.claude/settings.json`.
