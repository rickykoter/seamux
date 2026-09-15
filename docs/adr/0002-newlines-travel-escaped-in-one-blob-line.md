# 0002. Newlines travel escaped in one blob line

Date: 2026-09-15

## Status

Accepted

## Context

the blob is a line-based format (- [section] text); an edited field's real newlines are escaped as \n so each edit stays one parseable line, and SKILL.md tells the agent to unescape before applying

## Decision

Newlines travel escaped in one blob line

## Consequences

the paste-back blob is now a versioned line protocol: every surface that stages multi-line content must serialize it \n-escaped onto one '- [section] payload' line, any future programmatic consumer must unescape before use, and changing the line shape breaks pasted blobs silently — so additions extend the section vocabulary, never the line grammar
