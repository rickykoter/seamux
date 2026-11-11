# 0091. The workflow returns the merged review, and the caller says who ingests it

Date: 2026-11-11

## Status

Accepted

## Context

(context not recorded)

## Decision

Claude Code refuses JSON inside a Bash command and the app's reviewer has no Write tool, so in a session a final agent in the workflow writes the file and runs findings add, and in the app the run replies with the JSON and the app ingests it as today

## Consequences

review.js takes ingest agent or reply; a session's run ends with an ingest agent that is also fresh; the app keeps its own ingest and repair loop
