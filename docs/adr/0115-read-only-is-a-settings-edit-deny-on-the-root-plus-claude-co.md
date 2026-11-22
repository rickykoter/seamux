# 0115. Read-only is a --settings Edit deny on the root plus Claude Code's own sandbox refusing Bash writes there

Date: 2026-11-22

## Status

Accepted

## Context

Claude Code merges the user's allow rules into every session, so a Bash allow could write under ~/code. Its docs say a deny at any level beats an allow at every other, and that sandbox.filesystem.denyWrite is enforced by Seatbelt on Bash commands.

## Decision

A deny passed with --settings can't be overridden by the person's own allow rules, and the macOS sandbox stops every Bash write under the root, including subprocesses a command parser would miss.

## Consequences

The Bosun can't run commands that write in a repo (npm install, a build, git fetch into a checkout). Its only writes are its own folder, ~/.claude/crew/bosun, and dispatch: `seamux bosun dispatch` is the one command the settings exclude from the sandbox, and an ask rule makes the person approve every run, even in auto mode. The sandbox's unsandboxed retry is off, because in auto mode a classifier, not the person, would approve a rerun. CLIs that need network or a cache folder are allowed through bosun.json's sandbox lists. MCP servers run outside the sandbox and are unaffected. The sandbox also refuses the registry's lock and write-back, so a seamux command the Bosun runs must read workspaces with TmuxBackend::registry(), never the locking workspaces() or panes() lists. The Bosun's folder is also one of its working directories, so it can feed a drafted file to answer or log add.
