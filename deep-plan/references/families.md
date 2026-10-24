# Families: parallel workstreams under one parent

The `workstreams` block's format sits with the rest of the spec shape; this file is how a family behaves.

When one goal splits into workstreams that run in parallel (each its own
plan, worktree and session) and ship separately, a **parent plan** coordinates
them. The parent is an ordinary spec with a `workstreams` block. It is
reviewed, quizzed and gated like any plan, and it may do work of its own (land
the shared contract first, check the whole once everything is in).

- **Membership lives in the parent only.** Rendering the parent writes the
  family index (`state/families/<parent>/index.json`). A child plan is never
  edited or re-rendered to join, so a plan already mid-increment can be
  adopted. Render refuses a missing child, a child already in another family,
  and roots that coincide or nest: each member needs its own worktree.
- **Adopting existing plans:** `deep-plan family init <parent> <child>...`
  drafts the parent spec with each child's directories as suggested `owns`
  globs and its contracts, and reports where the plans already overlap. Cut the
  globs down, fill the TODOs, then interrogate and render it like any plan.
- **Claims** are (repo, glob) pairs. They come from `owns`, plus every
  child's own deliverable files, minus `shared`. Equal paths in different
  repos never collide.
- **The guard never refuses.** An edit into a sibling's claim, or straight into
  a sibling's worktree, goes through. The agent gets a factual note through
  `additionalContext`, once per session and path, and the overlap is
  recorded. Do not route around a note: tell the human, or move the work to
  the owning workstream. Bash writes are not seen at edit time, so `deep-plan
  family check <parent>` (a git diff of each worktree against its siblings'
  claims) is the backstop.
- **Sequencing:** a workstream's `after` lists parent increments it waits on.
  `go` on that child is refused until they are done (`go --force` is the
  logged override), and the shut gate's reason says what it waits on.
- **Delegated go:** a workstream with `go: "parent"` lets the parent agent give
  that child's go. Every go records who gave it (`by`, in the log and on
  status rows): `human` with `--by human` or from a shell outside Claude Code,
  `parent` from a Claude Code session inside the parent's root, and `self`
  otherwise. A
  delegated child's own `go` is refused, and `--force` does not get past
  that. The parent's duty before each child go: the child's last increment is
  done (checks and review), its waits are clear, and its patch and verdicts
  read sensibly. If they do not, `deep-plan family hold <child> "<reason>"`
  says why, and `unhold` lifts it; the parent's go is refused while it holds.
- **A person can always step in.** A person's go on a delegated child is
  allowed (`--by human`). `deep-plan family take-back <child>` makes the
  child's go a person's again, and only `family give-back` returns it, so a
  re-render never hands it back quietly. Both are a person's: from a Claude
  Code session they need `--by human` on the person's word. Take-backs and
  holds live in `state/families/<parent>/control.json`.
- **A delegated child waits with `await-go`.** After each `done`, run
  `deep-plan await-go <slug>` in the background (a background Bash command)
  and end the turn; nothing is typed into the session. Exit 0 prints the
  authorized increment: start it. Exit 2 is its timeout (30 minutes by
  default, wall-clock, so it may fire right after the machine wakes): run it
  again. Exit 3 means there is nothing to wait for: the plan is done, or a
  person took the go back, so ask them. If the wait died (a crash, a
  restart), the news at the next prompt says an increment is authorized and
  not started, until its first edit.
- **News is pulled, not pushed.** At each prompt and session start, a member's
  session gets what changed since it last looked: sibling and parent
  increments done, a cleared wait, base-ref commits touching its claims, a
  contract it owns or consumes that changed, and edits into its claims. Nothing
  is ever typed into a session. News is as fresh as the last local fetch, so
  restack is how a child actually catches up. `deep-plan family news [slug]`
  shows the same without moving the cursor.
- **Seeing the family:** `deep-plan family status [slug]`; the `family` field
  on `status --json` rows; a family section in `/plan-pane`; and on the crew
  board and sidebar, the family grouped under its parent in shades of one hue,
  placed at its most urgent member's tier.
