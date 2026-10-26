# 0035. Claim is an engine-run acquisition step: polled, optionally asked, locked and released

Date: 2026-10-26

## Status

Accepted

## Context

ADR 0009 made acquire steps the human's because they act off the machine. Automated acquisition, which a person can still be asked to finish, needs its own step so that rule can stand for acquire.

## Decision

Claim is an engine-run acquisition step: polled, optionally asked, locked and released

## Consequences

Supersedes 0009 in part: a recipe may now acquire unattended, through a claim the developer wrote, and that claim may act off the machine (post to a bot, claim an environment). What a claim does (a Slack bot, a port, a lab device) is each repo's own config; the engine only polls, asks, locks and releases. Acquire steps are unchanged and still the human's. The runner traps SIGTERM, SIGINT and SIGHUP and runs release before it exits. Only a SIGKILL or a crash leaves a claim held: the engine records it with its release command, and `check status` and the Dock name it until someone releases it. Locks are local files, so they serialize runs on one machine only.
