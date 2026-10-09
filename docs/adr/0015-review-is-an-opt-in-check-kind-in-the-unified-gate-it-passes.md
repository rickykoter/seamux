# 0015. Review is an opt-in check kind in the unified gate; it passes when no blocker or major finding is open

Date: 2026-10-09

## Status

Accepted

## Context

ADR 0006 says every gate feature extends the one checks list instead of adding a verdict of its own. Opt-in by declaration keeps plans without reviews unchanged. Gating on blocker/major only keeps nits from holding an increment hostage, and running it as a command (`lookout gate`) means `check run`, staleness and the done refusal all work unchanged.

## Decision

Review is an opt-in check kind in the unified gate; it passes when no blocker or major finding is open

## Consequences

CHECK_KINDS gains `review`; a declared review check gets a synthesized command (`lookout gate --plan <slug> --inc <n>`) rather than a recipe, so no repo needs a verify.json entry; a pass goes stale after an edit like any check; minor and nit findings may remain open and are listed in the check note; a review check on a machine without lookout fails with an install hint, never passes.
