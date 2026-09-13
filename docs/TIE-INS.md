# deep-plan ↔ cmux: the tie-ins

`deep-plan` is a Claude Code skill that plans a change as a reviewable artifact and
refuses edits until you authorize the next increment. It works entirely on its own.
This bundle carries the **integration** between it and the cmux Dock, plus
[ADAPTING.md](ADAPTING.md) — the recipe for building an equivalent skill if you do
not have one.

**The short version.** If this machine already has `~/.claude/skills/deep-plan`,
running `install.sh` satisfied every tie-in below except the gate hook, which
`claude/merge_settings.py` wires. If it does not have the skill, everything below is
inert: the board has no plan rows and the plan chips are never rendered, and nothing
errors. Neither state needs any code change.

## The six integration points

Each one lives in the crew tree in this bundle, not in the skill, so they arrive
with the install.

**1 · Plan rows on the board.** `board/crew-board` reads `~/.claude/deep-plan/state/*.json`
and renders one row per tracked plan, carrying its gate state — so a shut gate is
visible without opening anything. No state directory means no rows.

**2 · `plan →` serves the working surface.** `board/crew-board-intent` has a `/plan/<slug>`
route that serves the plan's live HTML into a Dock tab from `http://127.0.0.1:<port>`.
Serving rather than opening the file buys three things: the page can reference one
cached copy of mermaid instead of embedding 3.4MB (4.86MB → ~100KB), its controls become
same-origin with the endpoint that runs them, and the tab gets a URL the Dock restores
across launches. `/plan-stamp` is the change probe the page polls; `/mermaid.min.js` is
the shared library.

**3 · Increment controls.** The `/inc` route runs `node ~/.claude/skills/deep-plan/deep_plan.mjs
<action> <slug> <n>`. The page renders `go` / `start` / `done` / `block` disabled on disk
and enabled when served, because the transport is injected at serve time — the generator
emits meaning, the server supplies the ability. `go` posts the same notification RPC the
Swift sidebar used, so `hooks/triage.py` stays the single place that decides what those
verbs do, including its confirm-before-delete on reclaim.

**4 · File paths open in VS Code.** The `/open` route opens a path from a plan in the
window that owns that plan's worktree, handing off to the same binary cmux uses for
Cmd-click in a terminal. Which paths are click targets is the actual design work, and it
lives in the skill: declared files are targets even before they exist, prose mentions only
if they resolve to a real file, anything naming another repo stays plain text.

**5 · The gate.** A `PreToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit|Bash` pointing
at `~/.claude/skills/deep-plan/hooks/gate.sh`. `crew apply` does **not** wire this —
`claude/merge_settings.py` does, and only if the skill is present. A PreToolUse hook
pointing at a missing script fails on every edit, which is far worse than no gate.

**6 · One identity colour.** cmux's per-workspace colour reaches the VS Code title bar
through Peacock (`bin/crew-code-open`), rings the current card on the board, paints the
focused pane's frame (`bin/crew-frame`), and tints the Claude Code status line
(`claude/statusline.py`). Following the selection needs the workspace id out of the event
payload rather than a lookup: `workspace.selected` fires about 151ms before the selection
is queryable, so asking lands everything one switch behind.

## Two tie-ins that live in the skill, not here

These are in `deep_plan.mjs`, which this bundle does not ship. If the machine's
deep-plan predates them, they are simply absent — nothing here depends on them.

- **The increment diff.** `deep-plan done` writes a patch of everything that happened
  since the increment started — committed, uncommitted and untracked — and opens it with
  `cmux diff`, titled with the increment and the sha it starts from. Degrades to printing
  the patch path and a `git diff` command when cmux is not installed.
- **`deep-plan diff [slug] [n]`** reopens that view.

## Checking the tie-ins

```bash
crew doctor                              # includes "intent server routes + mermaid swap"
curl -s "http://127.0.0.1:$(cat ~/.cache/cmux-crew/board-intent.port)/health"
deep-plan status                         # the skill's own view; must agree with the board
```

A plan row on the board and no `plan →` chip means the intent server is not running
(`crew listen on`, or open the board once). A chip that does nothing means the port moved:
the page holds whatever port it was pushed with, so a restarted server needs the next push
to re-inject it.

## If this machine has no deep-plan skill

Two honest options.

**Run without it.** Everything else in the bundle works. You lose plan rows, the gate, and
the plan surface. Nothing to configure — the absence is the no-op.

**Build one from [ADAPTING.md](ADAPTING.md).** That document is the recipe, not the skill:
it walks the design decisions and the traps, and expects the agent following it to write
the code. Budget hours, not minutes, and read its "Repo conventions this bakes in" section
first — a few choices (branch naming, the ticket-key shape, where plans live) are baked in
and worth changing deliberately rather than inheriting.

The skill itself is not in this bundle. If you would rather copy the real thing than
rebuild it, ask the author for `~/.claude/skills/deep-plan` directly — but note that its
`SKILL.md` and `DEVELOPING.md` carry real ticket keys and service names in their examples,
so they need the same scrub this bundle got before they travel.
