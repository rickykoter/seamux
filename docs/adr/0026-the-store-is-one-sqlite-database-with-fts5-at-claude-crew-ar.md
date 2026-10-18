# 0026. The store is one SQLite database with FTS5 at ~/.claude/crew/artifacts.db

Date: 2026-10-18

## Status

Accepted

## Context

Search is the point of the page, and stdlib sqlite3 brings full-text search with no dependency: both the Homebrew python3 and /usr/bin/python3 on this machine create FTS5 tables. One file serves every workspace, so a cross-workspace query is a WHERE clause, not a scan of N files.

## Decision

The store is one SQLite database with FTS5 at ~/.claude/crew/artifacts.db

## Consequences

The first SQLite store in this repo, where JSON files are the norm. artifacts.py is its only writer; the intent server and crew-artifacts read through it. Writes take BEGIN IMMEDIATE with a busy timeout, so concurrent Stop hooks queue instead of failing. The code stays Python 3.9 compatible for /usr/bin/python3. The human chose it over JSONL per workspace.
