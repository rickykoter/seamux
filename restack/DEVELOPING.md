# restack — developing

For whoever changes this next. Built 2026-09-22 alongside `deep-plan`, same
house rules: refuse first, state on disk, one probe that throws everything
away and prints its own count.

## Inventory

| file | what |
|---|---|
| `restack.mjs` | the CLI: status/plan/run/continue/abort/regen/check/clear-stale/push/doctor/init |
| `lib/git.mjs` | git reads, and `sideFlag()` — the one definition of "which side is the base" |
| `lib/config.mjs` | `.seamux/restack.json`: defaults, validation, the glob matcher, `init` detection |
| `lib/stack.mjs` | chain discovery (config → graphite → gh → topology) and the `--onto` walk plan |
| `lib/run.mjs` | resolutions, regen recipes, checks; every command summarised to its last 20 lines |
| `lib/state.mjs` | run state in the git dir; the stale list that outlives the run |
| `probe.mjs` | real git repos in a temp dir; `-v` walks it, `--keep` leaves the fixtures |

Trees: state `$(git rev-parse --absolute-git-dir)/seamux-restack.json`, command
logs `$TMPDIR/seamux-restack-logs/`. Probe overrides: `RESTACK_STATE`,
`RESTACK_CONFIG`, `RESTACK_LOG_DIR`.

## Decisions worth not re-litigating

**The state file lives in the git dir.** A linked worktree has its own, so two
worktrees restack independently; `git rebase --abort` and the state describing
it die together; and nothing in it is worth syncing between machines. It is
not in the work tree, so it is never committed.

**The stale list outlives the run.** Everything else is cleared when the walk
finishes. Stale is a property of the *commits*, not of the walk: a finished
walk still leaves a branch carrying the base copy of a file it changes, which
is precisely the CI failure. So `check` and `push` refuse while it is
non-empty, and only a successful regen clears it.

**`git rebase --onto <newParentTip> <oldParentTip> <branch>`, with the tips
recorded before anything moves.** Rebasing a middle branch onto its
already-rewritten parent *without* `--onto` replays the parent's old commits a
second time — that is where duplicated commits in a restacked stack come from.
`git rebase --update-refs` would do the whole chain in one command and was the
first design; the explicit walk won because a stop mid-stack has to be
resumable and attributable to a branch, and `--update-refs` gives you one
opaque rebase to reason about instead of one per branch.

**Graphite drives its own rebase.** In a graphite repo the engine does not
move refs: it runs `gt restack`, resolves between the stops, and `gt continue`.
Two tools writing the same refs is how a stack ends up half-restacked with
gt's parent pointers describing one that no longer exists.

**`--ours` appears exactly once, in `sideFlag()`.** Rebase and cherry-pick
invert what merge does, and a call site that hardcodes a flag is correct until
the day it runs under the other operation. Callers ask for `"base"` or
`"branch"`; the op is read off the repo, not remembered.

**Commands are summarised, not returned.** The usual caller is an agent and a
generator prints thousands of lines. Twenty lines is where the error message
lives; the full log goes to a file and its path is in the payload.

**Push prints.** See the comment on `cmdPush`. The engine has never run a push
and must not learn how — the machine's own Bash guard blocks force pushes from
an agent, and a tool that shelled out to one would be routing around a rail
its user installed.

## The loop that was wrong first

`git rebase --continue` exits **non-zero when the next commit conflicts**. The
first version of `settleConflicts` read that as failure and reported "stopped,
no conflicts" while sitting on one — the probe's two-branch stack caught it.
The loop now treats *the operation ending* as the only success and looks at the
repo again on every other outcome. If you simplify it, keep that property: the
exit code of `--continue` describes the next commit, not this one.

## Two things found by pointing it at a real repo

**`init` detection nearly shipped a `**/*` glob.** Two signatures whose hits
shared neither a directory nor a naming convention (lockfiles and OpenAPI docs
scattered across a monorepo) collapsed to a glob matching every path — which
would have made every file in the repo "generated" and let the engine resolve
a human's conflict by regenerating something. `summarize()` now requires both
a common directory and a separator-anchored suffix of three characters or more,
and returns null otherwise so the caller lists the files. `validate()` refuses
`*`, `**` and `**/*` outright, independently, because the floor should not
depend on the detector being careful.

**A restack can delete a commit, and the first version did it silently.** A
commit whose entire content is a generated file has nothing left once the
artifact is re-derived from unchanged sources, so `rebase --skip` is correct —
and a stack tool that drops a commit without saying so is not one you can
trust with a stack. Every skip is recorded with its sha and subject and
reported in `dropped[]`.

