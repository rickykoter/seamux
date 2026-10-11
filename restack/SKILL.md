---
name: restack
description: Rebases a stack of branches onto a moved base without hand-resolving generated files — regenerates schemas and clients instead of merging them, then runs the staleness and breaking-change checks CI would run, and stops before the push. Use when the user asks to restack, rebase a stack or a PR chain, fix conflicts with master/main, deal with schema or API drift, a stale generated/checked-in artifact, or a "breaking change" CI failure.
---

# restack

The companion to `deep-plan`: that one is how work gets agreed, this one is
how it survives the week it takes to land. Same shape — a refuse-first CLI,
state on disk, a compact JSON payload for the agent, and a stop wherever a
human is actually needed.

Run it from the worktree. While the restack plugin is enabled, `restack` is on
the Bash tool's PATH from the plugin's `bin/`; the engine is `restack.mjs` at the
plugin's root, wherever it is installed. `restack engine` prints that root, and
`restack setup` installs a `~/.local/bin/restack` shim for your own shell.

## Must hold

- **Never hand-resolve a generated file.** The fix is a config entry naming
  it and a command that rebuilds it.
- **Stop before the push.** `restack push` prints the lines; hand them to the
  human, bottom branch first. Never force-push yourself.
- **A stale list is a promise.** Clear it by regenerating; `restack
  clear-stale` asserts the artifact is correct without checking, so use it
  only when it is, and tell the human you did.
- **Read the JSON, report what it says.** Every verb takes `--json`; a failure
  is reported with its command and its tail, never as "some checks failed".
- **A judgment may escalate, never authorize.**
- **`restack abort` is always safe** before a push, and the right answer to
  any surprise.

## The two failures it exists for

1. **A generated artifact conflicts on every branch of the stack.** A checked-in
   GraphQL dump, a Rails schema, a generated client, a lockfile. It is derived
   data: resolving it by hand is editing the output of a program, and every
   conflict in it is the same conflict, once per branch. The engine resolves it
   to the base copy and re-derives it.
2. **The base moved, your checked-in copy did not, and CI says so twenty
   minutes later** — "generated file is out of date", or a breaking-change
   comparison against master. Those are two commands; they can run here, before
   the push, against a freshly fetched base.

## The discipline, in order

0. **Read before you rebase.** `restack status` and `restack plan --json` are
   read-only and cheap. `plan` fetches the base, walks the chain, and names the
   generated artifacts **both sides touched**. Each one is re-derived in every
   replayed commit that changes it, whether git conflicts on it or merges it
   cleanly (a clean merge of a generated file is still one no generator wrote),
   and you will not have to look at any of them. If the chain it found
   is missing a branch, stop: fix `stack.branches` in the config before moving
   any refs, because a walk that does not know about a branch leaves it
   pointing at commits the rest of the stack no longer has.
1. **Never hand-resolve a generated file.** Not once, not "just this one line".
   If a conflict is in a generated artifact, the fix is a config entry naming
   it and a command that rebuilds it, and the payoff is every future
   restack. A hand-merged schema is a file that no generator would ever emit,
   and nothing downstream is expecting it.
2. **`restack run`.** It walks the stack bottom-first, resolves every derived
   conflict, and **stops only for conflicts a human owns**. Exit 2 and
   `"status": "needs-human"` mean exactly that: the payload lists the files with
   a hunk count each. Resolve them, `git add` them, then `restack continue`.
   Nothing else in the walk needs you.
3. **Run the cheap tier during the walk, the expensive tier once at the end.**
   A generator that needs a container or a migrated database does not belong
   inside a five-branch walk. Those artifacts are resolved to the base copy and
   recorded **stale**, with the command that fixes them. Finish the walk, then
   `restack regen --deep` (or run the command yourself), then commit — and say
   which branch you amended.
4. **A stale list is a promise, not a warning.** `restack check` and
   `restack push` both refuse while it is non-empty. Two things land on it: a
   deferred regen, and a `take-base` resolution — which *drops* your branch's
   copy of that artifact on purpose, because it is re-derived from a migration
   or a manifest rather than merged. Clear it by running the generator
   (`restack regen --only <name> --deep`), or, when there is no generator, by
   re-deriving it yourself and then `restack clear-stale --only <name>`. That
   verb asserts the artifact is correct as committed; it checks nothing, it is
   logged, and it is a thing to tell the human you did.
5. **Prove it locally: `restack check --deep`.** Staleness (regenerate, assert
   no diff) and the repo's breaking-change comparisons, against the base as it
   is right now. This is the step that turns a twenty-minute CI round trip into
   a local one. Report what it found; do not summarise a failure as "some
   checks failed" when the payload has the command and the last twenty lines.
6. **Stop before the push.** `restack push` PRINTS the lines. It has never run
   one and must not learn how: a restacked stack can only go up with a force
   push, and this machine's Bash guard blocks those from an agent by design.
   Hand the lines to the human, bottom branch first. If they ask you to push
   anyway, that is their call to make and their command to run.
7. **A commit that vanished is reported — read that line.** A commit whose
   whole content was a generated file has nothing left once the artifact is
   re-derived, so the rebase drops it (`dropped[]` in the payload, with the
   subject). That is usually correct and occasionally the sign that a commit
   was only ever a regen someone else already did. If it is a surprise,
   `git reflog <branch>` still holds the pre-restack tip.
