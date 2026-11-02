# 0064. Intake writes a seed, the agent drafts the spec

Date: 2026-11-02

## Status

Accepted

## Context

Fetching an issue or a failed run is mechanical and testable; turning it into a plan is judgement that belongs to the skill's discipline

## Decision

Intake writes a seed, the agent drafts the spec

## Consequences

`deep-plan intake <link>` reads a GitHub issue, PR or Actions run through gh, or a Jira key through acli, and writes <data root>/deep-plan/intake/<id>.md and .json: title, body, the failing jobs with a log tail, test names it can find, and the link. It never renders a spec. The skill's bug lane drafts a short auto-go plan from the seed whose first check is the repro test.
