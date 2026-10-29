# Adopting seamux

How to roll seamux out, one step at a time: one person on one machine, then
a team, then cloud sessions, then families of plans and plans shared across
machines. Each step builds on the one before and is useful on its own. For
what each plugin does, start with the [README](../README.md).

## Contents

- [1. One person, one machine](#1-one-person-one-machine)
- [2. A team](#2-a-team)
- [3. Cloud sessions](#3-cloud-sessions)
- [4. Families: parallel workstreams](#4-families-parallel-workstreams)
- [5. Shared plan state](#5-shared-plan-state)
- [Hosts in detail](#hosts-in-detail)
- [Machine-local overlay (crew)](#machine-local-overlay-crew)

## 1. One person, one machine

Install from the checkout you will keep, never a git worktree:

```sh
git clone https://github.com/rickykoter/seamux ~/code/seamux
cd ~/code/seamux && ./install.sh
```

deep-plan, lookout, restack and humanize need only Claude Code and `node`,
and run in Claude desktop, a terminal or cmux. crew and the seamux app need
macOS and cmux. `./install.sh --check` and `deep-plan doctor` confirm the
install and say which host the session is on.

Then ask Claude for a "deep plan" of a real change, and let it run every
station once: plan, quiz, go, build, checks, review, deliver. The first plan
in a repo also asks to set up its check recipes in `.seamux/verify.json`.
Those recipes are yours to review and commit.

## 2. A team

Each developer installs the plugins the same way. What a team adds lives in
the repo, so everyone gets it from git:

- `.seamux/verify.json`: the check recipes. Commit them; a plan's checks run
  the reviewed recipe, not one an agent wrote on the spot.
- `.seamux/adr.json`, if your ADRs live somewhere other than the default.
- `playwright` in the repo's dev dependencies, wherever cmux is not the
  host, for browser checks (`npm i -D playwright && npx playwright install
  chromium`). Without it they stop at needs-variant rather than failing.
- CI can run the same recipes headless with `deep-plan check run`, and
  `deep-plan proof --attach` puts a browser run's frames on the PR when a
  person says yes.

A plan, its pages and its reviews stay on the machine that made them until
you choose to share them (steps 3 and 5).

## 3. Cloud sessions

A claude.ai/code cloud session does not install the plugins a repo enables,
so the repo carries them. Once per repo:

```bash
deep-plan install-repo
```

```bash
lookout install-repo
```

Then commit `.claude/`. Each command copies its plugin into
`.claude/skills/<plugin>/` (the skill and its references where skills load
from, the engine, hooks and `bin/` beside them) and merges its hooks into
`.claude/settings.json`, with a SessionStart hook that puts `bin/` on the
Bash tool's PATH. deep-plan's copy carries the pinned mermaid, since a cloud
sandbox may not reach the CDN.

Every hook starts with a guard, so it runs only when `CLAUDE_CODE_REMOTE=true`
or `SEAMUX_REPO_HOOKS=1`. A local session keeps running the installed
plugins' own hooks. A multi-repo cloud session loads no repo hooks, so it
gets no gate. `install-repo --check` reports when the repo's copy is behind
the plugin; a CI job can run it after the plugins update.

In a sandbox, plan state and reviews live in the repo under
`.seamux/state/`, kept out of git through `.git/info/exclude`. A review has
no live page there: `lookout export-artifact` publishes it as an Artifact on
a person's yes, and `lookout pull` brings the comments and closes back as
data, marked unverified. A plan leaves the sandbox through its state branch
(step 5) or, for a plan that does not share, `deep-plan export-state <slug>`
and `import-state <file>` in the next one.

What a sandbox needs to push its state: the Claude GitHub App installed on
the repo, or GitHub reconnected in claude.ai settings. Without it the
sandbox's git proxy answers a push with a 403, while fetching still works.

## 4. Families: parallel workstreams

When one goal splits into parts that can run side by side, plan it as a
family. Each part is a child plan with its own worktree, agent and gate. The
parent plan names them in a `workstreams` block: the files each one owns,
the contracts it owns or consumes, the parent increments it waits on, and
whether its go is the parent's (`go: "parent"`).

- A child's go waits on the parent increments it names in `after`.
- With `go: "parent"`, the parent agent gives each child its go once the
  child's last increment is done, checks and review included. A person can
  still give a go, hold a child, or take its go back.
- Each member hears what its siblings finished at its next prompt, and an
  edit into a sibling's files is flagged and recorded.
- The parent checks the whole once every child is in, and a family review
  reads each member's delivery.

The skill's [families reference](../deep-plan/references/families.md) has
the details.

## 5. Shared plan state

When a plan is worked from more than one place (a laptop and a cloud
sandbox, two people, a family's children on different machines), set
`share` in its spec. The planner asks about it while planning.

```json
"share": true
```

The plan then keeps its state on a git branch of its own,
`seamux-state/<slug>`, on the repo's own remote, or on another remote that
`share.remote` names. Every transition pushes it, and a session pulls it at
start. A child waiting for its parent's go pulls while it waits. When two
writers race, the later one merges by rule and pushes again. `deliver` and
`close` archive the branch as `seamux-state-archive/<slug>`.

Before you turn it on:

- The branch carries the plan's quiz answers. Anyone who can read the
  remote can read them.
- Exempt `seamux-state/*` from branch protection, or set a prefix that is
  not protected (`share.prefix`).
- Cloud sandboxes need the Claude GitHub App on the repo to push (step 3).
- A push that fails never fails the transition. It is said once, and
  `deep-plan status` shows the plan as unsynced until a push lands.
  `deep-plan state status` compares every plan with its branch.
- On one machine, `SEAMUX_STATE_REMOTE`, `SEAMUX_STATE_PREFIX` and
  `SEAMUX_STATE_SYNC` (`transitions`, `manual` or `off`) override a plan's
  setting.

More in [deep-plan's README](../deep-plan/README.md#sharing-a-plans-state)
and the skill's [sharing reference](../deep-plan/references/sharing.md#state-branches).

## Hosts in detail

| host | detected by | pages | who answers an ask | plan state |
|---|---|---|---|---|
| cmux | `CMUX_WORKSPACE_ID` | a pane beside the terminal, through crew's server | the page types the answer into the terminal | `~/.claude` |
| Claude desktop | `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop`, `claude-desktop-3p` or `local-agent` | the plugin's own server; Claude opens the URL in the browser pane | the chat prompt | `~/.claude` |
| a terminal | none of the others | the plugin's own server; a printed `served at` link | the terminal prompt | `~/.claude` |
| cloud | `CLAUDE_CODE_REMOTE=true` | none live; a review goes out as an Artifact | the chat prompt | the repo, under `.seamux/state/` |

`SEAMUX_HOST=cmux|desktop|terminal|remote` overrides detection, cmux
included. The plugin servers bind 127.0.0.1 and keep crew's guards: the Host
header must name the server, a POST needs the server's own Origin and a
token compared in constant time.

What has been checked in a real cloud session (2026-10-28 and 2026-10-29):
hooks in a repo's committed `.claude/settings.json` run in a single-repo
session, with `CLAUDE_CODE_REMOTE=true`; `CLAUDE_PROJECT_DIR` is set for
hooks but empty in the Bash tool's shell, so the engine falls back to the
current directory's repo; skills in `.claude/skills/` load, and plugins named
in the repo's settings do not install. A sandbox's clone is partial, so
deep-plan reads state branches through a full cache of its own. Two
sandboxes shared a plan: one gave a go, the other saw it at start.

## Machine-local overlay (crew)

The package genericizes everything company-shaped: `crew-spec` is a stack
detector rather than one repo's test harness, `cmux.jsonc` names
`~/code/main-repo` rather than your monorepo, and there is no database control in
the Dock. That is correct for a public package and wrong for the machine it came
off. The overlay is how a real install keeps its own answers without either
carrying them in the repo or losing them on the next `crew apply`.

It lives at `~/.config/cmux/crew-local/` — overridable with `$CREW_LOCAL`, and
deliberately a **sibling** of `~/.config/cmux/crew/`, not a child. `crew apply`
moves the whole crew tree aside when it installs a new copy from the plugin, and
the drift check (`crew drift`) only compares the plugin root with that tree. A
sibling therefore survives the move *and* stays silent in the check — no entry
to whitelist, no `live-only` line to learn to ignore. Nothing in it is ever in
the repo.

Three hook shapes, one per kind of thing you need to override:

| File | Shape | What it does |
|---|---|---|
| `crew-spec` | executable | `crew/bin/crew-spec` `exec`s it and never runs its own detection |
| `config.json` | JSON | crew's own machine-local settings (`billing`, `monthBudget`) read by the status line and the intent server |
| `cmux.json` | JSON(C) | deep-merged over the rendered `config/cmux.jsonc` |
| `dock.json`, `dock.global.json` | JSON(C) | same, over their templates |

Merge rules (`crew/bin/crew-overlay`): dicts recurse, scalars and lists replace
wholesale, and **`controls` lists merge by `id`** — so an overlay can add one
Dock control, or amend one field of an existing control, without restating the
other eight. Both sides go through `render` first, so overlay content may use
`__HOME__` and `__INTENT_PORT__` exactly like a template.

Two properties worth relying on:

- **A machine with no overlay is byte-identical to before.** `render_local`
  falls straight through to `render`, comments and all — the merge path only
  runs when a file is actually there. Verified against all three configs.
- **A broken overlay fails loudly.** Invalid JSON exits non-zero with the
  overlay's real path and writes nothing to stdout, rather than quietly shipping
  an unmerged config. "My overlay is being ignored" is the bug class this whole
  mechanism exists to remove, so it is never the failure mode.

`crew doctor` reports the overlay and its file count, `note`s its absence (a
machine without one is the normal case, not a symptom), and hard-fails on two
things that would otherwise be silent: a `crew-spec` that is present but not
executable — `[ -x ]` makes that a no-op, the same shape as the go chip that
sent `workspace_id` to a reader expecting `workspaceId` — and an overlay JSON
file that will not parse.

**The trap:** `chmod +x` your `crew-spec`. A copy made with `cp` from a
non-executable source is silently skipped, which is why doctor checks for it.

For a second machine, make the directory a symlink into a private repo:

```sh
ln -s ~/code/dotfiles-private/cmux/crew-local ~/.config/cmux/crew-local
```

No extra code — crew resolves the path through `${CREW_LOCAL:-...}`, so a
symlink is indistinguishable from a directory. There are deliberately no example
overlay files in this repo: anything tracked under `crew/` gets copied into
`$DEST` and compared by `drift_check`, which is noise for nothing.
