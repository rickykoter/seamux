# 0012. A child learns of family changes by pulling them at its next prompt: a UserPromptSubmit and SessionStart hook injects factual news, and nothing is ever typed into a session

Date: 2026-10-08

## Status

Accepted

## Context

Children must stay current with siblings and the parent without a person relaying each change, and without widening ADR 0003's keystroke rule.

## Decision

A child learns of family changes by pulling them at its next prompt: a UserPromptSubmit and SessionStart hook injects factual news, and nothing is ever typed into a session

## Consequences

An idle child hears nothing until its next prompt or session start; that delay is accepted. News is as fresh as the last local fetch of the base ref, so restack (which fetches) remains the way a child actually catches up. Push delivery over cross-session messaging is left to a future orchestrator agent, which would read the same index and cursor rather than a second news source.
