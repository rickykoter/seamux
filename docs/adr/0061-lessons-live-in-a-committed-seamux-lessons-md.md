# 0061. Lessons live in a committed .seamux/lessons.md

Date: 2026-11-02

## Status

Accepted. Amended by [0068](0068-seamux-files-resolve-to-the-branch-when-tracked-else-the-main-checkout.md): lessons.md is read where that rule resolves it, so in a repo that ignores .seamux it is main's untracked copy.

## Context

Notes (ADR 0044) live beside each plan's state under ~/.claude/deep-plan/state and close with the plan. Lessons must outlive plans and reach every session in the repo, including cloud sandboxes with no shared state branch.

## Decision

Lessons live in a committed .seamux/lessons.md

## Consequences

One markdown file per repo, at most 30 lessons, each a short rule with an id (L1, L2…), an `applies:` list of path globs and the plan it came from. The engine writes it only through `deep-plan retro`; a person may edit it by hand and commits it. A cloud session reads it with no sync.
