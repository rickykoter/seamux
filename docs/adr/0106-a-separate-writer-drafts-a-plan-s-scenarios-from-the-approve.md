# 0106. A separate writer drafts a plan's scenarios from the approved plan, and they are sealed outside the worktree

Date: 2026-11-18

## Status

Accepted

## Context

(context not recorded)

## Decision

the person chose it: scenarios the building agent wrote or can read stop being an independent check, and a person writing every one costs time on every plan

## Consequences

after the grade passes, deep-plan scenarios write starts a fresh headless model with only the approved plan and the repo's harness, and stores ~/.claude/deep-plan/sealed/<slug>/scenarios.json (0600). The person reads and edits them on the review page. The building agent sees their count and titles. The gate refuses Read, Grep and Glob on the sealed folder, and any Bash naming it, and logs every attempt to the plan's access log, which the judge's verdict and the page show
