# 0013. lookout is a sixth seamux plugin; deep-plan reaches it only through its CLI

Date: 2026-10-09

## Status

Accepted

## Context

The review tool is general (branches, ranges, patches), not a deep-plan feature, and ADR 0004 already says one plugin per feature. Plugins install from their own folders, so deep-plan cannot import another plugin's lib (deep-plan/lib/verify.mjs:25-27): a CLI with exit codes is the only stable seam. The name is sea-themed and collision-free; Claude Code already owns /code-review and /review.

## Decision

lookout is a sixth seamux plugin; deep-plan reaches it only through its CLI

## Consequences

deep-plan depends on lookout only at run time, through `lookout gate` and `lookout open` found via lookout's engine pointer or shim; a plan without a review check never needs lookout installed; lookout carries its own setup (shim, engine pointer, pinned highlight.js), probe, and marketplace entry; install.sh and CI grow a sixth plugin.
