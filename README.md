# seamux

An agent cockpit for [cmux](https://cmux.io): the **crew** Dock board (who needs
you, right now), its cmux tie-ins (web-Dock browser surfaces, a loopback intent
server, Claude Code hooks, a SwiftUI sidebar fallback), and **deep-plan** — a
Claude Code skill that turns plans into gated, reviewable artifacts.

Built for a personal laptop with many hobby repos: no issue trackers, no
observability stack — git/GitHub only. Sessions launch with Claude Code
Remote Control so the fleet is also visible from the Claude phone app.

## What you get

- **crew** (`~/.config/cmux/crew`) — worktree-per-agent workflow (`crew-worktree`),
  a Dock board ranked by "who is waiting on a human", a `/usage` dashboard showing
  tokens against your 5h-window and weekly budgets (not dollars), hooks that
  publish each agent's phase, and `crew doctor`.
- **deep-plan** (`~/.claude/skills/deep-plan`) — spec → rendered plan + review
  surface + graded alignment quiz; a PreToolUse gate that hard-denies edits until
  each increment gets an explicit `go`; optional publish-for-annotation via
  Claude artifacts.
- **Claude side** — status line (usage window), `guard_bash.sh` (blocks force
  pushes / recursive deletes), settings merged additively by
  `claude/merge_settings.py`.

## Install

Requirements: macOS, cmux (nightly with the web Dock beta for the browser
board), `python3`, `node`; optional `gh`, `ccusage`.

```sh
./install.sh                     # picks/asks for your main repo, installs all
./install.sh --main-repo ~/code/my-repo
./install.sh --check             # drift report, changes nothing
```

Flags: `--dry-run`, `--no-apply`, `--no-claude-settings`, `--no-crew`,
`--no-deep-plan`, `--no-mermaid`, `--force-mermaid`, `--force`.

`mermaid.min.js` (3.4MB) is not in the repo; the installer fetches a pinned
version from jsdelivr and verifies its sha256.

Verify: `crew doctor`, `node ~/.config/cmux/crew/board/board_probe.mjs`,
`node ~/.claude/skills/deep-plan/probe.mjs`.

## The repo is the source of truth

Edit here, then `./install.sh` to sync to the machine. If you did edit a live
file, `./install.sh --check` finds it — copy it back into the repo (for the five
`crew/bin` files that bake your main-repo path, reverse-substitute it to
`__MAIN_REPO__`), commit, reinstall. Placeholders: `__MAIN_REPO__` is baked at
install; `__HOME__` and `__INTENT_PORT__` are rendered by `crew apply`.

## Layout

| path | what |
|---|---|
| `crew/` | the layer installed to `~/.config/cmux/crew` (see `crew/README.md`) |
| `deep-plan/` | the skill installed to `~/.claude/skills/deep-plan` (see its `SKILL.md` / `DEVELOPING.md`) |
| `claude/` | statusline, guard hook, settings merger |
| `bin/deep-plan.shim` | installed to `~/.local/bin/deep-plan` |
| `docs/` | development history (`FINDINGS.md`) and manual test notes (`TESTING.md`) — not installed |

Never committed: rendered `~/.config/cmux/{cmux,dock}.json`, deep-plan
state/keys/annotations, the mermaid vendor blob, your `~/.claude/settings.json`.
