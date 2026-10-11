# Checks: how an increment is proven

Read this while deciding how each increment is proven (discipline step 4) and before `done` (step 10).

## Contents

- [Choosing checks](#choosing-checks)
- [What counts as a deliverable's checks](#what-counts-as-a-deliverables-checks)
- [Recipe format](#recipe-format)
- [Review checks and the delivery review](#review-checks-and-the-delivery-review)
- [Proving an increment before done](#proving-an-increment-before-done)

## Choosing checks

Run `deep-plan verify resolve <files>` on each deliverable's files: it
prints the `.seamux/verify.json` each file lands on (nearest ancestor;
the root's recipes are inherited unless redefined) and the recipes that
apply. A `default: true` recipe whose `match` covers the files becomes a
check by itself; name any other recipe in the deliverable's `checks`, and
add observability and manual checks for what no command can prove.
**No recipes in the project?** Stop and set them up with the developer
before drafting: `deep-plan verify init` (a dry run) drafts recipes from
the scripts, CI steps and configs already there, `--write` writes the
drafts, and `verify/setup-prompt.md` in the engine root walks every TODO
with them — confirm against CI, run twice, tier on the stopwatch. Remote
QA (a preview to test against) is a template (`verify init --template
vercel-preview|firebase-channel|rwx-run|github-deployment`); its
`acquire` step is the human's. Recipe files are the repo's, reviewed and
committed by the developer — never commit one yourself. A `waiver` is for
an increment nothing executable or observable can prove (docs only), and
says why.

**Then ask which increments deserve a lookout review**, and whether the
full delivery does: one `AskUserQuestion` with `multiSelect` over the
increments (each option the increment's title and what it touches), and
one with the delivery as a yes or no — a review of every increment's
work together, after the last one, that the plan cannot close without.
Recommend from the risk (auth, data, contracts, cross-system seams lean
yes; docs and scaffolding lean no); the human decides. Record the answer
as `review.increments` and `review.delivery`; render refuses a spec
without them.

## What counts as a deliverable's checks

A deliverable's checks are its declared `checks`, plus every `default: true`
recipe whose `match` covers its `files` (inferred at render), plus two legacy
fields still read: `observability.checks` (as observability checks) and
`verification` strings (as manual checks). Render refuses an increment that
ends up with none and no `waiver`; `render --force` is the logged way past.

## Recipe format

A recipe in `.seamux/verify.json` (in the project directory; `match` and
`cwd` are relative to it):

```json
{ "recipes": [
  { "id": "unit", "kind": "test", "run": "npm test", "match": ["src/**"], "default": true },
  { "id": "preview-e2e", "kind": "e2e", "tier": "expensive", "steps": [
    { "acquire": "git push -u origin HEAD", "note": "a person runs this" },
    { "wait": "scripts/preview-url.sh", "export": "BASE_URL", "timeout": 1200, "interval": 20 },
    { "run": "npx playwright test" } ] } ] }
```

Steps go acquire, then wait, then run. A wait polls until it exits 0 (and
prints a value when it exports one); an export reaches every later step. A
recipe with acquire or wait steps must be `expensive`.

## Review checks and the delivery review

A `review` check takes no recipe, run or command (`name` defaults to "code
review"; one per deliverable): deep-plan runs `lookout gate` for it.
Top-level `review.agentMayClose` (default false) is decided with the human
at interrogation time: true lets the agent resolve and dismiss findings too,
instead of only replying and marking them addressed. `review.quiz` (default
false) opens each review with lookout's ownership quiz: a question before
each high-risk group's note. It never gates.

`review.increments` and `review.delivery` are required, and are the human's
answer to a planning question (step 4): which increments get a lookout
review (a list of numbers, `"all"` or `"none"`; each listed increment
carries a review check), and whether the full delivery does (`true` puts
the plan in a `delivery` phase after its last increment, closed by
`deep-plan deliver`). Render refuses a spec that does not say.

## Proving an increment before done

`done` is refused while any check is pending, running, needs a variant,
failed, or passed against other content than the tree now (an edit after a
pass makes it stale; a commit of what passed does not). `deep-plan check list <slug> <n>` shows each
check and what it runs.
- **Recipe-backed checks run themselves:** `deep-plan check run <slug>
  <n>` runs every one not yet passed. Cheap recipes run in the foreground;
  expensive ones detach (a deploy wait plus e2e outlasts a foreground
  command) — follow them with `check status`, block on them with `check
  wait` (exits 2 if still running at its timeout; wait again). The
  verdict is the exit code, and the log is kept.
- **An acquire step is the human's.** A remote check stops at
  `needs-variant` and prints what to run (a push, a channel deploy).
  Never run it yourself, even with a `go` in hand: ask the human to, then
  `check run <slug> <n> <id> --from wait` polls for the variant and tests
  it.
- **Manual and observability checks are recorded by hand:**
  `deep-plan check pass|fail <slug> <n> <id> "<what you saw>"`. Record
  what you actually observed, not that you looked — the note is the only
  durable evidence. Passing a recipe-backed check by hand is refused
  without `--force`, which is logged; use it only when the human says to.
- **A review check is lookout's verdict.** Every increment the human
  chose in `review.increments` carries one (a deliverable may also
  declare `{ "kind": "review" }`). Its command is synthesized — `lookout
  gate --plan <slug> --inc <n>` — and it passes when no blocker or major
  finding is open on the increment's review. With no reviewer yet,
  `check run` opens the review itself (with the plan's
  `review.agentMayClose` and `review.quiz`) and ends with `review: spawn a reviewer —
  lookout prompt <slug>-inc<n>`: then spawn one fresh reviewer subagent
  whose prompt is that command's output, and run the check again
  (`deep-plan review <slug> <n>` opens it by hand). Fix what it finds and `lookout
  address` each finding; the human resolves or dismisses on the page, and
  only then does the check pass. Never pass it by hand, and never close
  findings yourself unless the plan set `review.agentMayClose`. Like any
  check it goes stale after an edit: re-run it (it reads statuses; it
  does not re-review — say when a fix deserves a second reviewer).
- **The delivery review** (`review.delivery: true`): when the last
  increment is done the plan enters a `delivery` phase instead of
  finishing. Run `deep-plan deliver <slug>`: with no reviewer yet it
  opens lookout's review of every increment's work together (since the
  first increment's start sha; its brief carries every increment's
  description) and ends with `review: spawn a reviewer — lookout prompt
  <slug>-delivery`. Spawn one fresh reviewer, fix and `lookout address`
  what it finds, and run `deliver` again; it completes the plan once the
  human has closed every blocker and major. The gate stays open in this
  phase, so fixes need no `go`.
- `done --force` overrides the whole gate and writes that to the log; use
  it only when the human says to, and say that you did. `deep-plan reset`
  on an increment returns every verdict to `pending` — a check passed
  against the previous attempt proves nothing about the new one.

`deep-plan obs check|pass|fail|reset` still works, on the observability
checks only.
