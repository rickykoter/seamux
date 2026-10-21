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

## Amended at the seamux-inversion cutover (2026-10-21)

The store is unchanged: the same file, schema and FTS5 index (the family's
"store schema unchanged" decision). Its writer is no longer artifacts.py. The
Rust crate `app/crates/crew-store`, run as `seamux crew-artifacts`, is now the
only writer, and the intent server and the Wake read through it. It keeps
artifacts.py's discipline: WAL, a busy timeout, BEGIN IMMEDIATE, and the same
index lock. artifacts_probe proved both implementations against one database
before the switch. The Python 3.9 constraint no longer applies.