8. **`restack verify` before you push.** The walk reports that every commit
   applied; verify answers the different question — *does your patch still say
   what it said*. It range-diffs each branch against the tips recorded before
   anything moved and buckets every difference: regenerated artifacts
   (expected), files you resolved by hand during the run (expected), and
   anything else. Residue is not automatically bad, but nothing else in the
   toolchain will ever mention it. A branch it could not check is reported as
   unchecked and exits non-zero — an unrunnable safety check is not a pass.
9. **Re-target the PRs after the refs move.** Restacking rewrites every branch
   above the one that changed; the PR bases are unchanged but the diffs are
   not. Check the PR chain still reads correctly before asking for review.

## Config — `.seamux/restack.json`

Per repo and committed. `restack init` writes a starting point, with every
detected regen command left empty on purpose — a command nobody has run is
worse than none. The fields (`resolve`, `tier`, `checks`), a worked example,
and why running restack trusts a repo's config like its Makefile:
[references/config.md](references/config.md). Setting one up right after a
rebase that hurt: `examples/setup-prompt.md` in the plugin root.

## The inversion that causes bad resolutions

During a **rebase**, `--ours` is the base you are landing on and `--theirs` is
your own commit. During a **merge** it is the other way round. Every "I took
ours and shipped master's stale schema" is this. The engine never writes
`--ours` at a call site: it asks for a side by meaning (`base` / `branch`) and
`lib/git.mjs` maps it against the operation actually in progress.

Which is also why the resolution for `regen` starts from the **base** copy: a
generator that only rewrites part of a file leaves master's new content in
place and re-derives yours. Starting from your copy cannot lose your change
either — but it can lose someone else's.

Related: the Bash guard blocks `git checkout -- <path>` from an agent, so
reaching for raw checkout to resolve a conflict will simply be denied. Let the
engine do it.

## For the agent: the payload, and the exit codes

Every verb takes `--json`. Read the JSON, not the terminal text.

```
0  done — nothing needs the human
1  refused or failed  → .error, or .staleness / .checks entries with .out
2  needs-human        → .conflicts.source[{path, hunks}], .next[]
```

`run` and `continue` return the same shape: `.conflicts.generated[]` (what was
resolved for you, per artifact, with the regen result), `.conflicts.source[]`
(yours), `.dropped[]` (commits that became empty), `.stale[]`, `.next[]`. Command output is already summarised to the
last twenty lines with the full log at `.log` — do not cat the log unless the
tail is not enough, and never paste a generator's full output back into the
conversation.

`restack status --json` is the cheap "where am I" call: mid-rebase or not,
how far behind the base, what is stale. Prefer it to `git status` plus three
follow-ups.

## The judgment layer (optional, local, escalation-only)

When a TypeSafe-compatible client is on the machine, restack asks it three
narrow questions: does a conflicted file an artifact glob claimed really read
as generated, does a commit that became empty matter, and is `verify`'s
leftover residue semantic. **A judgment may escalate, never authorize** — no
answer makes restack resolve, clear or push anything it otherwise would not,
and `--no-judge` turns it off. The asymmetric bar, what leaves the machine,
and tuning `judge.safeFloor`: [references/judgment.md](references/judgment.md).

## When a plan is in flight

If the worktree has a `deep-plan` plan (`deep-plan status --json`), drift is
not only a merge problem. Base changes that land on a surface the plan declared
in its `contracts` block are a **plan amendment**: amend the spec and
re-render, rather than resolving the conflict and moving on. The increment gate
does not know the schema moved underneath it; you do.

## Troubleshooting

| symptom | cause |
|---|---|
| `plan` lists fewer branches than your stack | no local ref, or no open PR — set `stack.branches` explicitly |
| everything reports `already-current` | you are already on top of the base; check you fetched (`--no-fetch` trusts the ref on disk) |
| the walk stops on a generated file anyway | if its line says "sent to you", the judgment layer doubted it was generated (the reason follows); otherwise its path matches no artifact glob — `restack doctor` shows what each glob actually matches |
| `regen` rewrote nothing but CI still says stale | the command runs somewhere else than the checked-in copy, or only part of it; compare `git diff` after running it by hand |
| `check` is green and CI is not | the check command is not the CI command — copy CI's, do not paraphrase it |
| stale will not clear | only a successful regen clears it: `restack regen --only <name> --deep`, or `restack clear-stale --only <name>` when the artifact has no generator |
| `verify` says a branch is NOT CHECKED | a recorded tip no longer resolves (gc, a manual reset) — treat it as unverified, not as clean |
| `verify` flags a file you did resolve | it was resolved outside a restack stop, so nothing recorded it; read the hunk and move on |
| the guard escalates constantly | the model cannot tell your generated files apart — narrow the globs, or lower `judge.safeFloor`, or `--no-judge` |
| a commit disappeared | it became empty after its generated file was re-derived; `dropped[]` names it, `git reflog <branch>` has the old tip |
| `gt restack did not converge` | graphite and the engine disagree about the stack; `restack abort`, then `gt restack` by hand once |
| a branch came back with duplicated commits | it was rebased outside the walk mid-run — `restack abort` and start over from a clean tree |

`restack abort` puts every branch back where it was. It is always safe, and it
is the right answer to any surprise before a push, because nothing has left the
machine yet.

Verify any change to this skill with `node restack/probe.mjs` from the checkout
— real git repos in a temp dir, thrown away, no arguments.
