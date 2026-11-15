# 0100. The app starts a landing for every merged PR a workspace made, and deep-plan reads its result

Date: 2026-11-15

## Status

Accepted

## Context

(context not recorded)

## Decision

landing is about what merged, planned or not; the app already watches each workspace's PRs through crew-sync

## Consequences

an ad hoc PR lands like a planned one; a plan's after-merge checks can cite a landing instead of steps done by hand; nothing lands while the app is closed, and a merge from the last day lands when it starts
