# 0023. Jev ranks sweep candidates only, through the one TypeSafe client, cached per transcript

Date: 2026-10-17

## Status

Accepted

## Context

A finder that calls the network per keystroke would freeze on the client's 10s timeout. The sweep is a once-a-day moment where a few seconds of judging buys a better order, and judgments.py already shows the cache-and-degrade shape. Going through crew/hooks/typesafe.py keeps Kev, a local Jev reached by overriding the TypeSafe config, working with no extra code.

## Decision

Jev ranks sweep candidates only, through the one TypeSafe client, cached per transcript

## Consequences

The human picked sweep-only: search stays deterministic, a fuzzy score then state then recency. crew-sweep asks two System One questions per candidate (finished, abandoned) over Claude's last message, the last prompt, the workspace title and structured facts, and the human accepted sending the prompt and title. Answers are cached in ~/.cache/cmux-crew/sweep-judgments.json, keyed by cwd and transcript size. With TypeSafe off or failing, cards are ordered merged first, then by idle days, and nothing else changes.
