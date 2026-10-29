# 0042. Browser checks get a Playwright driver beside cmux's repl

Date: 2026-10-29

## Status

Accepted

## Context

a desktop or terminal session without cmux has no browser repl. The script contract (env, step, expect, STORAGE_STATE) is Playwright-shaped already, so a Node prelude can keep it word for word.

## Decision

Browser checks get a Playwright driver beside cmux's repl

## Consequences

Supersedes ADR 0034's 'only where cmux runs'. cmux keeps its repl. Elsewhere the engine runs the same script through Playwright and headless Chromium when `npx playwright` resolves, writing the same evidence layout (progress.jsonl, frame-NNNN.png, key-NN.png, trace.jsonl). run.png is optional. Without Playwright the check reports needs-variant and names the manual fallback.
