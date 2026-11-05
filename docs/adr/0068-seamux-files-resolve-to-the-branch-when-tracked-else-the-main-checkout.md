# 0068. .seamux files resolve to the branch when tracked, else the main checkout

Date: 2026-11-04

## Status

Accepted. Amends [0061](0061-lessons-live-in-a-committed-seamux-lessons-md.md).

## Context

deep-plan, lookout and restack each read `<checkout>/.seamux/<file>` from whatever checkout they run in, through about 11 separate root lookups. Only state on the remote host already hangs off the main checkout (`host.mjs` `remoteStateDir`). That works in a repo that commits `.seamux`, where a branch must see its own recipe and lesson edits. It fails in a repo that ignores `.seamux`, such as the monolith: each worktree holds an untracked copy that drifts from main's. One worktree's `ops/.seamux/verify.json` was 8.4 KB against main's 14.7 KB. ADR 0061 assumes `lessons.md` is committed, which is false in those repos.

## Decision

A `.seamux` file that git tracks in the worktree is read from the worktree. Any other `.seamux` file is read from the same relative path under the main checkout, the parent of the shared `.git`. A nested project folder (`ops/.seamux/verify.json`) maps to `ops/.seamux/verify.json` in main. Outside git, in the main checkout itself, or with a git dir not named `.git`, the path is used as given.

## Alternatives

- Read every `.seamux` file from the main checkout. This breaks branch-local edits in repos that commit `.seamux`.
- Use the worktree's file whenever one exists. The monolith's stale worktree copies would keep shadowing main's.
- Map a configured side repo into every checkout. That gives history and sharing, but adds a mapping layer and a sync step to every read.

## Consequences

Repos that commit `.seamux` behave as before. In repos that ignore it, a worktree's own copy is passed over, with a one-line warning when it differs from main's. Writes such as retro's lessons land in main's untracked folder. Recipe globs and commands still run relative to the worktree folder; only the file is read from main.

ADR 0061 is amended: `lessons.md` lives where this rule resolves it, which is committed on the branch in a repo that commits `.seamux`, and main's untracked copy otherwise.

The resolver, `resolveSeamux`, is copied into `deep-plan/lib/host.mjs`, `lookout/lib/host.mjs` and `restack/lib/config.mjs` (ADR 0004), and the probes check that the copies agree.
