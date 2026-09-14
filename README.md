# seamux

An agent cockpit for [cmux](https://cmux.io): the **crew** Dock board (who needs
you, right now), its cmux tie-ins (web-Dock browser surfaces, a loopback intent
server, Claude Code hooks, a SwiftUI sidebar fallback), and **deep-plan** — a
Claude Code skill that turns plans into gated, reviewable artifacts.

Built for a personal laptop with many hobby repos: no issue trackers, no
observability stack — git/GitHub only. Sessions launch with Claude Code
Remote Control so the fleet is also visible from the Claude phone app.

## A tour, in three screens

**The board.** Every worktree is one row, ranked by who needs you: waiting on
a human first, then broken, working, done, and a collapsed count of quiet
ones. Rows carry their plan's gate state, progress dial, branch and PR (both
click targets), today's spend, and one-tap chips — `go 3` authorizes a plan
increment right from the Dock. The cat naps when the board is clear.

![the crew board: four ranked rows with gate state, progress dials, cost facts and action chips](docs/img/board.png)

**The usage page.** Tokens against your 5h-window and weekly budgets, a
21-day history, and — the one card that speaks dollars — per-workspace spend,
today and over 7 days, so the worktree that is quietly burning money is
visible at a glance.

![the /usage dashboard: window budget, daily bars, weekly budget by model, per-workspace dollars](docs/img/usage.png)

**A plan's review surface.** deep-plan renders a spec into a reviewable page:
context, decisions with their whys, cited facts, diagrams, increments — and a
graded alignment quiz whose options are shuffled per plan. Answer in the page,
highlight any text to pin a comment to it, and **Copy for session** puts one
paste-back blob on your clipboard. Until the check passes and you say `go`,
a PreToolUse gate hard-denies edits inside the plan's root.

![a deep-plan review surface: the alignment quiz with selectable options](docs/img/plan-review.png)

*(All three are real renders of the shipped pages, with demo data.)*

## What you get

- **crew** (`~/.config/cmux/crew`) — worktree-per-agent workflow (`crew-worktree`),
  the Dock board above, the `/usage` dashboard, hooks that publish each agent's
  phase, per-workspace cost attribution (via `ccusage`), and `crew doctor`.
- **deep-plan** (`~/.claude/skills/deep-plan`) — spec → rendered plan + review
  surface + graded alignment quiz; a PreToolUse gate that hard-denies edits until
  each increment gets an explicit `go`; a refuse-first renderer that validates
  mermaid with the real parser (`deep-plan validate` re-checks any surface);
  optional publish-for-annotation via Claude artifacts.
- **Claude side** — status line (usage window), `guard_bash.sh` (blocks force
  pushes / recursive deletes), settings merged additively by
  `claude/merge_settings.py`.

## Setup

### 1 · Prerequisites

