# 0099. The Lookout tab is a lifecycle rail per change: Review, PR, Merge, Land

Date: 2026-11-15

## Status

Accepted

## Context

(context not recorded)

## Decision

the tab already follows a review's PR (threads, checks, the PR strip); carrying it through merge and landing makes it the one place a change is driven from review to release

## Consequences

the selected change's header is a rail of four stages, each with its state, and a click shows that stage's panel in the main pane; side-list rows wear their stage; a workspace's PRs with no review get rows of their own; the Wake's merged PR row keeps only a status chip that opens Lookout at Land; Merge is read-only
