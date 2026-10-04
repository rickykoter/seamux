# The setup prompt

Paste this into a session sitting in the work repo, ideally right after a
rebase that hurt — the conflicts still in that session's context are the best
evidence available about which files are generated, and they cost nothing to
recall. It produces a reviewed `.seamux/restack.json`, not a guessed one.

Replace nothing; the prompt asks for what it needs.

---

```
Set up restack for this repo. It is the restack plugin (`restack` on PATH,
`restack --help`, `restack engine` names its root, and its SKILL.md explains the model).
Read that SKILL.md first. The deliverable is a reviewed .seamux/restack.json
plus a short report — not a committed file, and nothing pushed.

Start from the rebase you just finished, because it is the only real evidence
in the room:

1. List every path you hand-resolved in it, and for each one say whether a
   human wrote that file or a command produced it. Only the ones a command
   produced belong in the config. If you are unsure, find the command; if no
   command produces it, it is source and it stays out. `ls .git/rr-cache`
   and `git diff ORIG_HEAD --stat` can jog it if the paths have scrolled away.
2. Then `restack init`, which detects the usual suspects and deliberately
   leaves every regen command empty. Merge its findings with your list.

For each artifact entry, do this work before writing the entry:

- **Narrow the glob.** It must match the generated files and nothing else. An
  artifact glob is a licence to resolve a conflict without asking, so a glob
  that reaches one hand-written file is worse than no entry at all.
  `restack doctor` prints how many tracked files each glob matches — check the
  count against what you expect, and look at the list if it surprises you.
- **Get the regen command from CI, not from memory.** Find the pipeline step
  that regenerates or validates this file and cite it as path:line in your
  report. Copy what it runs; adapt only what has to change to run locally
  (drop the container wrapper only if the command works without it). A
  paraphrased CI step is exactly the failure this tool exists to prevent.
  If you cannot find how CI produces the file, leave `regen` empty, set
  `resolve` to `take-base`, put what you know in `note`, and say so in the
  report — a command nobody has run is worse than none.
- **Prove it.** Run the command twice from a clean tree. After the second run
  `git status --porcelain` must be empty: a generator that is not idempotent
  will make every restack look stale. Time it.
- **Tier it on the measurement.** `cheap` if it is seconds and needs no
  container or database, `expensive` otherwise. Expensive recipes are skipped
  during a walk and recorded stale with their command, which is the right
  trade — do not mark something cheap to make the output tidier.

Then the checks: for every CI step that compares this repo against the base
and can fail (a breaking-change comparison, a regenerate-and-assert-no-diff),
add a `checks` entry running the same comparison against the configured base
ref. Cite each one's path:line too. Tier them the same way.

Refusals to respect: no glob matching the whole repo (the config loader
refuses `*`, `**`, `**/*`); no invented commands; no secrets or tokens in any
command — these are shell strings read out of the working tree, so write them
to rely on the environment CI and I already have.

Finish with:

- `restack doctor` — it must be green, and paste the output.
- `restack plan --json` from a branch that is actually behind the base, to
  show the classification working on a real case.
- A table: each entry → the CI step it mirrors (path:line) → measured runtime
  → tier, and a list of anything you deliberately left out and why.
- Then ask me before committing the config. Do not push anything.
```

---

## Why the prompt is shaped like this

- **The rebase is the evidence.** A session that just resolved these conflicts
  knows which files fought and which of them it edited by hand. Asking for
  that list first is cheaper and more accurate than any detection pass, and it
  is gone once the context is compacted.
- **Every command is cited to CI.** The one failure `restack check` cannot
  detect is a check that does not match the pipeline: it goes green locally
  and red on the branch. Making the session quote `path:line` turns that from
  a hope into something reviewable.
- **Idempotence is measured, not assumed.** A generator whose output differs
  run to run marks the artifact stale on every walk, and the refusal stops
  meaning anything within a day.
- **Tiers come from a stopwatch.** Cheap and expensive are the difference
  between a walk that takes a minute and one that takes an afternoon, and the
  honest answer is whatever the clock said.
- **It ends in review.** The config is a licence for a tool to resolve
  conflicts without asking. That is worth reading before it is committed.
