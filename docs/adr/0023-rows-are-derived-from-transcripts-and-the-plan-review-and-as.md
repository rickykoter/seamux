# 0023. Rows are derived from transcripts and the plan, review and ask stores, not captured by a tool hook

Date: 2026-10-18

## Status

Accepted

## Context

Transcripts already record every Write, every Artifact publish with its URL, and every commit, with cwd, session, branch and timestamp on each line, so the log can be built after the fact and backfilled. A PostToolUse hook would sit on the hot path, never see a file made by a Bash heredoc, and could not backfill.

## Decision

Rows are derived from transcripts and the plan, review and ask stores, not captured by a tool hook

## Consequences

The crew Stop hook spawns a detached index run that rescans every transcript whose size or mtime changed, from its stored offset, so sessions outside cmux land at the next cmux Stop. `crew-artifacts backfill` indexes everything once. History older than the oldest surviving transcript is not recoverable. The human chose this over a live hook and over both.
