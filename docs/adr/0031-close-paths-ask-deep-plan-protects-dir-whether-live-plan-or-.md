# 0031. Close paths ask `deep-plan protects <dir>` whether live plan or family work is there

Date: 2026-10-24

## Status

Accepted

## Context

crew's close paths each read plan state their own way (exact root, `done` only), and none knows about families. The human chose one engine answer over crew reading the index itself.

## Decision

Close paths ask `deep-plan protects <dir>` whether live plan or family work is there

## Consequences

`deep-plan protects <dir> --json` prints `{protected, plan, phase, open, family: {parent, role, live}}`, or `{protected: false}`. A directory is protected when it sits inside a plan's root whose phase is not done or closed or that has an increment not done, or inside any member's root while its family is not done. crew's Python and Rust close paths call it and refuse on `protected: true` (family-close-guard).
