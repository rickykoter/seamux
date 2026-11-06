# 0074. Turn snapshots live under refs/seamux/turns/<session>/<n>/{start,end}, last 50 per session

Date: 2026-11-06

## Status

Accepted

## Context

Every worktree of a repo shares one refs namespace through the common dir. The app's review jobs already use refs/seamux/<id>/head and base.

## Decision

nothing touches your branch, your index or the stash: each snapshot is a parentless commit built on a scratch index, and the ref alone keeps it from garbage collection. A session id keeps two sessions in one repo apart, and 50 turns plus a 7-day sweep of ended sessions bounds what they pin

## Consequences

Each snapshot is a parentless commit whose tree is the whole working tree, untracked files included and .gitignore respected. Objects stay pinned for the last 50 turns of each session; SessionStart drops refs of sessions whose log has not moved in 7 days. A turns segment keeps them clear of the review jobs' refs unless a review id is itself named turns.
