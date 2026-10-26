# 0034. Browser checks run a repo script through cmux browser repl, as a final `browser` recipe step

Date: 2026-10-26

## Status

Accepted

## Context

Checks that only a driven browser can prove had no home: a shell recipe or a free-text manual note. The person wants them replayable, run in the cmux browser, and visible on the Dock.

## Decision

Browser checks run a repo script through cmux browser repl, as a final `browser` recipe step

## Consequences

Browser checks run only where cmux runs (a desktop session, not CI). A recipe's last step may be `{ "browser": "<repo path>.js" }`, and `kind: "browser"` marks it for the surfaces. The script is repo code: the developer reviews and commits it, it is replayable by later plans through `match` + `default`, and editing it makes a pass stale through the tree hash. Engine-provided globals (`step`, `expect`) and the STORAGE_STATE handoff are a contract script authors depend on.
