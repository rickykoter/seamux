# 0113. seamux workspace-open takes --command, the exact command its new session runs, in place of Claude

Date: 2026-11-22

## Status

Accepted

## Context

(context not recorded)

## Decision

You chose this so crew-worktree opens a sandboxed worktree as a workspace on either backend. workspace-open already finds the backend and records the workspace; only the command it runs was fixed to Claude.

## Consequences

--command cannot be combined with --prompt, --remote or --no-remote, because those shape the Claude command it replaces; workspace-open refuses the mix with exit 2. Without --command nothing changes for deep-plan's family open or the board's sync chip.
