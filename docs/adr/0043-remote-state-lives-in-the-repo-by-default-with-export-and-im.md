# 0043. Remote state lives in the repo by default, with export and import to move it

Date: 2026-10-29

## Status

Accepted

## Context

a remote sandbox loses ~/.claude, and a gate whose state is gone fails open without a word.

## Decision

Remote state lives in the repo by default, with export and import to move it

## Consequences

On the remote host, deep-plan's state, keys and plans and lookout's reviews default to a git-ignored .seamux/state/ under the git root. The DEEP_PLAN_*_DIR and LOOKOUT_REVIEWS_DIR overrides still win. `deep-plan export-state <slug>` and `import-state <file>` move one plan, with its reviews, between sandboxes. Nothing is committed automatically. `status` warns when a remote session's state sits outside the repo.
