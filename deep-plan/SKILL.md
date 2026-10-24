---
name: deep-plan
description: Plans a change as a reviewable artifact — spec → markdown plan + review surface + graded alignment check — then gates edits so each increment needs an explicit go-ahead. Use when the user asks to "deep plan", plan a feature carefully, or wants a plan with increments they authorize one at a time.
---

# deep-plan

Plan as artifact, gate per increment. Every increment is gated on its checks
(tests, e2e runs, observability signals, manual steps), run by the engine
from per-project recipes where it can and recorded by hand where it cannot.
The crew Dock reads `deep-plan status --json` and serves the plan surfaces at
`/plan/<slug>`; the cutover bundle is how a plan reaches a ticket system.

## Must hold

These survive a compaction; everything below them is how.

- **Challenge the goal before anything else**, unless the human says "skip
  the challenge".
- **Every hard-to-reverse fork goes to the human before the spec exists**, as
  a concrete `AskUserQuestion` choice. One question per call while an ask
  page is open.
- **Evidence or it is a risk.** A verifiedFact cites `path:line` you read this
  session; every existing file a deliverable names must be cited by one.
- **No edit inside a plan root without `deep-plan go`.** The gate hook refuses
  it; do not route around a refusal.
- **Never hand-edit a generated surface.** A plan change is a spec edit and a
  re-render.
- **`done` only on proven checks.** Never hand-pass a recipe-backed or review
  check, never `--force` anything unless the human says to, and say when you
  did.
- **A delegated child's go is its parent's.** When a family's workstream sets
  `go: "parent"`, the parent agent gives that child's go from its own
  worktree, after reading the child's verdicts. The child never runs `go`
  itself, and no agent passes `--by human` except on a person's word.
- **An acquire step is the human's.** Never run one, even with a `go` in hand.
- **Recipe files are the developer's** to review and commit.
- **Publishing a plan sends it off the machine:** confirm with the human every
  time, even after an earlier "share".
- **Only the human closes lookout findings**, unless the plan set
  `review.agentMayClose`.

## The discipline, in order

