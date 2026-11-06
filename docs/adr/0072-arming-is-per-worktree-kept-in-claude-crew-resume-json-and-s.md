# 0072. Arming is per worktree, kept in ~/.claude/crew/resume.json, and stays until you disarm it

Date: 2026-11-06

## Status

Accepted

## Context

(context not recorded)

## Decision

the person arms a worktree, not a session id they never see; a worktree that hits the 5-hour limit twice overnight should resume twice, and ADR 0024 puts durable crew state under ~/.claude/crew

## Consequences

resume.json has tucked.json's shape (version, entries of path, at, name) and the app is its only writer. The board reads it to draw the 'resumes 3:04pm' chip. An armed worktree resumes every limit stop until you click the chip or the menu item.
