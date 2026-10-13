# 0021. The board allows ambient motion; reduced-motion still stops all of it

Date: 2026-10-13

## Status

Accepted

## Context

The board inherited whimsy's principle that it 'costs nothing when nothing is happening': a quiet board was perfectly still. The human wants a time-of-day sky on the shelf and a napping cat that occasionally blinks or flicks its tail.

## Decision

The board allows ambient motion; reduced-motion still stops all of it

## Consequences

A quiet board is no longer still: the shelf's sky changes with the local hour, and the napping cat moves on a long, irregular cycle. Event-bound motion keeps its one-shot rules. prefers-reduced-motion stops ambient and event motion alike, and the probe asserts the reduced-motion block names every new animation.

As built, the probe holds every animation on the page to that, not only the new ones, with one exception: the reply window's draining bar, which tells you how long is left to answer rather than decorating anything. Stopped, each of the cat's moods holds its first frame.
