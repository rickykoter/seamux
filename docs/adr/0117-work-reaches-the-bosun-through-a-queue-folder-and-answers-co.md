# 0117. Work reaches the Bosun through a queue folder, and answers come back as files

Date: 2026-11-22

## Status

Accepted

## Context

Ask-the-Bosun and loops both need to put a prompt in front of a session they didn't start, and the asker needs the reply back as text.

## Decision

Any process can write a file, so a workspace session, a loop or the app can all hand it work, and the asker just waits for its answer file. Nothing relies on Claude Code's messaging between sessions.

## Consequences

queue/ holds one JSON file per item and the supervisor types them oldest first, one per idle turn. answers/<id>.md is written only by `seamux bosun answer`. log/<day>.jsonl is written only by `seamux bosun log add`, and the app's rail reads it.
