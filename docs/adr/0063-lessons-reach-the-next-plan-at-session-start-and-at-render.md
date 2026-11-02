# 0063. Lessons reach the next plan at session start and at render

Date: 2026-11-02

## Status

Accepted

## Context

The human chose both: context at session start so drafting starts informed, and a render warning so a relevant lesson cannot be skipped silently

## Decision

Lessons reach the next plan at session start and at render

## Consequences

The SessionStart run of the news hook adds the repo's lessons.md, cut to 4 KB and quoted as data. Render warns, never refuses, when a lesson's applies globs match a deliverable's files and no decision or risk mentions its id.
