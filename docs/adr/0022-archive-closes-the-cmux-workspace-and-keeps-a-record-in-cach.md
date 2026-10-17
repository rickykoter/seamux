# 0022. Archive closes the cmux workspace and keeps a record in ~/.cache/cmux-crew/archive.json

Date: 2026-10-17

## Status

Accepted

## Context

crew needed a way to put a workspace away that is neither closing it for good nor reclaiming its worktree. cmux has collapsible workspace groups and agent hibernation, but no archive. The finder, the sweep and the board chip all have to agree on what an archived workspace is.

## Decision

Archive closes the cmux workspace and keeps a record in ~/.cache/cmux-crew/archive.json

## Consequences

Archive means close and remember: the human chose it over a collapsed Archive group and over doing both by age. An archived workspace is gone from cmux and the board; only crew-resume and crew-sweep see it, through crew/hooks/workspaces.py, the one reader and writer of archive.json. Restore opens a new workspace at the cwd with the archived title and color, running `claude --resume <session_id>`. Deleting the cache only demotes archived rows to past.
