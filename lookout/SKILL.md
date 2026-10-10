---
name: lookout
description: Review a diff in a browser pane beside the terminal — a branch against its base, a commit range, the uncommitted working tree, or a patch file — with files sorted by risk or path, highlighted split or unified diffs, and findings from a reviewer subagent discussed with the human in threads on their lines. Use when the user asks to review a branch, a diff, a PR's changes or an increment, to "look at the diff", or runs /lookout.
---

# lookout

A review is a source, the diff it yields, and (later) what you and the human
say about it. `lookout` is on the Bash tool's PATH from the plugin's `bin/`
while the plugin is enabled; `lookout setup` adds a `~/.local/bin/lookout`
shim for the human's own shell and fetches the pinned highlight.js.

## Open a review

```
lookout open                      # this branch vs origin's default branch (else main/master),
                                  # uncommitted and untracked work included
lookout open --base REF           # merge-base(REF, HEAD) vs the working tree
lookout open --worktree           # uncommitted work only (HEAD vs the working tree)
lookout open --range A..B         # two commits; A...B diffs from their merge base
lookout open --patch FILE         # a patch file, no repository needed
```

It prints the review id, the page and the store, and puts the page in a
browser tab beside the terminal without taking focus (a second open of the
same review refreshes that tab instead of adding one). `--no-open` skips the
tab, `--json` prints the same as JSON, `--id` names the review yourself.

The working tree is read through a scratch git index, never the real one:
opening a review does not change what `git commit` would do.

The id is stable per source (`<repo>-<branch>`, `<repo>-<branch>-wt`, …), so
re-opening a branch after more work updates its review and keeps everything
said on it.

## Run a review

The findings come from ONE fresh subagent, not from you: reviewing your own
change in the context that wrote it reads your intent instead of the code.

1. `lookout open …` (above). Note the id it prints.
2. Spawn a subagent (the Agent tool, general-purpose) whose prompt is the
   exact output of `lookout prompt <id>`. The brief carries the patch path,
   how to read whole files, the files riskiest first, lookout's groups, the
   rubric, the severities and the JSON schema, and tells the subagent to run
   `lookout findings add <id> <file>` itself. Do not add your own opinion of
   the change to the brief.

   The reviewer writes ONE object, `{findings, edges, notes}` (a bare array
   still means findings only):
   - **notes**, one per high or medium group: why it is risky, the
     direction it moves the design, what to watch at which lines, and the
     fundamentals it touches (invariant, security-boundary, data-model,
     cross-system-assumption). A note names its files, so it lands on
     whichever group holds them, and goes stale when their hunks change.
   - **edges** `{a, b, why}`: links the grouping rules missed. They only
     join files, under the six-file cap, and their why shows on the rail.
   - **with the quiz on**, a question on each high group's note,
     multiple choice and linted so it cannot give its answer away.
   - **in a plan review**, a group heading somewhere the increment does not
     say is a `plan-drift` finding, raised to major; a standalone review
     refuses one.

   `findings add` prints what it rejected and any group still owed a note
   or a question; the subagent fixes those and runs it again.
3. When it returns, `lookout findings list <id>` and tell the human what was
   found (counts by severity, the blockers and majors in a line each). The
   page beside the terminal already shows every finding under its line,
   and opens on the Overview of the notes.
4. Discuss. Fix what is real, then `lookout address <id> <f#> "<what changed>"`;
   answer anything with `lookout reply <id> <f#|t#> "<text>"`.
5. **Only the human closes a finding** — resolve or dismiss, on the page.
   `lookout resolve` and `lookout dismiss` are refused for you unless the
   review was opened with `--agent-may-close` (a plan opts in with
   `review.agentMayClose`). Never work around that refusal, and never ask
   for the flag yourself; it is the human's call at planning time.

`lookout gate <id>` is the verdict: exit 0 when no blocker or major finding
is open (minor and nit never hold it), 1 when one is open or only addressed,
3 when there is no review or no reviewer has reported. A finding the agent
marked addressed still holds the gate until the human closes it.

**The quiz** (`lookout open --quiz`, a repo's `.seamux/lookout.json`
`{"quiz": true}`, or a plan's `review.quiz`) is fixed when the review is
created; a re-open neither adds nor removes it. On the served page each
high group's question hides its note until the human answers, and crew's
intent server records the answer once. It never gates. A wrong answer
reaches you at the human's next prompt, beside their comments: if they
ask, explain the gap from the code, not from the note. Never answer a
question for them, and never quote a note's answer before they have
answered.

**Standalone** (`/lookout`, any branch, no plan): open with `--base`,
`--range`, `--worktree` or `--patch`; the brief carries the patch and the
rubric only, and the page header names the branch and base. `lookout gate`
still answers, but nothing gates on it: a standalone review is a
conversation, not a gate.

**Inside a deep-plan increment**: the plan's `review` check runs
`lookout gate --plan <slug> --inc <n>`, so open the review as
`lookout open --plan <slug> --inc <n> --base <the increment's start sha>`
(its id is `<slug>-inc<n>`). The brief then also carries the increment's
own description from the plan's cutover. `deep-plan check run` re-runs the
gate; it passes once the human has closed every blocker and major.

## The page

VS Code's Source Control layout: changed files on the left as a directory
tree (single-child folders folded together), one file's diff on the right.

- **Overview** (`o`, or the header button): a review with notes opens on
  it. Every group riskiest first, each note in full: watch items link to
  their lines, touches show as chips, drift findings are listed, and stale
  or partial notes are marked. Each file shows its group's note as a strip
  above the diff that expands.

- **Split or Unified** (header toggle, or `v`). Narrow panes and one-sided
  files (added, deleted) draw unified.
- **`j` / `k`** step through files in the side list's order; **`n` / `p`**
  through open findings.
- **Risk / Path** (side toggle). Risk puts files in high, medium and low
  bands, riskiest first, with related files grouped on a rail that says why
  they belong together (one imports the other, a test and its source, a
  finding naming both, a small shared folder). Risk blends deterministic
  signals with one Jev score per file; by default only paths and line counts
  leave the machine, and `.seamux/lookout.json` `{"sendContent": true}`
  lets hunk text go too. Without TypeSafe the page says it is ranking on
  signals alone.
- **Findings** sit under the line they name, with severity, category,
  verdict, status and their thread; the header shows the gate. Findings on
  lines the diff does not show are listed at the top of the file. Closed
  ones fold to one line.
- **Highlighting** is highlight.js over each side's whole file, so a change
  inside a block comment or a template string reads right. Changed words in
  a paired removed/added line are marked.
- **Collapsed files**: lockfiles, minified bundles, `linguist-generated`
  paths, binaries and changes over 1500 lines start collapsed behind a
  "Show diff" button (binaries and very large files cannot be drawn).

If highlight.js is missing the page is drawn plain with a banner naming why;
`lookout setup` fixes it.

## Other verbs

```
lookout prompt <id>          the reviewer brief
lookout findings add <id> <file|->   validate and ingest a reviewer's JSON
lookout findings list <id> [--open] [--json]
lookout reply <id> <f#|t#> <text>    lookout address <id> <f#> [note]
lookout resolve|dismiss|reopen <id> <f#|t#> [note]
lookout gate <id> | --plan SLUG --inc N
lookout show <id> [--json]   files of a review (or the whole store as JSON)
lookout list [--json]        every review, newest first
lookout render <id>          redraw the page from the store
lookout setup                engine pointer, ~/.local/bin shim, pinned highlight.js
lookout engine               which copy of the engine runs
```

The store is `~/.claude/plans/reviews/<id>.json`, beside the patch, the drawn
rows and the page.
