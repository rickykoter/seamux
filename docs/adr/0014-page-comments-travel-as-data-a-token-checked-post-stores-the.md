# 0014. Page comments travel as data: a token-checked POST stores them and a prompt hook delivers them

Date: 2026-10-09

## Status

Accepted

## Context

ADR 0003 limits a page's effect on a session to typing a verified option number, and the server has no POST route today (crew/board/crew-board-intent:769). Free text must not be typed into a terminal. Family news already proves the pull model: a UserPromptSubmit hook hands context to the session at its next prompt (deep-plan/hooks/news.mjs:1-4).

## Decision

Page comments travel as data: a token-checked POST stores them and a prompt hook delivers them

## Consequences

The intent server gains its first POST route, /review/<id>: token-checked, JSON-only, size-capped, writing only the review store under ~/.claude/plans/reviews; nothing is typed into a terminal, so an idle agent sees comments at your next prompt; the agent replies through `lookout reply`, and the page polls the store; ADR 0003's rule stands unchanged.