**`take-base` is also a hole in the commit.** It keeps the base copy and drops
the branch's, which is right for a schema re-derived from a migration and
wrong to leave unsaid, so it records a stale entry like a deferred regen does.
Those entries often have no command to run, which is why `clear-stale` exists:
a refusal with no way out is a refusal people learn to route around.

## The judgment layer, and the threshold that was wrong

`lib/judge.mjs` is optional and escalation-only — see SKILL.md for the rule.
Two things here are worth keeping:

**The bar is asymmetric because a symmetric one silently authorizes.** The
first version escalated when the model chose "handwritten" with confidence
>= 0.7. Pointed at a real misconfigured glob, Kev answered `handwritten` at
confidence 0.21 — because its `confidence` is the MARGIN between its top two
options, and it was torn between "handwritten" (0.48) and "unclear" (0.38)
while giving "generated" only 0.14. The file was auto-resolved, the branch's
change was lost, and the commit was then dropped as empty. Three safety
mechanisms in a row said nothing. `safeVerdict()` now asks for the probability
mass on the SAFE option and escalates unless it clears the floor, so a flat
distribution — a model that knows nothing — escalates too. The probe pins all
three shapes, including the 0.14/0.48/0.38 one.

**A judgment that cannot be read is silence, not escalation.** No client, a
failed subprocess, unparsable JSON: `ask()` returns null and nothing is
escalated, because "no answer" must mean "behave as if the layer is absent".
Only a readable answer that fails to clear the bar escalates. Those two look
similar and are opposite.

## verify, and the two false greens

`git range-diff` between the tips the walk recorded is the whole check. Both
bugs found here were the check LYING in the safe direction:

- **range-diff refuses an empty range** ("need two commit ranges"), and the
  empty-new-range case is a branch whose every commit was dropped — the
  loudest possible finding. It came back as "could not check", under a
  printed "nothing of yours moved". Empty ranges are now handled before the
  call, and every commit in the old range is reported as vanished.
- **`countRange` returns null when a range is unreadable**, and coercing that
  to 0 made a broken check look like "every commit is new". Null is now its
  own case, and any unchecked branch makes `verify` exit non-zero. An
  unrunnable safety check is not a pass.

## Known debts (honest list)

- **Chain discovery from topology is a heuristic.** A stacked branch with no
  local ref and no open PR is invisible, and the walk will leave it pointing at
  commits nobody else has. `stack.branches` is the escape hatch; `plan` prints
  the source so a surprising chain is visible before anything moves.
- **`gh pr list` is capped at 100 open PRs** and unauthenticated failures are
  silent by design (topology answers instead). A stack whose bottom PR was just
  merged falls back a step.
- **No lock.** Two `restack run`s in the same worktree would fight; the second
  one refuses only because a rebase is already in progress, which is not the
  same guarantee.
- **`union` uses `git merge-file --union`** and is wrong for any file with
  ordering or a header. It is never a default and probably should never be
  configured; it exists because generated *sets* are real.
- **A regen that touches files outside its artifact's globs** has those changes
  left unstaged — deliberate (a recipe should not sweep your source edits into
  a commit), but it means a badly scoped recipe looks like it did nothing.
- **The breaking-change checks are whatever the config says.** Nothing verifies
  they match CI. A paraphrased pipeline step is the failure mode this tool is
  supposed to prevent, and it cannot detect it.
- **Expensive-tier staleness is only as good as the recorded command.** If the
  config's regen command is stale, the stale entry cheerfully prints it.
- **`verify` cannot tell a deliberate amend from a lost hunk.** It reports
  what changed; the judgment layer ranks it; neither knows your intent.
- **`humanResolved` only records paths resolved at a restack stop.** Resolve
  something with `git rebase --continue` by hand and verify will call it
  unexplained — correct but noisy.
- **The judgment layer is untuned for Kev.** `safeFloor` 0.5 is a starting
  point chosen from a handful of real answers, not a calibration. The log has
  the probabilities; tune it there.
- **No board tie-in.** crew does not show a restack in progress; `status
  --json` is shaped so it could.

## Verifying a change

```bash
node restack/probe.mjs          # must print 0 failed
node restack/probe.mjs -v       # the walkthrough, when you want to see it
node restack/probe.mjs --keep   # leaves the throwaway repos to poke at
python3 tools/scrub_check.py    # no internal identifiers, same as CI
```

The probe builds real repositories and rebases them, because every interesting
property here is a property of git mid-rebase — which side is `--ours`, what
an empty commit does, what the index holds when a generator rewrites a file.
A mock would only ever assert what the author already believed.
