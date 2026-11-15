# 0105. A landing's state is one JSON file per merge under ~/.claude/crew/landings

Date: 2026-11-15

## Status

Accepted

## Context

(context not recorded)

## Decision

crew's durable state lives there (ADR 0024) and outlives the cache; one file per merge is what the Wake, the Dock and deep-plan read

## Consequences

the Wake, the Dock, the app's watcher and deep-plan's after-merge checks read one file per merge; deep-plan land run is its only writer, with a whole-file write; files are kept, and nothing prunes them in this plan
