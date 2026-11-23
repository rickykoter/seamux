# Policy: how far work on each path goes without a person

## Contents

- [The levels](#the-levels)
- [The file](#the-file)
- [Where it is read from](#where-it-is-read-from)
- [What render does with it](#what-render-does-with-it)
- [Ship](#ship)
- [The Merge stage](#the-merge-stage)

## The levels

Lowest first:

| Level | What happens without a person |
|---|---|
| `supervised` | nothing: a person says go to every increment |
| `auto-go` | increments follow on by themselves (a plan's `go: auto`); a person opens and merges the PR |
| `auto-pr` | `deep-plan ship` opens the PR, or marks the draft ready; a person merges it |
| `auto-merge` | `deep-plan ship` also merges it, once every gate passes |

Land write approvals (a deploy, a notebook) stay a person's at every level.

A path's level is the lowest of the policy entries that match it, else the
default. A change's level is the lowest of its files'.

## The file

`.seamux/policy.json`:

```json
{ "default": "auto-go",
  "paths": [
    { "match": ["docs/**", "*.md"], "level": "auto-merge" },
    { "match": "src/payments/**", "level": "supervised", "fix": "off" } ],
  "scenarios": { "require": "auto-pr", "threshold": 0.8 },
  "merge": { "method": "squash" } }
```

- `default` and each entry's `level`: one of the four levels.
- `match`: a glob or a list of globs, as in verify.json.
- `fix`: `off`, `diagnose` or `draft-pr`. It is validated and shown, never
  acted on yet; the fixer that starts a session on a failure reads it.
- `scenarios.require`: `true` (at auto-pr and above), `false`, or the
  lowest level that needs a scenarios check. `threshold`, `writer` and
  `judge` set the defaults for the scenarios check.
- `merge.method`: `merge`, `squash` (the default) or `rebase`.

`deep-plan policy check` validates the worktree's copy.

## Where it is read from

From the base branch (`origin/<base>`, fetched first), never the worktree,
so a branch cannot raise its own level: the way CODEOWNERS works. A change
to the policy takes effect once it is merged.

- A repo with no policy keeps the behavior from before policies: every path
  is auto-go.
- A policy that cannot be fetched, parsed or validated falls to
  supervised, never higher. Offline, a repo with a remote reads as
  supervised.

`deep-plan policy show [file...]` prints the base branch's policy and each
named file's level, with the entry that set it.

## What render does with it

Render reads the policy and stores each increment's level, from its files.
Status and the plan page show it. Render refuses:

- `go: auto` on an increment after the first whose files are supervised,
  unless that increment stops for a person (`go: { "human": "<why>" }`);
- a plan whose files all sit at or above `scenarios.require` with no
  scenarios check on any increment.

`--force` does not get past either: the policy is the base branch's, not
the plan's. Change the policy on the base, or stop the increment for a
person.

## Ship

After `deliver`, run:

```
deep-plan ship <slug> [--dry-run] [--json]
```

It reads the policy again and takes the level of the files the branch
changes against its base. A file moved out of a path counts its old path
too. It then checks each gate and takes one step:

- supervised or auto-go: nothing; it says a person opens and merges the PR.
- auto-pr: once the plan is delivered and the branch is pushed, it opens
  the PR against the policy's base, or marks the draft ready.
- auto-merge: the same, and then it merges once every scenarios check
  passed and the newest full judge run passed at HEAD (a retry's carried
  passes do not count; see scenarios.md), the PR targets the policy's base, its head is HEAD, it has no
  conflict, and its checks are green. The merge is pinned to HEAD. With
  checks still running, it uses GitHub's auto-merge when the repo allows
  it, the base requires checks, and every check on the PR is a required
  one; otherwise it starts a detached wait of its own, which looks again
  every minute and stops if HEAD moves or any gate breaks.

A branch that changes anything under `.seamux/` (the policy, the recipes,
the scenarios harness) is capped at auto-pr: a person merges it. Exit 3
means ship waits on something, and the output says what. Its record is
`~/.claude/plans/<slug>.ship.json`.

Never run `gh pr merge` yourself, and never approve a land write: at
auto-merge the merge is ship's, and below it the merge is a person's.

## The Merge stage

The seamux app's Lookout tab shows, at a PR's Merge stage, the change's
level and the entry that set it, and what ship waits on, from
`deep-plan ship --at <worktree> --dry-run --json`.
