# 0062. Candidates during the plan, curated at the retro

Date: 2026-11-02

## Status

Accepted

## Context

The human wanted lessons.md kept free of cruft; capturing every miss straight into it would fill it with one-off noise

## Decision

Candidates during the plan, curated at the retro

## Consequences

Misses become candidates in <state>/<slug>.lessons.jsonl, append-only like notes. The agent files one with `deep-plan lesson "<what went wrong>"` after any correction from the human; the engine files one at a failed grade, a done --force, a review check failing on an open blocker or major, and the retry cap. `deep-plan retro <slug>` lists them and each is kept, merged into an existing lesson, or dropped. deliver and close refuse while a candidate is unsettled, as they do for open notes; --force stays a person's. Past 30 lessons, keep refuses until a merge or retire makes room, and render refuses a repo whose file is over the cap.
