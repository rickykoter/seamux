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
  "scenarios": { "require": "auto-pr", "paths": ["app/ui/**"], "threshold": 0.8 },
  "merge": { "method": "squash" } }
```

- `default` and each entry's `level`: one of the four levels.
- `match`: a glob or a list of globs, as in verify.json.
- `fix`: `off`, `diagnose` or `draft-pr`. It is validated and shown, never
  acted on yet; the fixer that starts a session on a failure reads it.
- `scenarios.require`: `true` (at auto-pr and above), `false`, or the
  lowest level that needs a scenarios check. `threshold`, `writer` and
  `judge` set the defaults for the scenarios check.
- `scenarios.paths`: a list of globs. When set, only a change that touches
  a matching file needs a scenarios check; left out, every change at the
  require level does. Use it where the judge can run one part of the repo
  (pages against a mock) and not another (a backend).
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
- a plan whose files all sit at or above `scenarios.require`, and that
  touches a `scenarios.paths` file when the policy sets them, with no
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
- auto-pr: once the plan is delivered, it pushes the branch and opens the
  PR against the policy's base, or marks the draft ready.
- auto-merge: the same, and then it merges once every scenarios check
  passed and the newest full judge run passed at HEAD (a retry's carried
  passes do not count; see scenarios.md), the PR targets the policy's base, its head is HEAD, it has no
  conflict, and its checks are green. The merge is pinned to HEAD. With
  checks still running, it uses GitHub's auto-merge when the repo allows
  it, the base requires checks, and every check on the PR is a required
  one; otherwise it starts a detached wait of its own, which looks again
  every minute and stops if HEAD moves or any gate breaks.

Ship pushes the branch itself (`git push -u origin <branch>`) whenever
HEAD is ahead of origin, and only as a fast-forward. When origin has
commits HEAD lacks, git refuses the push and ship stops, saying how to
bring them in; it never forces. The PR body it writes comes from the
plan: the title, the context's first paragraph, each increment with its
checks' verdicts, the level and who merges, and where the approved plan
is.

It reads GitHub the way a fine-grained token allows. Whether the repo
allows auto-merge comes from GraphQL, and the base's required checks from
its rulesets before classic branch protection (which needs administration
read). When `gh pr checks` is refused, the checks come from the head
commit's Actions runs, where a check from another service is not seen. A
`token` gate names any permission a read was refused for, from GitHub's
`X-Accepted-GitHub-Permissions` header, and lists what ship needs:
pull requests write, contents write, checks read, and commit statuses
read and write. It warns and does not hold. A failed check that is also
red on the base's tip says "also failing on main at <sha>", and still
holds the merge.

Each run that is not `--dry-run`, and each look of ship's own wait, posts
a `seamux/ship` commit status on HEAD once origin has it, at every level:
pending while any of ship's own gates waits (delivered, scenarios,
stacked, the PR's base), success once they all pass. CI's checks are
GitHub's to gate, not this status's. A branch with no plan gets success,
"a person's call". Requiring `seamux/ship` in the base's ruleset makes
GitHub's merge button wait on ship's gates too, whoever presses it.
Require it from any source: ship posts it with the person's token, so an
entry pinned to an app's integration is never met. A merge refused while
the status could not be posted says why.

A `kept checkout` gate looks at the repo's main worktree, the one a
landing pulls into: it must be on the base branch with no uncommitted
tracked changes. At auto-merge a dirty or switched one is a wait that names
the files; below it, a warning. It is skipped when the plan's root is the
main worktree.

A PR merged by anyone but ship is recorded in the ship record and the
plan log: as GitHub's when ship had asked for its auto-merge, otherwise as
the person's. Ship's wait stops there and says so.

On a family child whose branch still carries its parent's commits, a
`stacked` gate comes first, at every level: the child waits while the
parent's PR is open, and once it is merged, waits on its own `git rebase
--onto`, which the gate spells out (families.md). On the parent, the same
gate passes and lists the stacked children. Ship acts only on the plan's
own branch.

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
