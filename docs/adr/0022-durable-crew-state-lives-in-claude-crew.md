# 0022. Durable crew state lives in ~/.claude/crew/

Date: 2026-10-18

## Status

Accepted

## Context

The log exists to outlast what it points at, so it cannot sit in ~/.cache/cmux-crew beside state whose loss costs only labels. ~/.claude/deep-plan and ~/.claude/lookout already keep this house's durable engine state there, and Claude Code's cleanup targets transcripts, not sibling directories.

## Decision

Durable crew state lives in ~/.claude/crew/

## Consequences

artifacts.db and kept/ live in ~/.claude/crew/; rebuildable caches (crew-resume's transcript index, sweep judgments, board-targets) stay in ~/.cache/cmux-crew. workspace-archive-sweep's archive.json belongs here too and moves by an amendment to that plan. The human chose this over ~/.local/share/seamux and ~/Library/Application Support/seamux.
