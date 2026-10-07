# The verification setup prompt

Paste this into a session sitting in the repo, when `deep-plan verify init`
has found little prior art or a plan's render was refused for increments
with no checks. It produces a reviewed `.seamux/verify.json` per project, not
a guessed one. The session walks it with you: every command it proposes is
one you watch pass.

Replace nothing; the prompt asks for what it needs.

---

```
Set up verification recipes for this repo, for deep-plan (`deep-plan` with
no arguments lists the verbs; its SKILL.md explains the checks gate). The
deliverable is a reviewed
.seamux/verify.json for each project that needs one, plus a short report —
not a committed file, and nothing pushed.

1. Run `deep-plan verify init` (a dry run). Read what it found per project:
   the scripts it drafted as recipes, the CI steps it cited, the runner and
   host configs, and the remote templates it suggests. Then
   `deep-plan verify init --write` writes each draft that does not exist yet;
   it never overwrites one.

2. Walk every recipe's `todo` list with me, one recipe at a time:

   - **Confirm the command.** Where CI runs it, the draft cites path:line;
     open that step and make the recipe run the same thing, adapting only what
     has to change locally. Where nothing in CI runs it, ask me whether it is
     the command a reviewer would trust. Never invent one: a recipe nobody has
     run is worse than none. If the detector flagged a matrix job, a composite
     action or a reusable workflow, read the real steps before copying.
   - **Prove it.** Run it twice from a clean tree. Both must pass, and after
     the second `git status --porcelain` must be empty — a check that dirties
     the tree stales every pass it records.
   - **Tier it on the measurement.** Time the second run. `cheap` is seconds,
     with no build, server, container or network; anything else is
     `expensive`, and runs detached. Do not mark a slow suite cheap to make
     it run inline.
   - **Scope it.** Set `match` globs (relative to the project) so the recipe
     covers the files it actually verifies, and decide `default` with me: a
     default recipe becomes a check on every increment whose files it
     covers, so a 20-minute suite as a default lands on every increment.
   - Delete the `todo` once each item is done; keep `evidence`.

3. Remote QA, when the project deploys somewhere a preview can be tested:
   pick the template that matches the host (`deep-plan verify init
   --template <name>`, from deep-plan's verify/templates/: vercel-preview,
   firebase-channel, rwx-run, github-deployment). Its acquire step is mine to
   run — deep-plan never pushes or deploys. Make the e2e suite read
   $BASE_URL. Then prove the template: deploy a preview, run the wait step
   once by hand, and check it prints the URL and exits 0 (and prints nothing
   before the deploy is ready). A template you could not prove stays
   `"verified": false`, and the report says so.

4. Check the resolution: `deep-plan verify resolve <files>` for a few files
   in each project, to show each lands on the config and recipes you meant.

Refusals to respect: no secrets or tokens in any command — they are shell
strings read out of the working tree, so rely on the environment; no glob
that silently covers another project; no acquire step run by you.

Finish with a table: each recipe → the CI step it mirrors (path:line) or
"none — confirmed with me" → measured runtime → tier → default or not, and a
list of anything left out and why. Then ask me before committing the files.
Do not push anything.
```

---

## Why the prompt is shaped like this

- **Detection drafts, people decide.** `verify init` finds what exists and
  writes every gap as a TODO; the prompt turns each TODO into a question
  answered with evidence, so the config that gates `done` is one somebody
  watched pass.
- **Commands come from CI where CI exists.** A recipe that diverges from the
  pipeline goes green locally and red on the branch; citing path:line makes
  that reviewable.
- **Twice, from clean.** A flaky or tree-dirtying check makes every pass it
  records suspect, and `done` compares the tree a pass ran against.
- **Tiers come from a stopwatch.** Expensive checks run detached so a long
  suite never blocks a session; the honest tier is what the clock said.
- **Remote steps split at the person.** Acquiring a preview acts outside the
  machine, so it stays a human step (ADR: the human runs acquire steps);
  waiting and testing read remote state, so the engine automates them.
- **Templates are proven or labeled.** Provider CLIs change. A template is
  copied into the repo and owned there, and one nobody has run against a
  real preview says so.