0. **Challenge the goal.** The stated goal is a claim too. Restate it in your
   own words, list the assumptions in it, and put the strongest
   counter-position to the human as an `AskUserQuestion` ("the simpler fix is
   X", "this symptom usually means Y", "is this worth doing at all?"). A
   confirmed goal plans faster and better than an assumed one.
1. **Interrogate before drafting.** A plan that silently resolved a fork is a
   plan the human never agreed to. When a fork is *architectural* (it will
   outlive this plan and constrain later ones), say so in the question and
   carry the answer into the spec as a decision flagged `adr`: the answer's
   why becomes the context, the rejected options the alternatives, the
   human's words the consequences. Contract forks are always asked
   ([adrs-contracts-risks.md](references/adrs-contracts-risks.md)). When a
   fork is about shape, placement, flow or a payload, show it on an ask page
   ([asks.md](references/asks.md)).
2. **Survey the terrain before drafting.** The interrogation covers the
   human's unknowns; this covers the code's. Grep the codebase for the
   feature's own vocabulary and read every file a deliverable will touch —
   the renderer refuses a spec naming an existing file no verifiedFact
   cites. "Nothing like this exists yet" is itself a claim: cite the search
   that came up empty. (Retro origin: a plan to "deepen the Jira badges" was
   drafted without opening crew-sync, which already had the polling, parsing
   and cache.)
3. **Scout the uncertainty.** Fan out cheap sub-agents (Explore, or
   haiku-tier via the Agent tool): one per low-confidence claim and one per
   contract surface, to map callers, consumers and schema reach. Cap it
   there: one scout per question, results read as conclusions. What a
   scout confirms lands in `verifiedFacts` with its evidence; what stays
   unconfirmed stays in `risks` — uncertainty is never silently promoted to
   fact. A contract's `reach` is written from scouting, not memory.
4. **Decide how each increment is proven.** Every increment needs checks;
   render refuses one with none unless it carries a written `waiver` (for
   work nothing executable or observable can prove, such as docs). Run
   `deep-plan verify resolve <files>` on each deliverable's files. No recipes
   in the project? Set them up with the developer before drafting. Then ask
   the human which increments deserve a lookout review and whether the full
   delivery does, and record it as `review.increments` and
   `review.delivery`. All of it: [checks.md](references/checks.md).
5. **Write the spec**, a single JSON file in the scratchpad
   ([spec.md](references/spec.md); `examples/example.spec.json` is a worked
   one). `render` archives it. The prose in it (context, deliverable bodies,
   risks, decision text) is read by people, so run the `humanize` skill over
   those strings before rendering, editing them in place with Edit rather
   than rewriting the file. Leave ids, `path:line` citations, check
   commands and quiz options alone: the renderer and the quiz linter measure
   those.
6. **`deep-plan render <spec.json> --root <worktree>`**, the refuse-first
   renderer. Always pass `--root` when working outside the target worktree:
   an inferred root outside it does not gate the wrong thing, it *disarms
   the gate*. Render resolves each deliverable's checks against the recipe
   files and stores them, so what `check run` executes is what was reviewed.
7. **The alignment check.** The review surface shows 3+ consequence
   questions with per-slug shuffled options. Open it in the cmux workspace —
   `cmux open "http://127.0.0.1:$(cat ~/.cache/cmux-crew/board-intent.port)/plan/<slug>.review.html" --workspace <ref>`
   (ref from `~/.cache/cmux-crew/board-targets.json`, matched by cwd) — never
   `open` on the file:// copy; fall back to the file only when the intent
   server is down, and say so. For a terminal or an inline widget, and for
   parking work in a tracker, see
   [review-surfaces.md](references/review-surfaces.md). The human answers;
   you run `deep-plan grade <slug> q1=a q2=c q3=b`. A non-zero exit names the
   decision to reopen: the plan and their model disagree, and **either may be
   the broken one** — fix whichever is wrong, re-render, re-check. Once the
   grade passes, open only the suffix-less `/plan/<slug>` (the working
   tracker); re-opening `.review.html` pins the quiz over increment progress.
   A pass also cuts `~/.claude/plans/<slug>.approved.md`, the plan as agreed
   and immutable, to paste into tickets and PRs; amends change only the live
   surfaces, and the working page notes when the plan has drifted from it.
8. **Suggest a compact before the first `go`.** Once the spec is rendered and
   graded the planning conversation is mostly scaffolding. Offer the human a
   `/compact` prompt tailored to this plan, naming the slug and the durable
   state, e.g.:

   > /compact Keep only what implementation of plan `<slug>` needs: the spec
   > at `~/.claude/plans/<slug>.spec.json` is the plan of record (re-read it,
   > don't trust summarized prose); increment status comes from
   > `deep-plan status <slug> --json`; the gate requires `deep-plan go <slug>
   > next` before each increment. Preserve: open questions the human raised,
   > decisions made mid-session that amended the spec, and any verifiedFact
   > evidence paths still unread. Drop the planning back-and-forth.

   Adapt "Preserve" to what happened this session. It is a suggestion, not
   something you run: wait for them to compact (or decline) before the first
   `go`.
9. **Implement increment by increment.** `deep-plan go <slug> next` is the
   human's go-ahead (also the board's `go` chip, and the plan pane's `go
   next`, which then tells you which increment is authorized), or the parent
   agent's for a delegated family child ([families.md](references/families.md)).
   When the human
   says "go" and an increment is already authorized, start that one. `go
   next` refuses while one is open; `--force` past it only on the human's
   word. Each `go` opens or refocuses the working surface in the Dock,
   best-effort. `go` records HEAD as the increment's start sha, the base of
   its patch and its review; the first edit inside the root marks it
   `working`. `deep-plan done <slug> <n>` closes it and writes its patch to
   `~/.claude/plans/<slug>.inc<n>.patch`. `deep-plan diff <slug> [n]` opens
   it in lookout (or `cmux diff`) when someone wants to look.
10. **Prove the increment before `done`.** `done` is refused while any check
    is pending, running, needs a variant, failed, or passed against other
    content than the tree now. `deep-plan check list <slug> <n>` shows each
    check; `deep-plan check run <slug> <n>` runs the recipe-backed ones;
    `deep-plan check pass|fail <slug> <n> <id> "<what you saw>"` records a
    manual or observability check — what you observed, not that you looked.
    Review checks, acquire steps, detached runs and the delivery review:
    [checks.md](references/checks.md).

Also read, when they apply: [observability.md](references/observability.md)
on a project with `.seamux/observability.json`;
[families.md](references/families.md) when one goal splits into parallel
plans; [sharing.md](references/sharing.md) before publishing a plan or at
the start of a session on a shared one; and
[troubleshooting.md](references/troubleshooting.md) for any refusal or error
string from the engine.

## House rules (the renderer enforces them)

- **≤120 words per paragraph** (context and deliverable bodies). The fix for
  a wall is to draw it, not to trim it to just under the limit.
- **ceil(prose words / 900) diagrams, minimum 1.** Derived from this house's
  own plans: 4 of 7 had zero diagrams; the worst walls ran 178/140/130 words.
  Give each a `simple` overview too: the same idea in plain words, which
  the page opens on ([spec.md](references/spec.md)).
- **Evidence or it is a risk.** Render checks citations back, warn-only; a
  missing path or a line past the end of its file always warns (how the
  judged half works: [spec.md](references/spec.md)).
- **Read before you plan.** Every existing file a deliverable names must be
  cited by a verifiedFact; the renderer refuses otherwise. Files the plan
  will create are exempt — they are output, not input.
- **Discovery amends the spec, not just the code.** When implementation finds
  the terrain differs from the plan, edit the spec and re-render
  mid-increment — phase and increment statuses survive, and quiz letters are
  stable while option text is unchanged. The plan of record must be the plan
  that was built.
- **Quiz is non-leading by construction** — the linter rejects leading
  words, all/none-of-the-above, the longest-option tell, >2.2× length spread,
  and prompt-echo. Draw distractors from real vocabulary in the codebase.
- **Never hand-edit a generated surface.** Progress is a command; a plan
  change is a spec edit plus re-render. `rehydrate <slug>` must report
  byte-identical.

## The gate

`hooks/gate.sh` is a PreToolUse hook on `Edit|Write|MultiEdit|NotebookEdit|Bash`
(shipped in the plugin's `hooks/hooks.json`). Hard deny: exit 2 with the
reason; one `go` authorizes a whole increment.

- Only paths **inside a tracked plan's root** are ever gated.
- Reads, greps, status commands and test runs always pass. Bash mutation is a
  heuristic — false negatives acceptable, false positives not.
- `deep-plan open-gate <slug>` is the human's lever, logged. `shut-gate`
  restores.
- **Fails open on a bad root** (nothing to gate). `deep-plan status` prints
  the root so a wrong one is visible.

Verify any change with `node deep-plan/probe.mjs` from the checkout — throwaway
state, both directions, no arguments.
