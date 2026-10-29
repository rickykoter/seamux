# 0039. Each plugin serves its own pages from a Node server started on demand

Date: 2026-10-29

## Status

Accepted

## Context

the plugins must work where crew is not installed, and a server nobody has to remember to start is the only kind that works in every host. Any verb that needs a live page starts it detached when nothing answers on the recorded port, and it exits after 30 idle minutes.

## Decision

Each plugin serves its own pages from a Node server started on demand

## Consequences

deep-plan and lookout each gain a `serve` verb and a ~/.claude/<plugin>/serve.json (mode 0600: port, token, pid, version). A dead server costs one restart on the next verb. crew's intent server stops being the only way a page goes live. Each server carries over the same Host, Origin and token guards as crew's.
