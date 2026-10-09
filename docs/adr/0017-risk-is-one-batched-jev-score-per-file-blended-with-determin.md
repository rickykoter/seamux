# 0017. Risk is one batched Jev score per file, blended with deterministic signals; hunk text reaches a remote endpoint only with an opt-in

Date: 2026-10-09

## Status

Accepted

## Context

TypeSafe's established pattern is per-item scores sorted in code (crew/hooks/asked.py; deep-plan/lib/evidence.mjs:137). Here the client resolves to the remote api.typesafe.ai, and restack sends content only to loopback (restack/lib/judge.mjs:85-88). You chose an explicit per-repo opt-in for sending hunks.

## Decision

Risk is one batched Jev score per file, blended with deterministic signals; hunk text reaches a remote endpoint only with an opt-in

## Consequences

With a remote endpoint and no opt-in, the scorer sends paths, add/delete counts and hunk headers only; `.seamux/lookout.json` `sendContent: true` (or a loopback endpoint) adds hunk text; scores are read from the distribution, not `confidence`; any TypeSafe failure falls back to signals only, and the page says so; scores are cached in the review store keyed by the patch hash.