| what | why | required? |
|---|---|---|
| macOS | cmux, the Dock, the sidebar and the VS Code hand-off are mac-only | yes |
| [cmux](https://cmux.io) nightly | the Dock board renders in cmux's web-Dock browser surfaces | yes (files install without it, nothing drives them) |
| `python3` | the board collector, intent server, triage hook | yes |
| `node` | the board renderer, both probes, deep-plan | yes |
| `gh` | PR chips and checks on board rows | no — those chips stay blank |
| `ccusage` (`npm i -g ccusage`) | the status line, `/usage`, and per-workspace dollars | no — cost surfaces are simply absent |
| Claude Code | the hooks, the skill, and the point | yes |

### 2 · Install

```sh
git clone https://github.com/rickykoter/seamux ~/code/seamux
cd ~/code/seamux
./install.sh
```

The installer:

- asks which repo your worktrees come from (or takes `--main-repo PATH`;
  zero-arg re-runs reuse the path baked into the existing install),
- copies `crew/` → `~/.config/cmux/crew` (an existing install is moved aside,
  timestamped, first), the skill → `~/.claude/skills/deep-plan`, the shim →
  `~/.local/bin/deep-plan`, the statusline and guard → `~/.claude/`,
- fetches `mermaid.min.js` (3.4MB, pinned version, sha256-verified — it is
  never committed),
- hands over to `crew apply` (renders cmux config templates, wires hooks) and
  `claude/merge_settings.py` (additive only: it never rewrites an entry it did
  not add, and backs `settings.json` up first).

Flags: `--dry-run`, `--check`, `--force`, `--uninstall`, `--no-apply`,
`--no-claude-settings`, `--no-crew`, `--no-deep-plan`, `--no-mermaid`,
`--force-mermaid`.

### 3 · Verify

```sh
crew doctor                                      # every check green
node ~/.config/cmux/crew/board/board_probe.mjs   # board renderer probe
node ~/.claude/skills/deep-plan/probe.mjs        # deep-plan probe
./install.sh --check                             # no drift
```

Then open the board: `cmux sidebar open crew`, or the Dock button in cmux.
New Claude Code sessions pick up the hooks; existing ones do not.

### 4 · First plan (optional but the point)

In a Claude Code session: ask for a "deep plan" of any change. You'll get the
review surface above, the alignment check, and per-increment gating — `go`
from the board's chip or `deep-plan go <slug> next` from any terminal.

### Uninstall

```sh
./install.sh --uninstall
```

Unwires cmux (restoring the pre-crew `cmux.json`), moves the crew tree to a
timestamped backup, removes the skill and shim, and removes only the settings
entries the installer added. Deliberately left behind: `guard_bash.sh` (a
safety rail outlives its installer), your plan state and keys, `~/.claude/plans`.

## The repo is the source of truth

Edit here, then `./install.sh` to sync to the machine. If you did edit a live
file, `./install.sh --check` finds it — copy it back into the repo (for the five
`crew/bin` files that bake your main-repo path, reverse-substitute it to
`__MAIN_REPO__`), commit, reinstall. Placeholders: `__MAIN_REPO__` is baked at
install; `__HOME__` and `__INTENT_PORT__` are rendered by `crew apply`.

`crew doctor` enforces this automatically: the installer records the repo path
in `~/.config/cmux/crew/.seamux-source`, and doctor runs `install.sh --check`
against it — drift is a red check, not a discipline.

## Computer Use (optional)

cmux ships a Computer Use driver (`cmux-cua`) that lets agents drive the
browser and other apps in the background — crew works fine without it, and
`crew doctor` only notes whether it is set up. To enable it:

1. Open the cmux **desktop app** and find the Computer Use setup — an
   onboarding banner, or **Settings → Computer Use**. The wizard resumes if it
   was left partway (the symptom is agents seeing "Computer Use onboarding is
   still in progress").
2. Approve the two macOS permission dialogs it raises for the cmux helper —
   **Accessibility** and **Screen Recording** (System Settings → Privacy &
   Security if a dialog was dismissed earlier). macOS attributes grants to the
   app that asks, so approve them from cmux's own prompts. Quit and reopen
   cmux if Screen Recording doesn't register.
3. Finish the wizard's self-test. Verify from an agent with the cmux-cua
   `health_report` tool (all checks pass), or re-run `crew doctor`.

## Layout

| path | what |
|---|---|
| `crew/` | the layer installed to `~/.config/cmux/crew` (see `crew/README.md`) |
| `deep-plan/` | the skill installed to `~/.claude/skills/deep-plan` (see its `SKILL.md` / `DEVELOPING.md`) |
| `claude/` | statusline, guard hook, settings merger |
| `bin/deep-plan.shim` | installed to `~/.local/bin/deep-plan` |
| `docs/` | development history (`FINDINGS.md`), test notes (`TESTING.md`), adoption audit (`ADOPTION.md`), README images — not installed |

Never committed: rendered `~/.config/cmux/{cmux,dock}.json`, deep-plan
state/keys/annotations, the mermaid vendor blob, your `~/.claude/settings.json`.
