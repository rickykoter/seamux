# 0108. One repo policy sets each path's level, read from the base branch, and at auto-merge the engine merges

Date: 2026-11-18

## Status

Accepted

## Context

(context not recorded)

## Decision

the person chose auto-merge at the top level; read from the base branch, a change cannot raise its own level, which is how CODEOWNERS works

## Consequences

levels are supervised < auto-go < auto-pr < auto-merge. A change's level is the lowest of its files' levels. Render refuses go: auto above the ceiling of an increment's files. deep-plan ship opens the PR at auto-pr, and at auto-merge merges it with gh, once the delivery review is closed, scenarios meet their threshold, PR checks are green, and the PR does not touch the policy. It uses GitHub's auto-merge when the repo allows it, and its own detached wait when not. Land write approvals stay a person's at every level. The agent never runs gh pr merge itself

## Notes

The increment's review added these safeguards. The branch's files are
diffed with renames off, so a file moved out of a supervised path counts
its old path too. The policy is always fetched, with no switch to read a
local ref. A branch that changes anything under `.seamux/` (the policy, the
recipes, the scenarios harness) is capped at auto-pr. Ship merges only a
PR whose base is the branch the policy was read from, and pins the merge
to HEAD. It asks for GitHub's auto-merge only when the base requires
checks and every check on the PR is a required one; otherwise it runs its
own wait.
